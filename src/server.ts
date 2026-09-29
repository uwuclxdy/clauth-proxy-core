import { Hono } from "hono";
import { timingSafeEqual } from "hono/utils/buffer";
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { CONTRACT_VERSION, hashKey, ID_RE, mintInferenceKey } from "./contract.ts";
import { FlowManager, type LoginStatusBody } from "./flows.ts";
import { errorClass, log } from "./log.ts";
import type { FullManifest } from "./manifest.ts";
import {
  ActionRequestSchema,
  ConfigPatchRequestSchema,
  LoginRequestSchema,
  PasteRequestSchema,
  SettingsPatchRequestSchema,
} from "./schemas.ts";
import { defaultSettings, validateSettings, type SettingsResult } from "./settings.ts";
import { AccountStore, toAdapterView, toPublic, type AccountPublic } from "./store.ts";
import { AdapterError, type ProxyAdapter } from "./types.ts";
import { UsageCache, type UsageAccount } from "./usage.ts";

export type EventName = "account" | "usage" | "login" | "account_deleted";

export class EventBus {
  private listeners = new Set<(name: EventName, data: unknown) => void>();

  publish(name: EventName, data: unknown): void {
    for (const listener of this.listeners) listener(name, data);
  }

  subscribe(listener: (name: EventName, data: unknown) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }
}

