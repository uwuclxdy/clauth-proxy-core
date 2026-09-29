import { z } from "zod";
import { mintFlowId, mintInferenceKey, nowEpochMs, nowIso } from "./contract.ts";
import { errorClass, log } from "./log.ts";
import type { FullManifest } from "./manifest.ts";
import { LoginFailedCodeSchema, LoginModeSchema, PlanSchema, TimestampSchema } from "./schemas.ts";
import type { LoginStatusSchema, LoginStartSchema } from "./schemas.ts";
import { defaultSettings } from "./settings.ts";
import { AccountStore, toPublic, type AccountPublic } from "./store.ts";
import type {
  ExistingLogin,
  LoginDoneResult,
  LoginFailedCode,
  LoginMode,
  LoginPollResult,
  ProxyAdapter,
} from "./types.ts";

export type LoginStartBody = import("zod").z.infer<typeof LoginStartSchema>;
export type LoginStatusBody = import("zod").z.infer<typeof LoginStatusSchema>;

interface FlowRecord {
  id: string;
  accountId: string | null;
  existing: ExistingLogin | null;
  state: "pending" | "done" | "failed" | "expired";
  url: string;
  modes: LoginMode[];
  poll_interval_ms: number;
  expires_at: string;
  expiresAtEpoch: number;
  upstream: unknown;
  error?: LoginFailedCode;
  account?: AccountPublic;
  inferenceKey?: string;
  finishedAt?: number;
  timer: ReturnType<typeof setTimeout> | undefined;
  /** True while a poll call is awaiting the adapter, so a reschedule never overlaps one. */
  pollInFlight?: boolean;
  /** A throwing poll is logged once per flow, not on every retry. */
  pollErrorLogged?: boolean;
}

/** How long a terminal flow stays reachable before it is garbage-collected. */
const TERMINAL_GRACE_MS = 60_000;
const SWEEP_INTERVAL_MS = 30_000;

/** Raised inside a store patch when a re-bind lands on another upstream user. */
class IdentityMismatchError extends Error {
  constructor() {
    super("identity_mismatch");
  }
}

/**
 * The adapter's own result shapes, validated at the core boundary before anything
 * is served or stored. A bad field fails the flow with `internal` and logs the
 * field name, never its value; a login start that throws answers 503.
 */
const LoginStartResultSchema = z.object({
  url: z.string(),
  modes: z.array(LoginModeSchema).min(1).refine((m) => new Set(m).size === m.length, "duplicate mode"),
  poll_interval_ms: z.number().int().min(1000),
  expires_at: TimestampSchema,
  upstream: z.unknown(),
});

const LoginDoneResultSchema = z.object({
  state: z.literal("done"),
  identity: z.string(),
  label: z.string(),
  plans: z.array(PlanSchema),
  blob: z.unknown(),
});

const LoginPollResultSchema = z.discriminatedUnion("state", [
  z.object({ state: z.literal("pending") }),
  LoginDoneResultSchema,
  z.object({ state: z.literal("failed"), error: LoginFailedCodeSchema }),
]);

/** The first issue's path head — the invalid field's name — or `"result"` when none. */
function invalidField(error: { issues: Array<{ path: PropertyKey[] }> }): string {
  const head = error.issues[0]?.path[0];
  return head === undefined ? "result" : String(head);
}

function loginStartJson(flow: FlowRecord): LoginStartBody {
  return {
    flow: flow.id,
    state: "pending",
    url: flow.url,
    modes: flow.modes,
    poll_interval_ms: flow.poll_interval_ms,
    expires_at: flow.expires_at,
  };
}

export function flowStatusJson(flow: FlowRecord): LoginStatusBody {
  const out: LoginStatusBody = { flow: flow.id, state: flow.state };
  if (flow.state === "pending") {
    out.poll_interval_ms = flow.poll_interval_ms;
    out.expires_at = flow.expires_at;
  }
  if (flow.state === "done" && flow.account !== undefined) {
    out.account = flow.account;
    // the inference key never rides the shared status shape: it is handed out
    // exactly once by the one answer that first sees `done` (responseJson below)
  }
  if (flow.state === "failed" && flow.error !== undefined) {
    out.error = flow.error;
  }
  return out;
}

