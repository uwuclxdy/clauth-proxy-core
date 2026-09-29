import { afterEach, describe, expect, test } from "bun:test";
import { AdapterError, CONTRACT_VERSION, hashKey, manifestJson, parseBind, validateFigure, validateManifest } from "../src/index.ts";
import { makeFakeAdapter } from "./fake-adapter.ts";
import { adminHeaders, cleanupTestDirs, makeTestServer, waitFor } from "./helpers.ts";

const servers: ReturnType<typeof makeTestServer>[] = [];

function ts(opts: Parameters<typeof makeTestServer>[0] = {}): ReturnType<typeof makeTestServer> {
  const s = makeTestServer(opts);
  servers.push(s);
  return s;
}

afterEach(() => {
  for (const s of servers) s.server.close();
  servers.length = 0;
  cleanupTestDirs();
});

function json(res: Response): Promise<unknown> {
  return res.json();
}

async function loginNewAccount(s: ReturnType<typeof makeTestServer>): Promise<{ id: string; key: string }> {
  const res = await s.app.request("/clauth/v1/accounts/login", {
    method: "POST",
    headers: adminHeaders(),
    body: JSON.stringify({}),
  });
  expect(res.status).toBe(201);
  const start = (await res.json()) as { flow: string; state: string; modes: string[] };
  expect(start.state).toBe("pending");
  expect(start.modes).toEqual(["poll"]);
  let done: { account: { id: string }; inference_key: string } | undefined;
  await waitFor(async () => {
    const r = await s.app.request(`/clauth/v1/accounts/login/${start.flow}`, { headers: adminHeaders() });
    const j = (await r.json()) as { state: string; account?: { id: string }; inference_key?: string };
    if (j.state === "done") {
      done = j as { account: { id: string }; inference_key: string };
      return true;
    }
    return false;
  });
  return { id: done!.account.id, key: done!.inference_key };
}

describe("bind", () => {
  test("parseBind accepts loopback hosts and refuses a non-loopback one, naming it", () => {
    expect(parseBind("127.0.0.1:8080")).toEqual({ hostname: "127.0.0.1", port: 8080 });
    expect(parseBind("localhost:0")).toEqual({ hostname: "localhost", port: 0 });
    expect(() => parseBind("0.0.0.0:8080")).toThrow("0.0.0.0");
    expect(() => parseBind("127.0.0.1")).toThrow("host:port");
  });
});

describe("manifest", () => {
  test("manifestJson is the adapter's fields plus the contract", () => {
    const m = validateManifest(makeFakeAdapter({ drain_secs: 30 }).adapter.manifest);
    expect(manifestJson(m)).toEqual({
      service: "zcode",
      display_name: "ZCode (z.ai)",
      version: "0.1.0",
      contract: "1.0",
      capabilities: ["events"],
      drain_secs: 30,
    });
  });

  test("drain_secs is omitted when the adapter does not declare it", () => {
    const m = validateManifest(makeFakeAdapter().adapter.manifest);
    expect(manifestJson(m)).not.toHaveProperty("drain_secs");
  });
});

describe("health and info", () => {
  test("GET /health answers without auth, exact shape", async () => {
    const s = ts();
    const res = await s.app.request("/health");
    expect(res.status).toBe(200);
    expect(res.headers.get("access-control-allow-origin")).toBeNull();
    expect(await json(res)).toEqual({
      status: "ok",
      service: "zcode",
      version: "0.1.0",
      contract: CONTRACT_VERSION,
    });
  });

  test("GET /info requires the admin token and lists declared fields", async () => {
    const s = ts();
    const denied = await s.app.request("/clauth/v1/info");
    expect(denied.status).toBe(401);
    expect(denied.headers.get("www-authenticate")).toBe("Bearer");
    expect(await json(denied)).toEqual({ ok: false, error: "unauthorized" });

    const res = await s.app.request("/clauth/v1/info", { headers: adminHeaders() });
    expect(res.status).toBe(200);
    const body = (await json(res)) as Record<string, unknown>;
    expect(body.contract).toBe(CONTRACT_VERSION);
    expect(body.capabilities).toEqual(["events"]);
    expect(Array.isArray(body.actions)).toBe(true);
    expect(Array.isArray(body.figures)).toBe(true);
    expect(Array.isArray(body.settings)).toBe(true);
  });

  test("a wrong admin token is refused 401", async () => {
    const s = ts();
    const res = await s.app.request("/clauth/v1/accounts", {
      headers: { authorization: "Bearer " + "f".repeat(64) },
    });
    expect(res.status).toBe(401);
    expect(await json(res)).toEqual({ ok: false, error: "unauthorized" });
  });
});

describe("accounts and login", () => {
  test("a new login mints an account and a key, handed out once", async () => {
    const s = ts();
    const loginEvents: Record<string, unknown>[] = [];
    s.server.events.subscribe((name, data) => {
      if (name === "login") loginEvents.push(data as Record<string, unknown>);
    });

    const res = await s.app.request("/clauth/v1/accounts/login", {
      method: "POST",
      headers: adminHeaders(),
      body: "{}",
    });
    expect(res.status).toBe(201);
    const start = (await res.json()) as { flow: string };

    // wait for the account without reading the flow (a GET would hand out the key)
    await waitFor(() => s.store.list().length === 1);

    // the first read hands the key out
    const first = (await (
      await s.app.request(`/clauth/v1/accounts/login/${start.flow}`, { headers: adminHeaders() })
    ).json()) as { state: string; account: { id: string }; inference_key?: string };
    expect(first.state).toBe("done");
    expect(first.inference_key).toMatch(/^clp_[A-Za-z0-9_-]{43}$/);

    // a later read omits it
    const second = (await (
      await s.app.request(`/clauth/v1/accounts/login/${start.flow}`, { headers: adminHeaders() })
    ).json()) as { state: string; inference_key?: string };
    expect(second.state).toBe("done");
    expect(second.inference_key).toBeUndefined();

    // the SSE login event never carried it
    expect(loginEvents.length).toBeGreaterThan(0);
    for (const ev of loginEvents) expect(ev.inference_key).toBeUndefined();

    const id = first.account.id;
    expect(id).toMatch(/^[a-z][a-z0-9]{11}$/);

    const accounts = (await (await s.app.request("/clauth/v1/accounts", { headers: adminHeaders() })).json()) as {
      accounts: { id: string; state: string; settings: Record<string, unknown> }[];
    };
    expect(accounts.accounts).toHaveLength(1);
    expect(accounts.accounts[0]!.id).toBe(id);
    expect(accounts.accounts[0]!.state).toBe("ready");
    // account-scope defaults are applied
    expect(accounts.accounts[0]!.settings).toEqual({
      plan: "coding-plan",
      off_peak: false,
      timezone: null,
    });
  }, 15000);

  test("a re-bind keeps the id and key; a different upstream user is identity_mismatch", async () => {
    const s = ts();
    const { id, key } = await loginNewAccount(s);

    // same identity re-binds: keeps id, key, no new inference_key in the done body
    const rebind = await s.app.request("/clauth/v1/accounts/login", {
      method: "POST",
      headers: adminHeaders(),
      body: JSON.stringify({ account: id }),
    });
    expect(rebind.status).toBe(201);
    const start = (await rebind.json()) as { flow: string };
    await waitFor(async () => {
      const r = await s.app.request(`/clauth/v1/accounts/login/${start.flow}`, { headers: adminHeaders() });
      return ((await r.json()) as { state: string }).state === "done";
    });
    const done = (await (
      await s.app.request(`/clauth/v1/accounts/login/${start.flow}`, { headers: adminHeaders() })
    ).json()) as { account: { id: string }; inference_key?: string };
    expect(done.account.id).toBe(id);
    expect(done.inference_key).toBeUndefined();

    // the same key still routes
    const fwd = await s.app.request("/v1/messages", {
      method: "POST",
      headers: { "x-api-key": key },
      body: JSON.stringify({ model: "x" }),
    });
    expect(fwd.status).toBe(200);

    // a different upstream user on re-bind is refused
    s.loginState.identity = "u-2";
    const bad = await s.app.request("/clauth/v1/accounts/login", {
      method: "POST",
      headers: adminHeaders(),
      body: JSON.stringify({ account: id }),
    });
    const badStart = (await bad.json()) as { flow: string };
    await waitFor(async () => {
      const r = await s.app.request(`/clauth/v1/accounts/login/${badStart.flow}`, { headers: adminHeaders() });
      return ((await r.json()) as { state: string }).state === "failed";
    });
    const failed = (await (
      await s.app.request(`/clauth/v1/accounts/login/${badStart.flow}`, { headers: adminHeaders() })
    ).json()) as { state: string; error: string };
    expect(failed.error).toBe("identity_mismatch");
  }, 15000);

  test("an unknown account id on re-bind is 404", async () => {
    const s = ts();
    const res = await s.app.request("/clauth/v1/accounts/login", {
      method: "POST",
      headers: adminHeaders(),
      body: JSON.stringify({ account: "nope1234" }),
    });
    expect(res.status).toBe(404);
    expect(await json(res)).toEqual({ ok: false, error: "not_found" });
  });

  test("DELETE a flow cancels it, stops polling upstream, and returns 204", async () => {
    const s = ts({ loginModes: ["poll"] });
    s.loginState.pending = true; // keep the flow pending so the cancel path is exercised
    const res = await s.app.request("/clauth/v1/accounts/login", {
      method: "POST",
      headers: adminHeaders(),
      body: "{}",
    });
    const start = (await res.json()) as { flow: string };
    const del = await s.app.request(`/clauth/v1/accounts/login/${start.flow}`, {
      method: "DELETE",
      headers: adminHeaders(),
    });
    expect(del.status).toBe(204);
    expect(s.calls.loginCancel).toEqual(["flow-token"]);
    const gone = await s.app.request(`/clauth/v1/accounts/login/${start.flow}`, {
      headers: adminHeaders(),
    });
    expect(gone.status).toBe(404);
  });

  test("a cancelled flow reads back 404 not_found, like an unknown one", async () => {
    const s = ts();
    s.loginState.pending = true;
    const res = await s.app.request("/clauth/v1/accounts/login", {
      method: "POST",
      headers: adminHeaders(),
      body: "{}",
    });
    const start = (await res.json()) as { flow: string };
    const del = await s.app.request(`/clauth/v1/accounts/login/${start.flow}`, {
      method: "DELETE",
      headers: adminHeaders(),
    });
    expect(del.status).toBe(204);
    const after = await s.app.request(`/clauth/v1/accounts/login/${start.flow}`, {
      headers: adminHeaders(),
    });
    expect(after.status).toBe(404);
    expect(await json(after)).toEqual({ ok: false, error: "not_found" });
  });

  test("DELETE /accounts/{id} refuses 409 while a re-bind flow is pending", async () => {
    const s = ts();
    const { id } = await loginNewAccount(s);
    s.loginState.pending = true;
    const res = await s.app.request("/clauth/v1/accounts/login", {
      method: "POST",
      headers: adminHeaders(),
      body: JSON.stringify({ account: id }),
    });
    const start = (await res.json()) as { flow: string };
    const del = await s.app.request(`/clauth/v1/accounts/${id}`, {
      method: "DELETE",
      headers: adminHeaders(),
    });
    expect(del.status).toBe(409);
    expect(await json(del)).toEqual({ ok: false, error: "conflict" });
    // cancel the flow so its poll timer does not linger past the test
    await s.app.request(`/clauth/v1/accounts/login/${start.flow}`, { method: "DELETE", headers: adminHeaders() });
  }, 15000);
});

