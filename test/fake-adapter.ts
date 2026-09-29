import type {
  DeclaredAction,
  DropLoginContext,
  FigureDeclaration,
  ForwardContext,
  LoginMode,
  Plan,
  ProxyAdapter,
  SettingField,
} from "../src/index.ts";

export interface FakeAdapterOptions {
  service?: string;
  display_name?: string;
  version?: string;
  capabilities?: string[];
  drain_secs?: number;
  figures?: FigureDeclaration[];
  settings?: SettingField[];
  actions?: DeclaredAction[];
  usage_cadence_ms?: number;
  /** What readFigures returns. */
  figuresData?: unknown[];
  /** Throw from readFigures (e.g. `new AdapterError("rate_limited")`). */
  figuresError?: unknown;
  /** One login's identity, label, plans and blob. */
  identity?: string;
  label?: string;
  plans?: Plan[];
  blob?: unknown;
  loginModes?: LoginMode[];
  pollIntervalMs?: number;
  /** Override forward entirely (the fixture uses this to stream). */
  forward?: (ctx: ForwardContext) => Response | Promise<Response>;
}

export const DEFAULT_FIGURES: FigureDeclaration[] = [
  { id: "coding-plan-5h", kind: "window", label: "coding plan 5h", chain: "5h" },
  { id: "coding-plan-7d", kind: "window", label: "coding plan 7d", chain: "7d" },
  { id: "start-plan", kind: "balance", label: "start plan" },
  { id: "off-peak", kind: "channel", label: "off-peak" },
  { id: "trial-plans", kind: "offer", label: "trial plans" },
  { id: "traffic", kind: "stats", label: "traffic" },
];

export const DEFAULT_SETTINGS: SettingField[] = [
  {
    key: "plan",
    scope: "account",
    label: "plan",
    hint: "which plan serves this account's requests",
    type: "enum",
    default: "coding-plan",
    options: [
      { value: "coding-plan", label: "coding plan" },
      { value: "start-plan", label: "start plan" },
    ],
  },
  {
    key: "off_peak",
    scope: "account",
    label: "off-peak",
    hint: "serve this account's requests through the free off-peak channel",
    type: "bool",
    default: false,
    active_when: { key: "plan", in: ["coding-plan"] },
    inactive_hint: "off-peak serves the coding plan only",
  },
  {
    key: "timezone",
    scope: "account",
    label: "timezone",
    hint: "IANA zone this account presents",
    type: "string",
    default: null,
  },
  {
    key: "host_identity",
    scope: "proxy",
    label: "host OS values",
    hint: "send this host's real OS values for every account",
    type: "bool",
    default: false,
    restart: true,
  },
];

export const DEFAULT_ACTIONS: DeclaredAction[] = [
  { name: "claim-now", label: "claim now", scope: "account", target: "offer", confirm: false },
];

export interface FakeAdapterCalls {
  forward: ForwardContext[];
  readFigures: string[];
  runAction: { accountId: string; action: string; target: string | null }[];
  dropLogin: DropLoginContext[];
  loginStart: (string | null)[];
  loginCancel: string[];
}

/** The in-test fixture provider: records every call and serves canned answers. */
export function makeFakeAdapter(opts: FakeAdapterOptions = {}): {
  adapter: ProxyAdapter;
  calls: FakeAdapterCalls;
  loginState: { identity: string; label: string; plans: Plan[]; blob: unknown; pending: boolean };
  readState: { figuresData: unknown[] | undefined; figuresError: unknown };
} {
  const calls: FakeAdapterCalls = {
    forward: [],
    readFigures: [],
    runAction: [],
    dropLogin: [],
    loginStart: [],
    loginCancel: [],
  };

  const loginState = {
    identity: opts.identity ?? "u-1",
    label: opts.label ?? "kitty@example.com",
    plans: opts.plans ?? [
      { id: "coding-plan", label: "coding plan" },
      { id: "start-plan", label: "start plan" },
    ],
    blob: opts.blob ?? { upstream: "credential" },
    pending: false,
  };

  const readState: { figuresData: unknown[] | undefined; figuresError: unknown } = {
    figuresData: opts.figuresData,
    figuresError: opts.figuresError,
  };

  const adapter: ProxyAdapter = {
    manifest: {
      service: opts.service ?? "zcode",
      display_name: opts.display_name ?? "ZCode (z.ai)",
      version: opts.version ?? "0.1.0",
      capabilities: opts.capabilities ?? ["events"],
      ...(opts.drain_secs !== undefined ? { drain_secs: opts.drain_secs } : {}),
      figures: opts.figures ?? DEFAULT_FIGURES,
      settings: opts.settings ?? DEFAULT_SETTINGS,
      actions: opts.actions ?? DEFAULT_ACTIONS,
      usage_cadence_ms: opts.usage_cadence_ms ?? 60_000,
    },

    async loginStart(ctx) {
      calls.loginStart.push(ctx.accountId);
      return {
        url: "https://example.com/login",
        modes: opts.loginModes ?? ["poll"],
        poll_interval_ms: opts.pollIntervalMs ?? 1000,
        expires_at: new Date(Date.now() + 10 * 60_000).toISOString(),
        upstream: "flow-token",
      };
    },

    async loginPoll() {
      if (loginState.pending) return { state: "pending" as const };
      return {
        state: "done" as const,
        identity: loginState.identity,
        label: loginState.label,
        plans: loginState.plans,
        blob: loginState.blob,
      };
    },

    async loginPaste() {
      if (loginState.pending) return { state: "pending" as const };
      return {
        state: "done" as const,
        identity: loginState.identity,
        label: loginState.label,
        plans: loginState.plans,
        blob: loginState.blob,
      };
    },

    async loginCancel(ctx) {
      calls.loginCancel.push(ctx.upstream as string);
    },

    async forward(ctx) {
      calls.forward.push(ctx);
      if (opts.forward !== undefined) return opts.forward(ctx);
      return new Response(JSON.stringify({ account_id: ctx.accountId, route: ctx.route }), {
        headers: { "content-type": "application/json" },
      });
    },

    async readFigures(ctx) {
      calls.readFigures.push(ctx.accountId);
      if (readState.figuresError !== undefined) throw readState.figuresError;
      return readState.figuresData ?? [
        {
          kind: "window",
          id: "coding-plan-5h",
          label: "coding plan 5h",
          used: 1234567,
          limit: 4000000,
          unit: "tokens",
          window_secs: 18000,
          resets_at: null,
          chain: "5h",
          read_at: "2026-09-29T12:01:00Z",
        },
        {
          kind: "balance",
          id: "start-plan",
          label: "start plan",
          remaining: 820000,
          limit: 1000000,
          used: 180000,
          unit: "tokens",
          expires_at: "2026-10-05T00:00:00Z",
          read_at: "2026-09-29T12:00:40Z",
        },
      ];
    },

    async runAction(ctx) {
      calls.runAction.push({ accountId: ctx.accountId, action: ctx.action, target: ctx.target });
    },

    async dropLogin(ctx) {
      calls.dropLogin.push(ctx);
    },
  };

  return { adapter, calls, loginState, readState };
}