export class FlowManager {
  private flows = new Map<string, FlowRecord>();
  private sweep?: ReturnType<typeof setInterval>;

  constructor(
    private readonly adapter: ProxyAdapter,
    private readonly manifest: FullManifest,
    private readonly store: AccountStore,
    private readonly onLogin: (status: LoginStatusBody) => void,
    private readonly onAccount: (account: AccountPublic) => void,
    private readonly nowMs: () => number = nowEpochMs,
  ) {}

  /** Start a login: `accountId` null creates a new account, an id re-binds it. */
  async start(
    accountId: string | null,
  ): Promise<
    | { ok: true; value: LoginStartBody }
    | { ok: false; error: "not_found" | "upstream_unavailable" | "internal"; status: number }
  > {
    let existing: ExistingLogin | null = null;
    if (accountId !== null) {
      const account = this.store.get(accountId);
      if (account === null) return { ok: false, error: "not_found", status: 404 };
      existing = { identity: account.identity, blob: account.blob };
    }

    let res: Awaited<ReturnType<ProxyAdapter["loginStart"]>>;
    try {
      res = await this.adapter.loginStart({ accountId, existing });
    } catch {
      // an unreachable upstream at login start is the common failure: 503, not a 500
      return { ok: false, error: "upstream_unavailable", status: 503 };
    }
    const parsed = LoginStartResultSchema.safeParse(res);
    if (!parsed.success) {
      log.error(`login start: invalid ${invalidField(parsed.error)}`);
      return { ok: false, error: "internal", status: 500 };
    }
    const start = parsed.data;
    const flow: FlowRecord = {
      id: mintFlowId(),
      accountId,
      existing,
      state: "pending",
      url: start.url,
      modes: start.modes,
      poll_interval_ms: start.poll_interval_ms,
      expires_at: start.expires_at,
      expiresAtEpoch: Date.parse(start.expires_at),
      upstream: start.upstream,
      timer: undefined,
    };
    this.flows.set(flow.id, flow);
    this.schedulePoll(flow);
    return { ok: true, value: loginStartJson(flow) };
  }

  /** Read a flow's state, triggering no upstream call. Returns null when unknown or collected. */
  get(flowId: string): LoginStatusBody | null {
    const flow = this.flows.get(flowId);
    if (flow === undefined) return null;
    if (this.shouldCollect(flow)) {
      this.remove(flowId);
      return null;
    }
    if (flow.state === "pending" && this.nowMs() > flow.expiresAtEpoch) {
      this.expire(flow);
    }
    return this.responseJson(flow);
  }

  async paste(
    flowId: string,
    code: string,
  ): Promise<
    | { ok: true; value: LoginStatusBody }
    | {
        ok: false;
        error: "not_found" | "flow_not_paste" | "flow_expired" | "conflict" | "upstream_unavailable";
        status: number;
      }
  > {
    const flow = this.flows.get(flowId);
    if (flow === undefined) return { ok: false, error: "not_found", status: 404 };
    if (this.nowMs() > flow.expiresAtEpoch) {
      this.expire(flow);
      return { ok: false, error: "flow_expired", status: 410 };
    }
    if (flow.state === "expired") return { ok: false, error: "flow_expired", status: 410 };
    // a paste into a flow that already finished is a conflict, not an expiry
    if (flow.state !== "pending") return { ok: false, error: "conflict", status: 409 };
    if (!flow.modes.includes("paste") || this.adapter.loginPaste === undefined) {
      return { ok: false, error: "flow_not_paste", status: 409 };
    }
    this.clearTimer(flow);
    let res: LoginPollResult;
    try {
      res = await this.adapter.loginPaste({
        accountId: flow.accountId,
        existing: flow.existing,
        upstream: flow.upstream,
        code,
      });
    } catch {
      // a throwing paste keeps the poll door running; the flow stays pending
      this.schedulePoll(flow);
      return { ok: false, error: "upstream_unavailable", status: 503 };
    }
    const current = this.flows.get(flow.id);
    const state = flow.state as FlowRecord["state"];
    if (current !== flow || state !== "pending") {
      // cancel won, the poll door delivered first, or the flow expired: this
      // result is dropped. A done landing on a flow that did not finish done
      // (cancelled, expired, failed) still drops the upstream login it
      // established; a done flow owns it, and the record's state outlives its
      // removal (GC, shutdown), so a collected done flow still owns it.
      if (res.state === "done" && state !== "done") {
        await this.dropLateLogin(res);
      }
      if (current === undefined) {
        return { ok: false, error: "not_found", status: 404 };
      }
      return { ok: true, value: flowStatusJson(current) };
    }
    try {
      await this.applyPollResult(flow, res);
    } catch (err) {
      this.logFlowWriteFailure(flow, err);
    }
    if (flow.state === "pending") this.schedulePoll(flow);
    return { ok: true, value: this.responseJson(flow) };
  }