describe("login paste", () => {
  test("a paste door delivers the code and mints the account", async () => {
    const s = ts({ loginModes: ["poll", "paste"] });
    const res = await s.app.request("/clauth/v1/accounts/login", {
      method: "POST",
      headers: adminHeaders(),
      body: JSON.stringify({}),
    });
    const start = (await res.json()) as { flow: string; modes: string[] };
    expect(start.modes).toEqual(["poll", "paste"]);
    const paste = await s.app.request(`/clauth/v1/accounts/login/${start.flow}`, {
      method: "POST",
      headers: adminHeaders(),
      body: JSON.stringify({ code: "123456" }),
    });
    expect(paste.status).toBe(200);
    const done = (await paste.json()) as { state: string; account: { id: string }; inference_key: string };
    expect(done.state).toBe("done");
    expect(done.inference_key).toMatch(/^clp_/);
  });

  test("a flow without a paste door refuses the paste 409 flow_not_paste", async () => {
    const s = ts();
    const res = await s.app.request("/clauth/v1/accounts/login", {
      method: "POST",
      headers: adminHeaders(),
      body: "{}",
    });
    const start = (await res.json()) as { flow: string };
    const paste = await s.app.request(`/clauth/v1/accounts/login/${start.flow}`, {
      method: "POST",
      headers: adminHeaders(),
      body: JSON.stringify({ code: "x" }),
    });
    expect(paste.status).toBe(409);
    expect(await json(paste)).toEqual({ ok: false, error: "flow_not_paste" });
  });

  test("a code over 4096 B is refused 413 payload_too_large", async () => {
    const s = ts({ loginModes: ["poll", "paste"] });
    const res = await s.app.request("/clauth/v1/accounts/login", {
      method: "POST",
      headers: adminHeaders(),
      body: "{}",
    });
    const start = (await res.json()) as { flow: string };
    const paste = await s.app.request(`/clauth/v1/accounts/login/${start.flow}`, {
      method: "POST",
      headers: adminHeaders(),
      body: JSON.stringify({ code: "a".repeat(4097) }),
    });
    expect(paste.status).toBe(413);
    expect(await json(paste)).toEqual({ ok: false, error: "payload_too_large" });
  });
});