async function tokensEqual(a: string, b: string): Promise<boolean> {
  const ab = new TextEncoder().encode(a);
  const bb = new TextEncoder().encode(b);
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

function controlError(
  status: number,
  error: string,
  reason?: string,
  field?: string,
): Response {
  const body: Record<string, unknown> = { ok: false, error };
  if (reason !== undefined) body.reason = reason;
  if (field !== undefined) body.field = field;
  const headers = new Headers({ "content-type": "application/json" });
  if (status === 401) headers.set("www-authenticate", "Bearer");
  return new Response(JSON.stringify(body), { status, headers });
}

const INFERENCE_MESSAGES: Record<string, string> = {
  authentication_error: "invalid or missing api key",
  permission_error: "the account is suspended",
  not_found_error: "unknown endpoint",
  invalid_request_error: "malformed request",
  request_too_large: "request too large",
  rate_limit_error: "rate limited by the upstream provider",
  overloaded_error: "the proxy is overloaded",
  api_error: "the upstream provider failed",
};

function inferenceError(status: number, type: string, message?: string, retryAfter?: number): Response {
  const headers = new Headers({ "content-type": "application/json" });
  if (retryAfter !== undefined) headers.set("retry-after", String(retryAfter));
  return new Response(
    JSON.stringify({ type: "error", error: { type, message: message ?? INFERENCE_MESSAGES[type] ?? type } }),
    { status, headers },
  );
}

/** The inference request body cap, named in the skill. */
const INFERENCE_BODY_CAP = 32 * 1024 * 1024;

/** Headers a proxy never forwards upstream: the client's auth, the loopback host, and hop-by-hop headers. */
const STRIPPED_REQUEST_HEADERS = new Set([
  "authorization",
  "x-api-key",
  "host",
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
  "content-length",
]);

const STRIPPED_RESPONSE_HEADERS = new Set([
  "connection",
  "keep-alive",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
  // an upstream session cookie is upstream state, never the client's
  "set-cookie",
  // the adapter returns a decoded body, so an upstream encoding/length label is a lie
  "content-encoding",
  "content-length",
]);

/** A request rebuilt without the client's auth, host and hop-by-hop headers, carrying the pre-read body. */
function rebuildForwardRequest(raw: Request, bodyText: string): Request {
  const headers = new Headers();
  for (const [name, value] of raw.headers) {
    if (STRIPPED_REQUEST_HEADERS.has(name.toLowerCase())) continue;
    headers.append(name, value);
  }
  return new Request(raw.url, { method: raw.method, headers, body: bodyText });
}

/** A forwarded response rebuilt without CORS, hop-by-hop, `proxy-*` or upstream-only headers; the body stream passes through. */
function stripResponseHeaders(res: Response): Response {
  const headers = new Headers();
  for (const [name, value] of res.headers) {
    const lower = name.toLowerCase();
    if (lower.startsWith("access-control-") || lower.startsWith("proxy-") || STRIPPED_RESPONSE_HEADERS.has(lower)) {
      continue;
    }
    headers.append(name, value);
  }
  return new Response(res.body, { status: res.status, statusText: res.statusText, headers });
}

class SettingsValidationError extends Error {
  constructor(readonly result: Extract<SettingsResult, { ok: false }>) {
    super(result.error);
  }
}

function isAnthropicError(value: unknown): boolean {
  if (typeof value !== "object" || value === null) return false;
  const obj = value as Record<string, unknown>;
  if (obj.type !== "error") return false;
  const error = obj.error;
  return (
    typeof error === "object" &&
    error !== null &&
    typeof (error as Record<string, unknown>).type === "string" &&
    typeof (error as Record<string, unknown>).message === "string"
  );
}

function mapStatusToErrorType(status: number): string {
  switch (status) {
    case 400:
      return "invalid_request_error";
    case 401:
      return "authentication_error";
    case 403:
      return "permission_error";
    case 404:
      return "not_found_error";
    case 413:
      return "request_too_large";
    case 429:
      return "rate_limit_error";
    case 529:
      return "overloaded_error";
    default:
      return "api_error";
  }
}

const RATE_LIMIT_HEADERS = [
  "retry-after",
  "anthropic-ratelimit-requests-limit",
  "anthropic-ratelimit-requests-remaining",
  "anthropic-ratelimit-requests-reset",
  "anthropic-ratelimit-tokens-limit",
  "anthropic-ratelimit-tokens-remaining",
  "anthropic-ratelimit-tokens-reset",
];

/**
 * Normalize a non-2xx upstream response to Anthropic's full error envelope. An
 * already-shaped body passes through untouched; any other body is wrapped with a
 * proxy-written message. A 429 keeps its rate-limit headers.
 */
export async function normalizeInferenceResponse(res: Response): Promise<Response> {
  if (res.status < 400) return stripResponseHeaders(res);
  const text = await res.text().catch(() => "");
  const parsed: unknown = (() => {
    try {
      return JSON.parse(text);
    } catch {
      return null;
    }
  })();
  if (isAnthropicError(parsed)) {
    return stripResponseHeaders(new Response(text, { status: res.status, headers: res.headers }));
  }
  const type = mapStatusToErrorType(res.status);
  const headers = new Headers({ "content-type": "application/json" });
  if (res.status === 429) {
    for (const name of RATE_LIMIT_HEADERS) {
      const value = res.headers.get(name);
      if (value !== null) headers.set(name, value);
    }
  }
  return new Response(
    JSON.stringify({ type: "error", error: { type, message: INFERENCE_MESSAGES[type] ?? type } }),
    { status: res.status, headers },
  );
}

class ConfigStore {
  constructor(private readonly file: string) {}

  read(): Record<string, unknown> {
    if (!existsSync(this.file)) return {};
    try {
      const parsed = JSON.parse(readFileSync(this.file, "utf8")) as { values?: unknown };
      if (parsed !== null && typeof parsed === "object" && parsed.values !== null && typeof parsed.values === "object") {
        return parsed.values as Record<string, unknown>;
      }
    } catch {
      // a torn config file reads as empty
    }
    return {};
  }

  write(values: Record<string, unknown>): void {
    const tmp = `${this.file}.tmp`;
    writeFileSync(tmp, JSON.stringify({ values }, null, 2), { mode: 0o600 });
    renameSync(tmp, this.file);
  }
}

type JsonBody<T> = { ok: true; value: T } | { ok: false; error: "payload_too_large" | "bad_request" };

async function readJson<T>(c: { req: { text(): Promise<string> } }, schema: z.ZodType<T>): Promise<JsonBody<T>> {
  const text = await c.req.text().catch(() => null);
  if (text === null) return { ok: false, error: "bad_request" };
  if (Buffer.byteLength(text) > 4096) return { ok: false, error: "payload_too_large" };
  let json: unknown;
  try {
    // an empty body reads as `{}`, so an all-optional request (a login) works
    json = JSON.parse(text.trim() === "" ? "{}" : text);
  } catch {
    return { ok: false, error: "bad_request" };
  }
  const parsed = schema.safeParse(json);
  if (!parsed.success) return { ok: false, error: "bad_request" };
  return { ok: true, value: parsed.data };
}

export interface BuiltServer {
  app: Hono;
  flows: FlowManager;
  usage: UsageCache;
  events: EventBus;
  close(): void;
}

export interface BuildServerDeps {
  adapter: ProxyAdapter;
  manifest: FullManifest;
  store: AccountStore;
  adminToken: string;
  stateDir: string;
}

function matchesPath(path: string, pattern: string): boolean {
  const re = new RegExp("^" + pattern.split("/").map((seg) => (seg.startsWith(":") ? "[^/]+" : seg)).join("/") + "$");
  return re.test(path);
}

export function buildServer(deps: BuildServerDeps): BuiltServer {
  const { adapter, manifest, store, adminToken, stateDir } = deps;
  const events = new EventBus();
  const sseControllers = new Set<ReadableStreamDefaultController<Uint8Array>>();
  const inFlightActions = new Set<string>();

  const config = new ConfigStore(join(stateDir, "config.json"));

  const publishAccount = (account: AccountPublic): void => {
    events.publish("account", account);
  };

  const flows = new FlowManager(adapter, manifest, store, (status: LoginStatusBody) => {
    events.publish("login", status);
  }, publishAccount);
  const usage = new UsageCache(adapter, manifest, store, (account: UsageAccount) => {
    events.publish("usage", account);
  }, publishAccount);

  const app = new Hono();

  const requireAdmin = async (c: { req: { header(name: string): string | undefined } }, next: () => Promise<void>) => {
    const auth = c.req.header("authorization");
    const token = auth !== undefined && auth.startsWith("Bearer ") ? auth.slice("Bearer ".length) : "";
    if (token === "" || !(await tokensEqual(token, adminToken))) {
      return controlError(401, "unauthorized");
    }
    await next();
  };

  /**
   * Validate a path id at the router, before any store or adapter call. A value
   * outside the contract's id form reads as an unknown route: 404 `not_found`.
   */
  function idParam(c: { req: { param(name: string): string } }, name: string): string | null {
    const value = c.req.param(name);
    return ID_RE.test(value) ? value : null;
  }

  // ---- no-auth ----

  app.get("/health", (c) => {
    return c.json({
      status: "ok",
      service: manifest.service,
      version: manifest.version,
      contract: CONTRACT_VERSION,
    });
  });

  // ---- control ----

  app.use("/clauth/v1/*", requireAdmin);

  // An uncaught throw answers the route's own envelope, never Hono's plain text,
  // and logs only the route and the error class (upstream bytes stay off the log).
  app.onError((err, c) => {
    const path = new URL(c.req.url).pathname;
    log.error(`route ${path}: ${errorClass(err)}`);
    if (path.startsWith("/clauth/v1")) return controlError(500, "internal");
    if (path.startsWith("/v1/")) return inferenceError(500, "api_error");
    return new Response("Internal Server Error", { status: 500 });
  });

  app.get("/clauth/v1/info", (c) => {
    return c.json({
      service: manifest.service,
      version: manifest.version,
      contract: CONTRACT_VERSION,
      capabilities: manifest.capabilities,
      actions: manifest.actions,
      figures: manifest.figures,
      settings: manifest.settings,
    });
  });

  app.get("/clauth/v1/accounts", (c) => {
    return c.json({ accounts: store.list().map(toPublic) });
  });

  app.post("/clauth/v1/accounts/login", async (c) => {
    const body = await readJson(c, LoginRequestSchema);
    if (!body.ok) {
      if (body.error === "payload_too_large") return controlError(413, "payload_too_large");
      return controlError(400, "bad_request");
    }
    const accountId = body.value.account ?? null;
    const result = await flows.start(accountId);
    if (!result.ok) return controlError(result.status, result.error);
    return c.json(result.value, 201);
  });

  app.get("/clauth/v1/accounts/login/:flow", (c) => {
    const flowId = idParam(c, "flow");
    if (flowId === null) return controlError(404, "not_found");
    const status = flows.get(flowId);
    if (status === null) return controlError(404, "not_found");
    return c.json(status);
  });

  app.post("/clauth/v1/accounts/login/:flow", async (c) => {
    const flowId = idParam(c, "flow");
    if (flowId === null) return controlError(404, "not_found");
    const body = await readJson(c, PasteRequestSchema);
    if (!body.ok) {
      if (body.error === "payload_too_large") return controlError(413, "payload_too_large");
      return controlError(400, "bad_request");
    }
    const result = await flows.paste(flowId, body.value.code);
    if (!result.ok) return controlError(result.status, result.error);
    return c.json(result.value);
  });

  app.delete("/clauth/v1/accounts/login/:flow", async (c) => {
    const flowId = idParam(c, "flow");
    if (flowId === null) return controlError(404, "not_found");
    const existed = await flows.cancel(flowId);
    if (!existed) return controlError(404, "not_found");
    return c.body(null, 204);
  });

  app.patch("/clauth/v1/accounts/:id", async (c) => {
    const id = idParam(c, "id");
    if (id === null) return controlError(404, "not_found");
    const body = await readJson(c, SettingsPatchRequestSchema);
    if (!body.ok) {
      if (body.error === "payload_too_large") return controlError(413, "payload_too_large");
      return controlError(400, "bad_request");
    }
    try {
      const updated = await store.patch(id, (account) => {
        const result = validateSettings(manifest.settings, "account", body.value.settings, account.settings);
        if (!result.ok) throw new SettingsValidationError(result);
        account.settings = result.merged;
      });
      if (updated === null) return controlError(404, "not_found");
      publishAccount(toPublic(updated));
      return c.json(toPublic(updated));
    } catch (err) {
      if (err instanceof SettingsValidationError) {
        return controlError(422, err.result.error, err.result.reason, err.result.field);
      }
      throw err;
    }
  });

  app.delete("/clauth/v1/accounts/:id", async (c) => {
    const id = idParam(c, "id");
    if (id === null) return controlError(404, "not_found");
    const account = store.get(id);
    if (account === null) return controlError(404, "not_found");
    if (flows.hasPendingForAccount(id)) return controlError(409, "conflict");
    store.delete(id);
    // the delete also drops the account's cached figures, so nothing re-publishes it
    usage.drop(id);
    // a deletion is its own event, never an `account` event carrying a dead object
    events.publish("account_deleted", { id: account.id });
    try {
      await adapter.dropLogin({ accountId: id, account: toAdapterView(account), upstream: account.blob });
    } catch (err) {
      // the local record still drops, but a failed drop orphans the upstream login
      log.error(`account ${id}: dropLogin failed (${errorClass(err)})`);
    }
    return c.body(null, 204);
  });

  app.post("/clauth/v1/accounts/:id/key", async (c) => {
    const id = idParam(c, "id");
    if (id === null) return controlError(404, "not_found");
    const key = mintInferenceKey();
    const updated = await store.patch(id, (account) => {
      account.key_hash = hashKey(key);
    });
    if (updated === null) return controlError(404, "not_found");
    publishAccount(toPublic(updated));
    return c.json({ inference_key: key });
  });

  app.post("/clauth/v1/accounts/:id/actions/:name", async (c) => {
    const id = idParam(c, "id");
    if (id === null) return controlError(404, "not_found");
    const name = idParam(c, "name");
    if (name === null) return controlError(404, "not_found");
    const account = store.get(id);
    if (account === null) return controlError(404, "not_found");
    const action = manifest.actions.find((a) => a.name === name);
    if (action === undefined) return controlError(404, "not_found");
    if (account.state !== "ready") return controlError(409, "login_required");

    const body = await readJson(c, ActionRequestSchema);
    if (!body.ok) {
      if (body.error === "payload_too_large") return controlError(413, "payload_too_large");
      return controlError(400, "bad_request");
    }
    const target = body.value.target ?? null;
    if (action.target === null || action.target === undefined) {
      if (target !== null) return controlError(422, "invalid_target", "this action takes no target", "target");
    } else {
      if (target === null) return controlError(422, "invalid_target", "this action requires a target", "target");
    }

    const inflightKey = `${id}\u0000${name}`;
    if (inFlightActions.has(inflightKey)) return controlError(409, "conflict");
    inFlightActions.add(inflightKey);
    // 202 at once; the outcome rides the figure (a state flip flips the account
    // via the usage poll, so no HTTP error needs to travel back after the fact)
    const usedLoginGen = account.login_gen ?? 0;
    void (async () => {
      try {
        await adapter.runAction({
          accountId: id,
          account: toAdapterView(account),
          action: name,
          target,
        });
      } catch (err) {
        if (err instanceof AdapterError && (err.reason === "login_required" || err.reason === "suspended")) {
          await flipAccountState(id, err.reason, usedLoginGen);
        }
        log.error(`action ${name} on ${id} failed (${errorClass(err)})`);
      } finally {
        inFlightActions.delete(inflightKey);
      }
    })();
    return c.json({ accepted: true }, 202);
  });

  app.get("/clauth/v1/usage", (c) => {
    const accountParam = c.req.query("account");
    if (accountParam !== undefined) {
      if (!ID_RE.test(accountParam)) return controlError(404, "not_found");
      const payload = usage.payload(accountParam);
      if (payload === null) return controlError(404, "not_found");
      return c.json({ accounts: [payload] });
    }
    return c.json({ accounts: usage.all() });
  });

  app.get("/clauth/v1/config", (c) => {
    const values = configValues();
    const etag = configEtag(values);
    return c.json({ values }, 200, { ETag: `"${etag}"` });
  });

  app.patch("/clauth/v1/config", async (c) => {
    const current = configValues();
    const ifMatch = c.req.header("if-match");
    if (ifMatch !== undefined && ifMatch !== `"${configEtag(current)}"`) {
      return controlError(412, "precondition_failed");
    }
    const body = await readJson(c, ConfigPatchRequestSchema);
    if (!body.ok) {
      if (body.error === "payload_too_large") return controlError(413, "payload_too_large");
      return controlError(400, "bad_request");
    }
    const result = validateSettings(manifest.settings, "proxy", body.value.values, current);
    if (!result.ok) return controlError(422, result.error, result.reason, result.field);
    config.write(result.merged);
    return c.json({ values: result.merged, restart_required: result.restartRequired });
  });

  if (manifest.hasEvents) {
    app.get("/clauth/v1/events", (c) => {
      return sse(events, sseControllers);
    });
  }

  function configValues(): Record<string, unknown> {
    return { ...defaultSettings(manifest.settings, "proxy"), ...config.read() };
  }

  function configEtag(values: Record<string, unknown>): string {
    return Bun.SHA256.hash(JSON.stringify(values), "hex");
  }

  // ---- inference ----

  async function forward(c: { req: { header(name: string): string | undefined; raw: Request } }, route: "messages" | "count_tokens") {
    const apiKey = c.req.header("x-api-key");
    const auth = c.req.header("authorization");
    const bearer = auth !== undefined && auth.startsWith("Bearer ") ? auth.slice("Bearer ".length) : null;
    if (apiKey !== undefined && bearer !== null && apiKey !== bearer) {
      return inferenceError(401, "authentication_error");
    }
    const key = apiKey ?? bearer ?? null;
    if (key === null) return inferenceError(401, "authentication_error");
    if (await tokensEqual(key, adminToken)) return inferenceError(401, "authentication_error");

    const account = store.findByKeyHash(hashKey(key));
    if (account === null) return inferenceError(401, "authentication_error");
    if (account.state === "login_required") return inferenceError(401, "authentication_error");
    if (account.state === "suspended") return inferenceError(403, "permission_error");

    // read the body once to bound it and reject a malformed one before the adapter
    const bodyText = await c.req.raw.text().catch(() => null);
    if (bodyText === null) return inferenceError(400, "invalid_request_error");
    if (Buffer.byteLength(bodyText) > INFERENCE_BODY_CAP) return inferenceError(413, "request_too_large");
    try {
      JSON.parse(bodyText);
    } catch {
      return inferenceError(400, "invalid_request_error");
    }

    try {
      const res = await adapter.forward({
        accountId: account.id,
        account: toAdapterView(account),
        request: rebuildForwardRequest(c.req.raw, bodyText),
        route,
      });
      return await normalizeInferenceResponse(res);
    } catch (err) {
      if (err instanceof AdapterError) {
        if (err.reason === "login_required") {
          await flipAccountState(account.id, "login_required", account.login_gen ?? 0);
          return inferenceError(401, "authentication_error");
        }
        if (err.reason === "suspended") {
          await flipAccountState(account.id, "suspended", account.login_gen ?? 0);
          return inferenceError(403, "permission_error");
        }
        if (err.reason === "rate_limited") {
          return inferenceError(429, "rate_limit_error", undefined, err.retryAfter);
        }
      }
      return inferenceError(500, "api_error");
    }
  }

  /**
   * Flip the account state only when the failing call's login is still the account's
   * current one: a re-bind in between bumps `login_gen`, so a late failure on the old
   * credential is a no-op against the freshly re-bound account.
   */
  async function flipAccountState(id: string, state: "login_required" | "suspended", usedLoginGen: number): Promise<void> {
    try {
      let flipped = false;
      const updated = await store.patch(id, (current) => {
        if ((current.login_gen ?? 0) === usedLoginGen && current.state !== state) {
          current.state = state;
          flipped = true;
        }
      });
      if (updated !== null && flipped) publishAccount(toPublic(updated));
    } catch (err) {
      log.error(`account ${id}: state write failed (${errorClass(err)})`);
    }
  }

  app.post("/v1/messages", (c) => forward(c, "messages"));
  if (manifest.hasCountTokens) {
    app.post("/v1/messages/count_tokens", (c) => forward(c, "count_tokens"));
  }

  app.notFound((c) => {
    const path = new URL(c.req.url).pathname;
    if (path.startsWith("/clauth/v1")) {
      const registered = (app.routes as Array<{ method: string; path: string } | [string, string, unknown]>)
        .filter((r) => {
          const method = Array.isArray(r) ? r[0] : r.method;
          const p = Array.isArray(r) ? r[1] : r.path;
          return method !== "ALL" && p.startsWith("/clauth/v1");
        })
        .map((r) => (Array.isArray(r) ? r[1] : r.path));
      if (registered.some((pattern) => matchesPath(path, pattern))) {
        return controlError(405, "method_not_allowed");
      }
      if (!manifest.hasEvents && path === "/clauth/v1/events") {
        return controlError(501, "unsupported");
      }
      return controlError(404, "not_found");
    }
    if (path.startsWith("/v1/")) {
      return inferenceError(404, "not_found_error");
    }
    return new Response("not found", { status: 404 });
  });

  function sse(
    bus: EventBus,
    controllers: Set<ReadableStreamDefaultController<Uint8Array>>,
  ): Response {
    const encoder = new TextEncoder();
    let controllerRef: ReadableStreamDefaultController<Uint8Array> | undefined;
    let unsubscribe: (() => void) | undefined;
    let heartbeat: ReturnType<typeof setInterval> | undefined;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controllerRef = controller;
        controllers.add(controller);
        unsubscribe = bus.subscribe((name, data) => {
          try {
            controller.enqueue(encoder.encode(`event: ${name}\ndata: ${JSON.stringify(data)}\n\n`));
          } catch {
            // the client went away; the cancel path cleans up
          }
        });
        // Bun writes a streamed Response's header block without its terminating
        // blank line until the first body chunk, so a stream that never writes
        // leaves every client waiting on the head. This first comment flushes the
        // head at open.
        controller.enqueue(encoder.encode(": ok\n\n"));
        heartbeat = setInterval(() => {
          try {
            controller.enqueue(encoder.encode(": ping\n\n"));
          } catch {
            // ignore
          }
        }, 15_000);
      },
      cancel() {
        if (heartbeat !== undefined) clearInterval(heartbeat);
        if (unsubscribe !== undefined) unsubscribe();
        if (controllerRef !== undefined) controllers.delete(controllerRef);
      },
    });
    return new Response(body, {
      headers: { "content-type": "text/event-stream", "cache-control": "no-cache" },
    });
  }

  return {
    app,
    flows,
    usage,
    events,
    close() {
      flows.close();
      usage.close();
      for (const controller of sseControllers) {
        try {
          controller.close();
        } catch {
          // already closed
        }
      }
      sseControllers.clear();
    },
  };
}