  /** Cancel a flow and stop polling upstream. Returns false when the flow is unknown. */
  async cancel(flowId: string): Promise<boolean> {
    const flow = this.flows.get(flowId);
    if (flow === undefined) return false;
    this.remove(flowId);
    try {
      await this.adapter.loginCancel({ accountId: flow.accountId, upstream: flow.upstream });
    } catch {
      // a dead upstream flow is already gone; the cancel still means "stop polling"
    }
    return true;
  }

  hasPendingForAccount(accountId: string): boolean {
    for (const flow of this.flows.values()) {
      if (flow.accountId === accountId && flow.state === "pending") return true;
    }
    return false;
  }

  close(): void {
    if (this.sweep !== undefined) clearInterval(this.sweep);
    for (const flow of this.flows.values()) this.clearTimer(flow);
    this.flows.clear();
  }

  private schedulePoll(flow: FlowRecord): void {
    this.clearTimer(flow);
    flow.timer = setTimeout(() => {
      void this.poll(flow);
    }, flow.poll_interval_ms);
  }

  private async poll(flow: FlowRecord): Promise<void> {
    if (this.flows.get(flow.id) !== flow || flow.state !== "pending") return;
    // one poll call per flow at any time: a reschedule during an in-flight poll
    // must not start a second one
    if (flow.pollInFlight === true) return;
    if (this.nowMs() > flow.expiresAtEpoch) {
      this.expire(flow);
      return;
    }
    flow.pollInFlight = true;
    try {
      let res: LoginPollResult;
      try {
        res = await this.adapter.loginPoll({
          accountId: flow.accountId,
          existing: flow.existing,
          upstream: flow.upstream,
        });
      } catch (err) {
        // a throwing poll is a transient upstream blip: keep the flow pending and
        // retry at the next interval; only an adapter `{state:"failed"}` ends it
        if (flow.pollErrorLogged !== true) {
          flow.pollErrorLogged = true;
          log.error(`login flow ${flow.id}: poll failed (${errorClass(err)})`);
        }
        if (this.flows.get(flow.id) === flow && flow.state === "pending") {
          this.schedulePoll(flow);
        }
        return;
      }
      // re-check after the await: a cancel (or a paste door) that landed first wins,
      // so a late result creates nothing. A done landing on a flow that did not
      // finish done still drops the login the upstream established; a done flow,
      // collected or not, owns it.
      const current = this.flows.get(flow.id);
      const state = flow.state as FlowRecord["state"];
      if (current !== flow || state !== "pending") {
        if (res.state === "done" && state !== "done") {
          await this.dropLateLogin(res);
        }
        return;
      }
      try {
        await this.applyPollResult(flow, res);
      } catch (err) {
        this.logFlowWriteFailure(flow, err);
      }
      if (flow.state === "pending") this.schedulePoll(flow);
    } finally {
      flow.pollInFlight = false;
    }
  }