describe("inference routing and errors", () => {
  test("a key reaches only its own account's adapter call", async () => {
    const s = ts();
    const a = await loginNewAccount(s);
    s.loginState.identity = "u-2";
    const b = await loginNewAccount(s);
    expect(a.id).not.toBe(b.id);

    await s.app.request("/v1/messages", { method: "POST", headers: { "x-api-key": a.key }, body: JSON.stringify({}) });
    await s.app.request("/v1/messages", { method: "POST", headers: { "x-api-key": b.key }, body: JSON.stringify({}) });

    expect(s.calls.forward).toHaveLength(2);
    expect(s.calls.forward[0]!.accountId).toBe(a.id);
    expect(s.calls.forward[1]!.accountId).toBe(b.id);
  }, 15000);

  test("inference errors use the Anthropic envelope", async () => {
    const s = ts();
    const missing = await s.app.request("/v1/messages", { method: "POST", body: JSON.stringify({}) });
    expect(missing.status).toBe(401);
    expect(await json(missing)).toEqual({
      type: "error",
      error: { type: "authentication_error", message: "invalid or missing api key" },
    });

    const unknown = await s.app.request("/v1/messages", {
      method: "POST",
      headers: { "x-api-key": "clp_" + "A".repeat(43) },
      body: JSON.stringify({}),
    });
    expect(unknown.status).toBe(401);

    const conflict = await s.app.request("/v1/messages", {
      method: "POST",
      headers: { "x-api-key": "clp_" + "A".repeat(43), authorization: "Bearer clp_" + "B".repeat(43) },
      body: JSON.stringify({}),
    });
    expect(conflict.status).toBe(401);
    expect(((await json(conflict)) as { error: { type: string } }).error.type).toBe("authentication_error");
  });

  test("count_tokens without the capability is 404 not_found_error", async () => {
    const s = ts({ capabilities: [] });
    const res = await s.app.request("/v1/messages/count_tokens", {
      method: "POST",
      headers: { "x-api-key": "clp_" + "A".repeat(43) },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(404);
    expect(((await json(res)) as { error: { type: string } }).error.type).toBe("not_found_error");
  });

  test("a suspended account is 403 permission_error", async () => {
    const s = ts();
    const { id } = await loginNewAccount(s);
    const account = s.store.get(id)!;
    account.state = "suspended";
    s.store.update(account);
    const key = account.key_hash; // not the key itself; mint a fresh one through the route instead
    const remint = await s.app.request(`/clauth/v1/accounts/${id}/key`, { method: "POST", headers: adminHeaders() });
    const { inference_key } = (await remint.json()) as { inference_key: string };
    const res = await s.app.request("/v1/messages", {
      method: "POST",
      headers: { "x-api-key": inference_key },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(403);
    expect(((await json(res)) as { error: { type: string } }).error.type).toBe("permission_error");
  }, 15000);
});

describe("usage", () => {
  test("GET /usage serves validated figures per account", async () => {
    const s = ts();
    const { id } = await loginNewAccount(s);
    await s.server.usage.pollOne(s.store.get(id)!);
    const res = await s.app.request("/clauth/v1/usage", { headers: adminHeaders() });
    expect(res.status).toBe(200);
    const body = (await json(res)) as { accounts: { account: string; state: string; available: boolean; figures: unknown[] }[] };
    expect(body.accounts).toHaveLength(1);
    const acct = body.accounts[0]!;
    expect(acct.account).toBe(id);
    expect(acct.available).toBe(true);
    expect(acct.figures).toHaveLength(2);
  }, 15000);

  test("a figure with chain on a non-window kind is dropped", async () => {
    const s = ts({
      figuresData: [
        {
          kind: "balance",
          id: "start-plan",
          label: "start plan",
          remaining: 100,
          unit: "tokens",
          chain: "5h",
          read_at: "2026-09-29T12:00:00Z",
        },
      ],
    });
    const { id } = await loginNewAccount(s);
    await s.server.usage.pollOne(s.store.get(id)!);
    const res = await s.app.request("/clauth/v1/usage", { headers: adminHeaders() });
    const body = (await json(res)) as { accounts: { figures: unknown[] }[] };
    expect(body.accounts[0]!.figures).toEqual([]);
  }, 15000);

  test("a failed read keeps the last good figures with a stale_reason", async () => {
    const s = ts();
    const { id } = await loginNewAccount(s);
    const account = s.store.get(id)!;
    await s.server.usage.pollOne(account);
    const first = (await (
      await s.app.request("/clauth/v1/usage", { headers: adminHeaders() })
    ).json()) as { accounts: { figures: { read_at: string }[] }[] };
    const firstReadAts = first.accounts[0]!.figures.map((f) => f.read_at);

    // the next read fails, rate limited: figures stay with their old read_at + a stale_reason
    s.readState.figuresError = new AdapterError("rate_limited");
    await s.server.usage.pollOne(s.store.get(id)!);
    const res = await s.app.request("/clauth/v1/usage", { headers: adminHeaders() });
    const body = (await json(res)) as { accounts: { figures: { read_at: string; stale_reason: string }[] }[] };
    const figures = body.accounts[0]!.figures;
    expect(figures).toHaveLength(2);
    for (let i = 0; i < figures.length; i++) {
      expect(figures[i]!.stale_reason).toBe("rate_limited");
      expect(figures[i]!.read_at).toBe(firstReadAts[i]!);
    }
  }, 15000);

  test("a successful read that omits a figure keeps it stale with upstream_unavailable", async () => {
    const s = ts();
    const { id } = await loginNewAccount(s);
    await s.server.usage.pollOne(s.store.get(id)!);

    // this round the upstream omits the balance figure
    s.readState.figuresData = [
      {
        kind: "window",
        id: "coding-plan-5h",
        label: "coding plan 5h",
        used: 1,
        limit: 2,
        unit: "tokens",
        window_secs: 18000,
        resets_at: null,
        chain: "5h",
        read_at: "2026-09-29T12:02:00Z",
      },
    ];
    await s.server.usage.pollOne(s.store.get(id)!);
    const res = await s.app.request("/clauth/v1/usage", { headers: adminHeaders() });
    const body = (await json(res)) as { accounts: { figures: Record<string, unknown>[] }[] };
    const figures = body.accounts[0]!.figures;
    expect(figures).toHaveLength(2);
    const window = figures.find((f) => f.id === "coding-plan-5h")!;
    const balance = figures.find((f) => f.id === "start-plan")!;
    expect(window.stale_reason).toBeUndefined();
    expect(balance.stale_reason).toBe("upstream_unavailable");
    expect(balance.read_at).toBe("2026-09-29T12:00:40Z");
  }, 15000);

  test("a figure read in flight at the delete caches nothing and publishes no usage event", async () => {
    let release: () => void = () => {};
    let held = false;
    const s = ts();
    const { id } = await loginNewAccount(s);
    const events: { name: string; data: unknown }[] = [];
    s.server.events.subscribe((name, data) => events.push({ name, data }));
    s.adapter.readFigures = async () => {
      held = true;
      await new Promise<void>((r) => (release = r));
      return [];
    };
    const poll = s.server.usage.pollOne(s.store.get(id)!);
    await waitFor(() => held); // the read is held in flight
    const del = await s.app.request(`/clauth/v1/accounts/${id}`, { method: "DELETE", headers: adminHeaders() });
    expect(del.status).toBe(204);
    release();
    expect(await poll).toBeNull(); // the dead account's read resolves to nothing
    expect(s.store.get(id)).toBeNull();
    expect(events.filter((e) => e.name === "usage")).toHaveLength(0);
  }, 15000);

  test("a failed figure read in flight at the delete caches nothing and publishes no usage event", async () => {
    let release: () => void = () => {};
    let held = false;
    const s = ts();
    const { id } = await loginNewAccount(s);
    const events: { name: string; data: unknown }[] = [];
    s.server.events.subscribe((name, data) => events.push({ name, data }));
    s.adapter.readFigures = async () => {
      held = true;
      await new Promise<void>((r) => (release = r));
      throw new AdapterError("rate_limited");
    };
    const poll = s.server.usage.pollOne(s.store.get(id)!);
    await waitFor(() => held); // the read is held in flight
    const del = await s.app.request(`/clauth/v1/accounts/${id}`, { method: "DELETE", headers: adminHeaders() });
    expect(del.status).toBe(204);
    release();
    expect(await poll).toBeNull(); // the dead account's failed read resolves to nothing: no cache entry, no event
    expect(s.store.get(id)).toBeNull();
    expect(events.filter((e) => e.name === "usage")).toHaveLength(0);
  }, 15000);
});

describe("settings and config", () => {
  test("PATCH /accounts/{id} writes account settings and refuses unknowns", async () => {
    const s = ts();
    const { id } = await loginNewAccount(s);
    const ok = await s.app.request(`/clauth/v1/accounts/${id}`, {
      method: "PATCH",
      headers: adminHeaders(),
      body: JSON.stringify({ settings: { plan: "start-plan" } }),
    });
    expect(ok.status).toBe(200);
    const updated = (await ok.json()) as { settings: Record<string, unknown> };
    expect(updated.settings.plan).toBe("start-plan");

    const bad = await s.app.request(`/clauth/v1/accounts/${id}`, {
      method: "PATCH",
      headers: adminHeaders(),
      body: JSON.stringify({ settings: { nope: true } }),
    });
    expect(bad.status).toBe(422);
    expect(await json(bad)).toEqual({ ok: false, error: "unknown_setting", reason: 'unknown setting "nope"', field: "nope" });
  }, 15000);

  test("an inactive setting is refused (active_when)", async () => {
    const s = ts();
    const { id } = await loginNewAccount(s);
    // plan is coding-plan by default; switch to start-plan, then off_peak is inactive
    await s.app.request(`/clauth/v1/accounts/${id}`, {
      method: "PATCH",
      headers: adminHeaders(),
      body: JSON.stringify({ settings: { plan: "start-plan" } }),
    });
    const res = await s.app.request(`/clauth/v1/accounts/${id}`, {
      method: "PATCH",
      headers: adminHeaders(),
      body: JSON.stringify({ settings: { off_peak: true } }),
    });
    expect(res.status).toBe(422);
    expect(((await json(res)) as { error: string }).error).toBe("invalid_setting");
  }, 15000);

  test("config GET/PATCH with restart flag and If-Match", async () => {
    const s = ts();
    const get = await s.app.request("/clauth/v1/config", { headers: adminHeaders() });
    expect(get.status).toBe(200);
    const getBody = (await get.json()) as { values: Record<string, unknown> };
    expect(getBody.values).toEqual({ host_identity: false });
    const etag = get.headers.get("etag");
    expect(etag).not.toBeNull();

    const patch = await s.app.request("/clauth/v1/config", {
      method: "PATCH",
      headers: adminHeaders({ "if-match": etag! }),
      body: JSON.stringify({ values: { host_identity: true } }),
    });
    expect(patch.status).toBe(200);
    expect(await json(patch)).toEqual({ values: { host_identity: true }, restart_required: true });

    const stale = await s.app.request("/clauth/v1/config", {
      method: "PATCH",
      headers: adminHeaders({ "if-match": `"${"0".repeat(64)}"` }),
      body: JSON.stringify({ values: { host_identity: false } }),
    });
    expect(stale.status).toBe(412);
    expect(await json(stale)).toEqual({ ok: false, error: "precondition_failed" });
  });
});

describe("keys and accounts", () => {
  test("re-minting a key invalidates the old one at once", async () => {
    const s = ts();
    const { id, key } = await loginNewAccount(s);
    const res = await s.app.request(`/clauth/v1/accounts/${id}/key`, { method: "POST", headers: adminHeaders() });
    expect(res.status).toBe(200);
    const { inference_key: newKey } = (await res.json()) as { inference_key: string };
    expect(newKey).not.toBe(key);

    const oldFwd = await s.app.request("/v1/messages", {
      method: "POST",
      headers: { "x-api-key": key },
      body: JSON.stringify({}),
    });
    expect(oldFwd.status).toBe(401);

    const newFwd = await s.app.request("/v1/messages", {
      method: "POST",
      headers: { "x-api-key": newKey },
      body: JSON.stringify({}),
    });
    expect(newFwd.status).toBe(200);
  }, 15000);

  test("DELETE /accounts/{id} drops the login and the record", async () => {
    const s = ts();
    const { id } = await loginNewAccount(s);
    const res = await s.app.request(`/clauth/v1/accounts/${id}`, { method: "DELETE", headers: adminHeaders() });
    expect(res.status).toBe(204);
    expect(s.calls.dropLogin.map((c) => c.accountId)).toEqual([id]);
    expect(s.store.get(id)).toBeNull();
  }, 15000);
});

describe("actions", () => {
  test("a declared action is accepted", async () => {
    const s = ts();
    const { id } = await loginNewAccount(s);
    const res = await s.app.request(`/clauth/v1/accounts/${id}/actions/claim-now`, {
      method: "POST",
      headers: adminHeaders(),
      body: JSON.stringify({ target: "weekend-glm" }),
    });
    expect(res.status).toBe(202);
    expect(await json(res)).toEqual({ accepted: true });
    expect(s.calls.runAction).toEqual([{ accountId: id, action: "claim-now", target: "weekend-glm" }]);
  }, 15000);
});

describe("events", () => {
  test("GET /events streams SSE only with the events capability", async () => {
    const s = ts(); // default capabilities include "events"
    const res = await s.app.request("/clauth/v1/events", { headers: adminHeaders() });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    await res.body?.cancel();

    const s2 = ts({ capabilities: [] });
    const denied = await s2.app.request("/clauth/v1/events", { headers: adminHeaders() });
    expect(denied.status).toBe(501);
    expect(await json(denied)).toEqual({ ok: false, error: "unsupported" });
  });

  test("DELETE /accounts/{id} publishes account_deleted with the id, never an account event", async () => {
    const s = ts();
    const events: { name: string; data: unknown }[] = [];
    s.server.events.subscribe((name, data) => events.push({ name, data }));
    const { id } = await loginNewAccount(s);
    const accountEventsBefore = events.filter((e) => e.name === "account").length;
    const del = await s.app.request(`/clauth/v1/accounts/${id}`, { method: "DELETE", headers: adminHeaders() });
    expect(del.status).toBe(204);
    const deleted = events.filter((e) => e.name === "account_deleted");
    expect(deleted).toHaveLength(1);
    expect(deleted[0]!.data).toEqual({ id });
    expect(events.filter((e) => e.name === "account").length).toBe(accountEventsBefore);
  }, 15000);
});

describe("id validation", () => {
  test("a malformed path id is refused 404 before any store or adapter call", async () => {
    const s = ts();
    const traversal = encodeURIComponent("../../victim-123");
    const del = await s.app.request(`/clauth/v1/accounts/${traversal}`, { method: "DELETE", headers: adminHeaders() });
    expect(del.status).toBe(404);
    expect(await json(del)).toEqual({ ok: false, error: "not_found" });
    expect(s.calls.dropLogin).toEqual([]);

    const flow = await s.app.request(`/clauth/v1/accounts/login/${encodeURIComponent("..%2F..%2Fx")}`, { headers: adminHeaders() });
    expect(flow.status).toBe(404);

    const usage = await s.app.request(`/clauth/v1/usage?account=${encodeURIComponent("../x")}`, { headers: adminHeaders() });
    expect(usage.status).toBe(404);
  });
});

describe("serialized account writes", () => {
  test("a re-mint landing during a figure read is not undone by that read", async () => {
    let release: () => void = () => {};
    const s = ts();
    const { id } = await loginNewAccount(s);
    s.adapter.readFigures = async () => {
      await new Promise<void>((r) => (release = r));
      throw new AdapterError("login_required");
    };
    const poll = s.server.usage.pollOne(s.store.get(id)!);
    const remint = await s.app.request(`/clauth/v1/accounts/${id}/key`, { method: "POST", headers: adminHeaders() });
    const { inference_key: newKey } = (await remint.json()) as { inference_key: string };
    release();
    await poll;
    const acct = s.store.get(id)!;
    expect(acct.key_hash).toBe(hashKey(newKey));
    expect(acct.state).toBe("login_required");
  }, 15000);

  test("a failed figure read that predates a re-bind does not flip the re-bound account", async () => {
    let release: () => void = () => {};
    const s = ts();
    const { id } = await loginNewAccount(s);
    await s.server.usage.pollOne(s.store.get(id)!);

    s.adapter.readFigures = async () => {
      await new Promise<void>((r) => (release = r));
      throw new AdapterError("login_required");
    };
    const poll = s.server.usage.pollOne(s.store.get(id)!);

    // re-bind while the read is in flight: bumps login_gen, state back to ready
    const rebind = await s.app.request("/clauth/v1/accounts/login", {
      method: "POST",
      headers: adminHeaders(),
      body: JSON.stringify({ account: id }),
    });
    const start = (await rebind.json()) as { flow: string };
    await waitFor(async () => {
      const r = await s.app.request(`/clauth/v1/accounts/login/${start.flow}`, { headers: adminHeaders() });
      return ((await r.json()) as { state: string }).state === "done";
    });

    release();
    await poll;
    expect(s.store.get(id)!.state).toBe("ready");
  }, 15000);

  test("a forward failure that predates a re-bind does not flip the re-bound account", async () => {
    let release: () => void = () => {};
    let forwardHeld = false;
    const s = ts();
    const { id, key } = await loginNewAccount(s);
    s.adapter.forward = async () => {
      forwardHeld = true;
      await new Promise<void>((r) => (release = r));
      throw new AdapterError("login_required");
    };
    const fwd = s.app.request("/v1/messages", {
      method: "POST",
      headers: { "x-api-key": key },
      body: JSON.stringify({ model: "x" }),
    });
    await waitFor(() => forwardHeld); // the forward read the account and is held

    // re-bind while the forward is in flight: the stale key still routes (re-bind keeps it)
    const rebind = await s.app.request("/clauth/v1/accounts/login", {
      method: "POST",
      headers: adminHeaders(),
      body: JSON.stringify({ account: id }),
    });
    const start = (await rebind.json()) as { flow: string };
    await waitFor(async () => {
      const r = await s.app.request(`/clauth/v1/accounts/login/${start.flow}`, { headers: adminHeaders() });
      return ((await r.json()) as { state: string }).state === "done";
    });

    release();
    const r = await fwd;
    expect(r.status).toBe(401);
    expect(s.store.get(id)!.state).toBe("ready");
  }, 15000);
});

describe("login races", () => {
  test("a cancel during an in-flight poll creates no account", async () => {
    let release: () => void = () => {};
    const s = ts();
    const orig = s.adapter.loginPoll;
    s.adapter.loginPoll = async (ctx) => {
      await new Promise<void>((r) => (release = r));
      return orig(ctx);
    };
    const res = await s.app.request("/clauth/v1/accounts/login", { method: "POST", headers: adminHeaders(), body: "{}" });
    const start = (await res.json()) as { flow: string };
    await new Promise((r) => setTimeout(r, 1150));
    const del = await s.app.request(`/clauth/v1/accounts/login/${start.flow}`, { method: "DELETE", headers: adminHeaders() });
    expect(del.status).toBe(204);
    release();
    await new Promise((r) => setTimeout(r, 50));
    expect(s.store.list()).toHaveLength(0);
    expect(s.calls.loginCancel).toEqual(["flow-token"]);
  }, 15000);

  test("a paste and an in-flight poll both delivering done mint one account", async () => {
    let release: () => void = () => {};
    const s = ts({ loginModes: ["poll", "paste"] });
    const orig = s.adapter.loginPoll;
    s.adapter.loginPoll = async (ctx) => {
      await new Promise<void>((r) => (release = r));
      return orig(ctx);
    };
    const res = await s.app.request("/clauth/v1/accounts/login", { method: "POST", headers: adminHeaders(), body: "{}" });
    const start = (await res.json()) as { flow: string };
    await new Promise((r) => setTimeout(r, 1150));
    const paste = await s.app.request(`/clauth/v1/accounts/login/${start.flow}`, {
      method: "POST",
      headers: adminHeaders(),
      body: JSON.stringify({ code: "123" }),
    });
    const pasteDone = (await paste.json()) as { state: string; inference_key?: string };
    expect(pasteDone.state).toBe("done");
    expect(pasteDone.inference_key).toMatch(/^clp_/);
    release();
    await new Promise((r) => setTimeout(r, 50));
    expect(s.store.list()).toHaveLength(1);
  }, 15000);

  test("a paste landing after the poll door delivered is dropped (one account, no key)", async () => {
    let pollRelease: () => void = () => {};
    let pasteRelease: () => void = () => {};
    let pasteHeld = false;
    const s = ts({ loginModes: ["poll", "paste"] });
    const origPoll = s.adapter.loginPoll;
    s.adapter.loginPoll = async (ctx) => {
      await new Promise<void>((r) => (pollRelease = r));
      return origPoll(ctx);
    };
    const origPaste = s.adapter.loginPaste!;
    s.adapter.loginPaste = async (ctx) => {
      pasteHeld = true;
      await new Promise<void>((r) => (pasteRelease = r));
      return origPaste(ctx);
    };
    const res = await s.app.request("/clauth/v1/accounts/login", { method: "POST", headers: adminHeaders(), body: "{}" });
    const start = (await res.json()) as { flow: string };
    await new Promise((r) => setTimeout(r, 1150)); // the poll is now in flight
    const pasteReq = s.app.request(`/clauth/v1/accounts/login/${start.flow}`, {
      method: "POST",
      headers: adminHeaders(),
      body: JSON.stringify({ code: "123" }),
    });
    await waitFor(() => pasteHeld); // the paste passed its liveness check and is held
    // the poll delivers first
    pollRelease();
    await new Promise((r) => setTimeout(r, 50));
    pasteRelease();
    const paste = await pasteReq;
    const pasteBody = (await paste.json()) as { state: string; inference_key?: string };
    expect(pasteBody.state).toBe("done");
    expect(pasteBody.inference_key).toBeUndefined();
    expect(s.store.list()).toHaveLength(1);
  }, 15000);

  test("a done landing after a cancel creates nothing and drops the upstream login", async () => {
    let release: () => void = () => {};
    const s = ts();
    s.adapter.loginPoll = async () => {
      await new Promise<void>((r) => (release = r));
      return {
        state: "done" as const,
        identity: "u-1",
        label: "kitty@example.com",
        plans: [],
        blob: { upstream: "credential" },
      };
    };
    const res = await s.app.request("/clauth/v1/accounts/login", { method: "POST", headers: adminHeaders(), body: "{}" });
    const start = (await res.json()) as { flow: string };
    await new Promise((r) => setTimeout(r, 1150)); // the poll is in flight
    const del = await s.app.request(`/clauth/v1/accounts/login/${start.flow}`, { method: "DELETE", headers: adminHeaders() });
    expect(del.status).toBe(204);
    release();
    await new Promise((r) => setTimeout(r, 50));
    expect(s.store.list()).toHaveLength(0);
    expect(s.calls.dropLogin).toEqual([{ accountId: null, account: null, upstream: { upstream: "credential" } }]);
  }, 15000);

  test("a done landing after the flow expired drops the upstream login", async () => {
    let release: () => void = () => {};
    let held = false;
    const s = ts();
    const expiresAt = Date.now() + 3000;
    s.adapter.loginStart = async () => ({
      url: "https://example.com/login",
      modes: ["poll"],
      poll_interval_ms: 1000,
      expires_at: new Date(expiresAt).toISOString(),
      upstream: "flow-token",
    });
    s.adapter.loginPoll = async () => {
      held = true;
      await new Promise<void>((r) => (release = r));
      return {
        state: "done" as const,
        identity: "u-1",
        label: "kitty@example.com",
        plans: [],
        blob: { upstream: "credential" },
      };
    };
    const res = await s.app.request("/clauth/v1/accounts/login", { method: "POST", headers: adminHeaders(), body: "{}" });
    const start = (await res.json()) as { flow: string };
    await waitFor(() => held); // the poll is held in flight
    await waitFor(() => Date.now() > expiresAt); // now past the expiry
    const g = await s.app.request(`/clauth/v1/accounts/login/${start.flow}`, { headers: adminHeaders() });
    expect(((await g.json()) as { state: string }).state).toBe("expired");
    release();
    await new Promise((r) => setTimeout(r, 50));
    expect(s.store.list()).toHaveLength(0);
    expect(s.calls.dropLogin).toEqual([{ accountId: null, account: null, upstream: { upstream: "credential" } }]);
  }, 15000);

  test("a throwing loginPoll keeps the flow pending and retries at the interval", async () => {
    const s = ts();
    let polls = 0;
    s.adapter.loginPoll = async () => {
      polls++;
      if (polls === 1) throw new Error("transient upstream blip");
      return { state: "done" as const, identity: "u-1", label: "kitty@example.com", plans: [], blob: { upstream: "credential" } };
    };
    const res = await s.app.request("/clauth/v1/accounts/login", { method: "POST", headers: adminHeaders(), body: "{}" });
    const start = (await res.json()) as { flow: string };
    await waitFor(() => polls >= 1); // the first poll threw
    const g = await s.app.request(`/clauth/v1/accounts/login/${start.flow}`, { headers: adminHeaders() });
    expect(((await g.json()) as { state: string }).state).toBe("pending");
    // polling continues at the interval and delivers the done
    await waitFor(async () => {
      const r = await s.app.request(`/clauth/v1/accounts/login/${start.flow}`, { headers: adminHeaders() });
      return ((await r.json()) as { state: string }).state === "done";
    });
  }, 15000);

  test("a done landing after the flow failed drops the upstream login", async () => {
    let pollRelease: () => void = () => {};
    let pasteRelease: () => void = () => {};
    let pollHeld = false;
    let pasteHeld = false;
    const s = ts({ loginModes: ["poll", "paste"] });
    s.adapter.loginPoll = async () => {
      pollHeld = true;
      await new Promise<void>((r) => (pollRelease = r));
      return { state: "failed" as const, error: "denied" as const };
    };
    const origPaste = s.adapter.loginPaste!;
    s.adapter.loginPaste = async (ctx) => {
      pasteHeld = true;
      await new Promise<void>((r) => (pasteRelease = r));
      return origPaste(ctx);
    };
    const res = await s.app.request("/clauth/v1/accounts/login", { method: "POST", headers: adminHeaders(), body: "{}" });
    const start = (await res.json()) as { flow: string };
    await waitFor(() => pollHeld); // the poll is in flight
    const pasteReq = s.app.request(`/clauth/v1/accounts/login/${start.flow}`, {
      method: "POST",
      headers: adminHeaders(),
      body: JSON.stringify({ code: "123" }),
    });
    await waitFor(() => pasteHeld); // the paste passed its liveness check and is held
    pollRelease(); // the poll door ends the flow failed
    await waitFor(async () => {
      const r = await s.app.request(`/clauth/v1/accounts/login/${start.flow}`, { headers: adminHeaders() });
      return ((await r.json()) as { state: string }).state === "failed";
    });
    pasteRelease(); // the paste door then delivers a real login
    const paste = (await (await pasteReq).json()) as { state: string };
    expect(paste.state).toBe("failed");
    expect(s.store.list()).toHaveLength(0);
    expect(s.calls.dropLogin).toEqual([{ accountId: null, account: null, upstream: { upstream: "credential" } }]);
  }, 15000);

  test("a done flow cleared at shutdown keeps its login when the other door delivers late", async () => {
    let pollRelease: () => void = () => {};
    let pasteRelease: () => void = () => {};
    let pollHeld = false;
    let pasteHeld = false;
    const s = ts({ loginModes: ["poll", "paste"] });
    const origPoll = s.adapter.loginPoll;
    s.adapter.loginPoll = async (ctx) => {
      pollHeld = true;
      await new Promise<void>((r) => (pollRelease = r));
      return origPoll(ctx);
    };
    const origPaste = s.adapter.loginPaste!;
    s.adapter.loginPaste = async (ctx) => {
      pasteHeld = true;
      await new Promise<void>((r) => (pasteRelease = r));
      return origPaste(ctx);
    };
    const res = await s.app.request("/clauth/v1/accounts/login", { method: "POST", headers: adminHeaders(), body: "{}" });
    const start = (await res.json()) as { flow: string };
    await waitFor(() => pollHeld); // the poll is in flight
    const pasteReq = s.app.request(`/clauth/v1/accounts/login/${start.flow}`, {
      method: "POST",
      headers: adminHeaders(),
      body: JSON.stringify({ code: "123" }),
    });
    await waitFor(() => pasteHeld); // the paste is held too
    pollRelease(); // the poll door finishes the flow done: one account
    await waitFor(() => s.store.list().length === 1);
    s.server.flows.close(); // shutdown clears every flow, the done one included
    pasteRelease(); // the paste door's own done lands on the cleared done flow
    await pasteReq;
    expect(s.store.list()).toHaveLength(1);
    expect(s.calls.dropLogin).toEqual([]);
  }, 15000);

  test("a poll that keeps throwing is logged once by its error class", async () => {
    const lines: string[] = [];
    const original = process.stderr.write.bind(process.stderr);
    (process.stderr as unknown as { write: (c: string) => boolean }).write = (c: string) => {
      lines.push(String(c));
      return true;
    };
    try {
      const s = ts();
      let polls = 0;
      s.adapter.loginPoll = async () => {
        polls++;
        throw new TypeError("upstream said: secret-bytes");
      };
      const res = await s.app.request("/clauth/v1/accounts/login", { method: "POST", headers: adminHeaders(), body: "{}" });
      const start = (await res.json()) as { flow: string };
      await waitFor(() => polls >= 2);
      const logged = lines.filter((l) => l.includes(`login flow ${start.flow}: poll failed`));
      expect(logged).toHaveLength(1);
      expect(logged[0]).toContain("(TypeError)");
      expect(lines.join("")).not.toContain("secret-bytes");
    } finally {
      (process.stderr as unknown as { write: typeof original }).write = original;
    }
  }, 15000);
});

describe("paste door resilience", () => {
  test("a paste that answers pending leaves the poll door running", async () => {
    const s = ts({ loginModes: ["poll", "paste"] });
    s.loginState.pending = true;
    let polls = 0;
    const orig = s.adapter.loginPoll;
    s.adapter.loginPoll = async (ctx) => {
      polls++;
      return orig(ctx);
    };
    const res = await s.app.request("/clauth/v1/accounts/login", { method: "POST", headers: adminHeaders(), body: "{}" });
    const start = (await res.json()) as { flow: string };
    const paste = await s.app.request(`/clauth/v1/accounts/login/${start.flow}`, {
      method: "POST",
      headers: adminHeaders(),
      body: JSON.stringify({ code: "wrong" }),
    });
    expect(paste.status).toBe(200);
    s.loginState.pending = false;
    await waitFor(() => polls > 0);
    const g = (await (
      await s.app.request(`/clauth/v1/accounts/login/${start.flow}`, { headers: adminHeaders() })
    ).json()) as { state: string };
    expect(g.state).toBe("done");
  }, 15000);

  test("a throwing paste answers 503 upstream_unavailable and keeps polling", async () => {
    const s = ts({ loginModes: ["poll", "paste"] });
    s.loginState.pending = true;
    let polls = 0;
    const orig = s.adapter.loginPoll;
    s.adapter.loginPoll = async (ctx) => {
      polls++;
      return orig(ctx);
    };
    s.adapter.loginPaste = async () => {
      throw new Error("upstream down");
    };
    const res = await s.app.request("/clauth/v1/accounts/login", { method: "POST", headers: adminHeaders(), body: "{}" });
    const start = (await res.json()) as { flow: string };
    const paste = await s.app.request(`/clauth/v1/accounts/login/${start.flow}`, {
      method: "POST",
      headers: adminHeaders(),
      body: JSON.stringify({ code: "wrong" }),
    });
    expect(paste.status).toBe(503);
    expect(await json(paste)).toEqual({ ok: false, error: "upstream_unavailable" });
    s.loginState.pending = false;
    await waitFor(() => polls > 0);
    const g = (await (
      await s.app.request(`/clauth/v1/accounts/login/${start.flow}`, { headers: adminHeaders() })
    ).json()) as { state: string };
    expect(g.state).toBe("done");
  }, 15000);

  test("a paste into a finished flow answers 409 conflict", async () => {
    const s = ts({ loginModes: ["poll", "paste"] });
    const res = await s.app.request("/clauth/v1/accounts/login", { method: "POST", headers: adminHeaders(), body: "{}" });
    const start = (await res.json()) as { flow: string };
    const first = await s.app.request(`/clauth/v1/accounts/login/${start.flow}`, {
      method: "POST",
      headers: adminHeaders(),
      body: JSON.stringify({ code: "1" }),
    });
    expect(first.status).toBe(200);
    const again = await s.app.request(`/clauth/v1/accounts/login/${start.flow}`, {
      method: "POST",
      headers: adminHeaders(),
      body: JSON.stringify({ code: "2" }),
    });
    expect(again.status).toBe(409);
    expect(await json(again)).toEqual({ ok: false, error: "conflict" });
  });
});

describe("poll loop liveness", () => {
  test("a paste that reschedules while a poll is in flight keeps one poll loop", async () => {
    let release: () => void = () => {};
    const s = ts({ loginModes: ["poll", "paste"] });
    s.loginState.pending = true;
    let polls = 0;
    const orig = s.adapter.loginPoll;
    s.adapter.loginPoll = async (ctx) => {
      polls++;
      if (polls === 1) await new Promise<void>((r) => (release = r));
      return orig(ctx);
    };
    const res = await s.app.request("/clauth/v1/accounts/login", { method: "POST", headers: adminHeaders(), body: "{}" });
    const start = (await res.json()) as { flow: string };
    await waitFor(() => polls === 1); // the first poll is held in flight
    const paste = await s.app.request(`/clauth/v1/accounts/login/${start.flow}`, {
      method: "POST",
      headers: adminHeaders(),
      body: JSON.stringify({ code: "wrong" }),
    });
    expect(paste.status).toBe(200);
    release();
    // one loop means exactly one further poll fires in the next interval; two loops
    // (the paste's timer plus the poll's own reschedule) would fire two
    await new Promise((r) => setTimeout(r, 1500));
    expect(polls).toBe(2);
  }, 15000);

  test("a poll never overlaps a poll already in flight", async () => {
    let release: () => void = () => {};
    const s = ts({ loginModes: ["poll", "paste"] });
    s.loginState.pending = true;
    let polls = 0;
    s.adapter.loginPoll = async () => {
      polls++;
      if (polls === 1) await new Promise<void>((r) => (release = r));
      return { state: "pending" as const };
    };
    const res = await s.app.request("/clauth/v1/accounts/login", { method: "POST", headers: adminHeaders(), body: "{}" });
    const start = (await res.json()) as { flow: string };
    await waitFor(() => polls === 1); // held
    // a paste reschedules a timer while the first poll is still in flight
    await s.app.request(`/clauth/v1/accounts/login/${start.flow}`, {
      method: "POST",
      headers: adminHeaders(),
      body: JSON.stringify({ code: "wrong" }),
    });
    await new Promise((r) => setTimeout(r, 1150)); // the rescheduled timer fires
    expect(polls).toBe(1); // the in-flight poll was not overlapped
    release();
    await new Promise((r) => setTimeout(r, 50));
  }, 15000);
});

describe("error envelopes", () => {
  test("a loginStart throw answers 503 upstream_unavailable, not plain 500", async () => {
    const s = ts();
    s.adapter.loginStart = async () => {
      throw new Error("upstream said: secret-body");
    };
    const r = await s.app.request("/clauth/v1/accounts/login", { method: "POST", headers: adminHeaders(), body: "{}" });
    expect(r.status).toBe(503);
    expect(await json(r)).toEqual({ ok: false, error: "upstream_unavailable" });
  });

  test("a loginStart with an invalid field answers 500 internal and logs the field name, never its value", async () => {
    const s = ts();
    s.adapter.loginStart = async () => ({
      url: "https://example.com/login",
      modes: ["poll"],
      poll_interval_ms: 1000,
      expires_at: "soon",
      upstream: "flow-token",
    });
    const captured: string[] = [];
    const original = process.stderr.write.bind(process.stderr);
    (process.stderr as unknown as { write: (c: string) => boolean }).write = (c: string) => {
      captured.push(c);
      return true;
    };
    try {
      const r = await s.app.request("/clauth/v1/accounts/login", { method: "POST", headers: adminHeaders(), body: "{}" });
      expect(r.status).toBe(500);
      expect(await json(r)).toEqual({ ok: false, error: "internal" });
    } finally {
      (process.stderr as unknown as { write: typeof original }).write = original;
    }
    expect(captured.join("")).toContain("expires_at");
    expect(captured.join("")).not.toContain("soon");
  });

  test("a login done with an invalid field fails the flow internal and logs the field name", async () => {
    const s = ts();
    s.adapter.loginPoll = async () =>
      ({ state: "done", identity: "u-1", label: 123, plans: [], blob: {} }) as never;
    const res = await s.app.request("/clauth/v1/accounts/login", { method: "POST", headers: adminHeaders(), body: "{}" });
    const start = (await res.json()) as { flow: string };
    const captured: string[] = [];
    const original = process.stderr.write.bind(process.stderr);
    (process.stderr as unknown as { write: (c: string) => boolean }).write = (c: string) => {
      captured.push(c);
      return true;
    };
    let g: { state: string; error: string } | undefined;
    try {
      await new Promise((r) => setTimeout(r, 1200)); // the poll fires at ~1000 ms
      const r2 = await s.app.request(`/clauth/v1/accounts/login/${start.flow}`, { headers: adminHeaders() });
      g = (await r2.json()) as { state: string; error: string };
    } finally {
      (process.stderr as unknown as { write: typeof original }).write = original;
    }
    expect(g!.state).toBe("failed");
    expect(g!.error).toBe("internal");
    expect(captured.join("")).toContain("label");
  }, 15000);

  test("an unhandled control-route throw answers the ErrorBody envelope", async () => {
    const s = ts();
    s.store.list = () => {
      throw new Error("disk full");
    };
    const r = await s.app.request("/clauth/v1/accounts", { headers: adminHeaders() });
    expect(r.status).toBe(500);
    expect(await json(r)).toEqual({ ok: false, error: "internal" });
  });

  test("an unhandled inference-route throw answers the Anthropic envelope", async () => {
    const s = ts();
    const { key } = await loginNewAccount(s);
    s.store.findByKeyHash = () => {
      throw new Error("boom");
    };
    const r = await s.app.request("/v1/messages", {
      method: "POST",
      headers: { "x-api-key": key },
      body: JSON.stringify({ model: "x" }),
    });
    expect(r.status).toBe(500);
    const body = (await json(r)) as { type: string; error: { type: string } };
    expect(body.type).toBe("error");
    expect(body.error.type).toBe("api_error");
  }, 15000);
});

describe("header stripping and inference errors", () => {
  test("the adapter never sees the client's key, authorization or host", async () => {
    const s = ts();
    const { key } = await loginNewAccount(s);
    await s.app.request("/v1/messages", {
      method: "POST",
      headers: { "x-api-key": key, authorization: `Bearer ${key}`, host: "127.0.0.1:1" },
      body: JSON.stringify({ model: "x" }),
    });
    const req = s.calls.forward[0]!.request;
    expect(req.headers.get("x-api-key")).toBeNull();
    expect(req.headers.get("authorization")).toBeNull();
    expect(req.headers.get("host")).toBeNull();
  }, 15000);

  test("an adapter rate_limited on forward answers 429 with retry-after", async () => {
    const s = ts();
    const { key } = await loginNewAccount(s);
    s.adapter.forward = async () => {
      throw new AdapterError("rate_limited", undefined, 30);
    };
    const r = await s.app.request("/v1/messages", {
      method: "POST",
      headers: { "x-api-key": key },
      body: JSON.stringify({ model: "x" }),
    });
    expect(r.status).toBe(429);
    expect(r.headers.get("retry-after")).toBe("30");
    expect(((await json(r)) as { error: { type: string } }).error.type).toBe("rate_limit_error");
  }, 15000);

  test("a forwarded response never carries Access-Control-Allow-* headers", async () => {
    const s = ts();
    const { key } = await loginNewAccount(s);
    s.adapter.forward = async () =>
      new Response("ok", { headers: { "access-control-allow-origin": "*", "content-type": "text/plain" } });
    const r = await s.app.request("/v1/messages", {
      method: "POST",
      headers: { "x-api-key": key },
      body: JSON.stringify({ model: "x" }),
    });
    expect(r.status).toBe(200);
    expect(r.headers.get("access-control-allow-origin")).toBeNull();
    expect(await r.text()).toBe("ok");
  }, 15000);

  test("a forwarded answer never carries content-encoding or content-length from upstream", async () => {
    const s = ts();
    const { key } = await loginNewAccount(s);
    s.adapter.forward = async () =>
      new Response("decoded body", {
        headers: { "content-type": "text/plain", "content-encoding": "gzip", "content-length": "12" },
      });
    const r = await s.app.request("/v1/messages", {
      method: "POST",
      headers: { "x-api-key": key },
      body: JSON.stringify({ model: "x" }),
    });
    expect(r.status).toBe(200);
    expect(r.headers.get("content-encoding")).toBeNull();
    expect(r.headers.get("content-length")).toBeNull();
    expect(await r.text()).toBe("decoded body");
  }, 15000);

  test("a forwarded answer never carries set-cookie or hop-by-hop headers from upstream", async () => {
    const s = ts();
    const { key } = await loginNewAccount(s);
    s.adapter.forward = async () =>
      new Response("ok", {
        headers: {
          "content-type": "text/plain",
          "set-cookie": "session=abc; Path=/",
          "connection": "keep-alive",
          "keep-alive": "timeout=5",
          "transfer-encoding": "chunked",
          "upgrade": "h2c",
          "proxy-authenticate": "Basic",
          "proxy-authorization": "Basic x",
          "proxy-connection": "keep-alive",
          "te": "trailers",
          "trailer": "x-checksum",
        },
      });
    const r = await s.app.request("/v1/messages", {
      method: "POST",
      headers: { "x-api-key": key },
      body: JSON.stringify({ model: "x" }),
    });
    expect(r.status).toBe(200);
    expect(r.headers.get("set-cookie")).toBeNull();
    expect(r.headers.get("connection")).toBeNull();
    expect(r.headers.get("keep-alive")).toBeNull();
    expect(r.headers.get("transfer-encoding")).toBeNull();
    expect(r.headers.get("upgrade")).toBeNull();
    expect(r.headers.get("proxy-authenticate")).toBeNull();
    expect(r.headers.get("proxy-authorization")).toBeNull();
    expect(r.headers.get("proxy-connection")).toBeNull();
    expect(r.headers.get("te")).toBeNull();
    expect(r.headers.get("trailer")).toBeNull();
    expect(await r.text()).toBe("ok");
  }, 15000);
});

describe("body caps", () => {
  test("login and paste bodies over 4096 B are refused 413", async () => {
    const s = ts({ loginModes: ["poll", "paste"] });
    const big = " ".repeat(5000) + "{}";
    const login = await s.app.request("/clauth/v1/accounts/login", { method: "POST", headers: adminHeaders(), body: big });
    expect(login.status).toBe(413);
    expect(await json(login)).toEqual({ ok: false, error: "payload_too_large" });

    const ok = await s.app.request("/clauth/v1/accounts/login", { method: "POST", headers: adminHeaders(), body: "{}" });
    const start = (await ok.json()) as { flow: string };
    const paste = await s.app.request(`/clauth/v1/accounts/login/${start.flow}`, {
      method: "POST",
      headers: adminHeaders(),
      body: " ".repeat(5000) + JSON.stringify({ code: "1" }),
    });
    expect(paste.status).toBe(413);
  });

  test("inference: a malformed body answers 400 invalid_request_error", async () => {
    const s = ts();
    const { key } = await loginNewAccount(s);
    const r = await s.app.request("/v1/messages", {
      method: "POST",
      headers: { "x-api-key": key },
      body: "{not json",
    });
    expect(r.status).toBe(400);
    expect(((await json(r)) as { error: { type: string } }).error.type).toBe("invalid_request_error");
  }, 15000);

  test("inference: an oversized body answers 413 request_too_large", async () => {
    const s = ts();
    const { key } = await loginNewAccount(s);
    const big = JSON.stringify({ model: "x".repeat(33 * 1024 * 1024) });
    const r = await s.app.request("/v1/messages", {
      method: "POST",
      headers: { "x-api-key": key },
      body: big,
    });
    expect(r.status).toBe(413);
    expect(((await json(r)) as { error: { type: string } }).error.type).toBe("request_too_large");
  }, 15000);
});

describe("settings manifest and reset", () => {
  test("a setting without a hint is refused at manifest time", () => {
    expect(() =>
      validateManifest({
        ...makeFakeAdapter().adapter.manifest,
        settings: [{ key: "x", scope: "proxy", label: "x", type: "string", default: "a" }] as never,
      }),
    ).toThrow(/hint/);
  });

  test("an enum needs options and a default must match the type", () => {
    expect(() =>
      validateManifest({
        ...makeFakeAdapter().adapter.manifest,
        settings: [{ key: "e", scope: "proxy", label: "e", hint: "h", type: "enum", default: "a", options: [] }] as never,
      }),
    ).toThrow(/option/);
    expect(() =>
      validateManifest({
        ...makeFakeAdapter().adapter.manifest,
        settings: [{ key: "b", scope: "proxy", label: "b", hint: "h", type: "bool", default: "nope" }] as never,
      }),
    ).toThrow(/default/);
  });

  test("duplicate figure ids and action names are refused at manifest time", () => {
    expect(() =>
      validateManifest({
        ...makeFakeAdapter().adapter.manifest,
        figures: [
          { id: "x", kind: "balance", label: "x" },
          { id: "x", kind: "stats", label: "y" },
        ] as never,
      }),
    ).toThrow(/duplicate figure id/);
    expect(() =>
      validateManifest({
        ...makeFakeAdapter().adapter.manifest,
        actions: [
          { name: "a", label: "a", scope: "account", confirm: false },
          { name: "a", label: "b", scope: "account", confirm: false },
        ] as never,
      }),
    ).toThrow(/duplicate action name/);
  });

  test("null resets a setting to its default, a null default included", async () => {
    const s = ts();
    const { id } = await loginNewAccount(s);
    const r = await s.app.request(`/clauth/v1/accounts/${id}`, {
      method: "PATCH",
      headers: adminHeaders(),
      body: JSON.stringify({ settings: { timezone: null } }),
    });
    expect(r.status).toBe(200);
    const body = (await r.json()) as { settings: Record<string, unknown> };
    expect(body.settings.timezone).toBeNull();
  }, 15000);
});

describe("figure validation", () => {
  test("a custom-unit figure needs unit_label and a currency balance needs currency", () => {
    const windowDecl = [{ id: "w", kind: "window" as const, label: "w" }];
    const windowBase = {
      kind: "window" as const,
      id: "w",
      label: "w",
      used: 1,
      limit: 2,
      window_secs: 60,
      resets_at: null,
      read_at: "2026-09-29T12:00:00Z",
    };
    expect(validateFigure({ ...windowBase, unit: "custom" }, windowDecl)).toBeNull();
    expect(validateFigure({ ...windowBase, unit: "custom", unit_label: "credits" }, windowDecl)).not.toBeNull();

    const balanceDecl = [{ id: "b", kind: "balance" as const, label: "b" }];
    expect(
      validateFigure({ kind: "balance", id: "b", label: "b", remaining: 1, unit: "currency", read_at: "2026-09-29T12:00:00Z" }, balanceDecl),
    ).toBeNull();
    expect(
      validateFigure(
        { kind: "balance", id: "b", label: "b", remaining: 1, unit: "currency", currency: "USD", read_at: "2026-09-29T12:00:00Z" },
        balanceDecl,
      ),
    ).not.toBeNull();

    // a junk read_at (20+ chars, so it is not caught by a bare length check) is dropped
    expect(validateFigure({ ...windowBase, unit: "tokens", read_at: "not-a-time-at-all-xxxx" }, windowDecl)).toBeNull();
  });

  test("duplicate figure ids per read are deduped", async () => {
    const figure = {
      kind: "window",
      id: "coding-plan-5h",
      label: "coding plan 5h",
      used: 1,
      limit: 2,
      unit: "tokens",
      window_secs: 18000,
      resets_at: null,
      chain: "5h",
      read_at: "2026-09-29T12:00:00Z",
    };
    const s = ts({ figuresData: [figure, { ...figure, used: 2 }] });
    const { id } = await loginNewAccount(s);
    await s.server.usage.pollOne(s.store.get(id)!);
    const res = await s.app.request("/clauth/v1/usage", { headers: adminHeaders() });
    const body = (await json(res)) as { accounts: { figures: unknown[] }[] };
    expect(body.accounts[0]!.figures).toHaveLength(1);
  }, 15000);
});

describe("actions", () => {
  test("an action answers 202 at once and a concurrent rerun answers 409", async () => {
    const s = ts();
    const { id } = await loginNewAccount(s);
    let release: () => void = () => {};
    s.adapter.runAction = async () => {
      await new Promise<void>((r) => (release = r));
    };
    const first = await s.app.request(`/clauth/v1/accounts/${id}/actions/claim-now`, {
      method: "POST",
      headers: adminHeaders(),
      body: JSON.stringify({ target: "x" }),
    });
    expect(first.status).toBe(202);
    expect(await json(first)).toEqual({ accepted: true });

    const second = await s.app.request(`/clauth/v1/accounts/${id}/actions/claim-now`, {
      method: "POST",
      headers: adminHeaders(),
      body: JSON.stringify({ target: "x" }),
    });
    expect(second.status).toBe(409);
    expect(await json(second)).toEqual({ ok: false, error: "conflict" });

    release();
    await new Promise((r) => setTimeout(r, 20));
    const third = await s.app.request(`/clauth/v1/accounts/${id}/actions/claim-now`, {
      method: "POST",
      headers: adminHeaders(),
      body: JSON.stringify({ target: "x" }),
    });
    expect(third.status).toBe(202);
  }, 15000);
});

describe("account events and expiry", () => {
  test("account writes publish account events", async () => {
    const s = ts();
    const accountEvents: unknown[] = [];
    s.server.events.subscribe((name, data) => {
      if (name === "account") accountEvents.push(data);
    });
    const { id } = await loginNewAccount(s);
    // the login's account creation publishes one
    expect(accountEvents.length).toBe(1);
    await s.app.request(`/clauth/v1/accounts/${id}`, {
      method: "PATCH",
      headers: adminHeaders(),
      body: JSON.stringify({ settings: { plan: "start-plan" } }),
    });
    expect(accountEvents.length).toBe(2);
    await s.app.request(`/clauth/v1/accounts/${id}/key`, { method: "POST", headers: adminHeaders() });
    expect(accountEvents.length).toBe(3);
  }, 15000);

  test("expiry publishes a login event with state expired", async () => {
    const s = ts();
    const loginEvents: { state: string }[] = [];
    s.server.events.subscribe((name, data) => {
      if (name === "login") loginEvents.push(data as { state: string });
    });
    s.adapter.loginStart = async () => ({
      url: "https://example.com/login",
      modes: ["poll"],
      poll_interval_ms: 1000,
      expires_at: new Date(Date.now() + 300).toISOString(),
      upstream: "flow-token",
    });
    const res = await s.app.request("/clauth/v1/accounts/login", { method: "POST", headers: adminHeaders(), body: "{}" });
    const start = (await res.json()) as { flow: string };
    await new Promise((r) => setTimeout(r, 400));
    const g = (await (
      await s.app.request(`/clauth/v1/accounts/login/${start.flow}`, { headers: adminHeaders() })
    ).json()) as { state: string };
    expect(g.state).toBe("expired");
    expect(loginEvents.some((e) => e.state === "expired")).toBe(true);
  }, 15000);
});

describe("store write failures", () => {
  test("a failed dropLogin on delete is logged and the record still drops", async () => {
    const s = ts();
    const { id } = await loginNewAccount(s);
    s.adapter.dropLogin = async () => {
      throw new Error("upstream down");
    };
    const captured: string[] = [];
    const original = process.stderr.write.bind(process.stderr);
    (process.stderr as unknown as { write: (chunk: string) => boolean }).write = (chunk: string) => {
      captured.push(chunk);
      return true;
    };
    try {
      const r = await s.app.request(`/clauth/v1/accounts/${id}`, { method: "DELETE", headers: adminHeaders() });
      expect(r.status).toBe(204);
    } finally {
      (process.stderr as unknown as { write: typeof original }).write = original;
    }
    expect(s.store.get(id)).toBeNull();
    expect(captured.join("")).toContain("dropLogin failed");
  }, 15000);

  test("a store write failure during a poll marks the flow failed/internal", async () => {
    const s = ts();
    const res = await s.app.request("/clauth/v1/accounts/login", { method: "POST", headers: adminHeaders(), body: "{}" });
    const start = (await res.json()) as { flow: string };
    s.store.create = () => {
      throw new Error("ENOSPC");
    };
    await waitFor(async () => {
      const r = await s.app.request(`/clauth/v1/accounts/login/${start.flow}`, { headers: adminHeaders() });
      return ((await r.json()) as { state: string }).state === "failed";
    });
    const g = (await (
      await s.app.request(`/clauth/v1/accounts/login/${start.flow}`, { headers: adminHeaders() })
    ).json()) as { state: string; error: string };
    expect(g.error).toBe("internal");
    expect(s.store.list()).toHaveLength(0);
  }, 15000);
});