  private async applyPollResult(flow: FlowRecord, res: LoginPollResult): Promise<void> {
    const parsed = LoginPollResultSchema.safeParse(res);
    if (!parsed.success) {
      log.error(`login flow ${flow.id}: invalid ${invalidField(parsed.error)}`);
      flow.state = "failed";
      flow.error = "internal";
      flow.finishedAt = this.nowMs();
      this.onLogin(flowStatusJson(flow));
      return;
    }
    res = parsed.data;
    if (res.state === "pending") return;
    this.clearTimer(flow);
    if (res.state === "failed") {
      flow.state = "failed";
      flow.error = res.error;
      flow.finishedAt = this.nowMs();
      this.onLogin(flowStatusJson(flow));
      return;
    }
    // done
    if (flow.accountId === null) {
      const key = mintInferenceKey();
      const account = this.store.create({
        label: res.label,
        state: "ready",
        identity: res.identity,
        blob: res.blob,
        plans: res.plans,
        settings: defaultSettings(this.manifest.settings, "account"),
        created_at: nowIso(),
        key,
      });
      flow.state = "done";
      flow.account = toPublic(account);
      flow.inferenceKey = key;
      flow.finishedAt = this.nowMs();
      this.onAccount(toPublic(account));
    } else {
      let stored;
      try {
        stored = await this.store.patch(flow.accountId, (current) => {
          if (current.identity !== res.identity) throw new IdentityMismatchError();
          current.label = res.label;
          current.blob = res.blob;
          current.plans = res.plans;
          current.state = "ready";
          current.login_gen = (current.login_gen ?? 0) + 1;
        });
      } catch (err) {
        if (err instanceof IdentityMismatchError) {
          flow.state = "failed";
          flow.error = "identity_mismatch";
          flow.finishedAt = this.nowMs();
          this.onLogin(flowStatusJson(flow));
          return;
        }
        throw err;
      }
      if (stored === null || flow.existing === null) {
        flow.state = "failed";
        flow.error = "internal";
        flow.finishedAt = this.nowMs();
        this.onLogin(flowStatusJson(flow));
        return;
      }
      flow.state = "done";
      flow.account = toPublic(stored);
      flow.finishedAt = this.nowMs();
      this.onAccount(toPublic(stored));
    }
    this.onLogin(flowStatusJson(flow));
  }

  private expire(flow: FlowRecord): void {
    this.clearTimer(flow);
    flow.state = "expired";
    // publish the expiry so an events subscriber sees the flow end
    this.onLogin(flowStatusJson(flow));
  }

  /**
   * The wire body for a read or paste answer. The inference key rides exactly one
   * answer — the one that first observes `done` — and is dropped from the flow
   * record the moment it is handed out.
   */
  private responseJson(flow: FlowRecord): LoginStatusBody {
    const out = flowStatusJson(flow);
    if (out.state === "done" && flow.inferenceKey !== undefined) {
      out.inference_key = flow.inferenceKey;
      delete flow.inferenceKey;
    }
    return out;
  }

  private logFlowWriteFailure(flow: FlowRecord, err: unknown): void {
    log.error(`login flow ${flow.id}: store write failed (${errorClass(err)})`);
    flow.state = "failed";
    flow.error = "internal";
    flow.finishedAt = this.nowMs();
    this.onLogin(flowStatusJson(flow));
  }

  /** Drop a login that arrived after its flow was cancelled, so no upstream session leaks. */
  private async dropLateLogin(res: LoginDoneResult): Promise<void> {
    try {
      await this.adapter.dropLogin({ accountId: null, account: null, upstream: res.blob });
    } catch (err) {
      log.error(`login flow: dropLogin of a late done failed (${errorClass(err)})`);
    }
  }

  private shouldCollect(flow: FlowRecord): boolean {
    if (flow.state === "expired") {
      return this.nowMs() > flow.expiresAtEpoch + TERMINAL_GRACE_MS;
    }
    if (flow.state === "done" || flow.state === "failed") {
      return flow.finishedAt !== undefined && this.nowMs() > flow.finishedAt + TERMINAL_GRACE_MS;
    }
    return false;
  }

  private remove(flowId: string): void {
    const flow = this.flows.get(flowId);
    if (flow !== undefined) this.clearTimer(flow);
    this.flows.delete(flowId);
  }

  private clearTimer(flow: FlowRecord): void {
    if (flow.timer !== undefined) clearTimeout(flow.timer);
    flow.timer = undefined;
  }

  sweepLoop(): ReturnType<typeof setInterval> {
    this.sweep = setInterval(() => {
      for (const [id, flow] of this.flows) {
        if (this.shouldCollect(flow)) this.remove(id);
      }
    }, SWEEP_INTERVAL_MS);
    return this.sweep;
  }
}
