import type { z } from "zod";
import type { DeclaredActionSchema, FigureDeclarationSchema, SettingFieldSchema } from "./schemas.ts";

/** A declared action, figure or setting field, as the adapter names it in its manifest. */
export type DeclaredAction = z.infer<typeof DeclaredActionSchema>;
export type FigureDeclaration = z.infer<typeof FigureDeclarationSchema>;
export type SettingField = z.infer<typeof SettingFieldSchema>;

/** The figure kinds a usage read may return. */
export type FigureKind = "window" | "balance" | "channel" | "offer" | "stats";

/** An account's upstream state, as the proxy presents it. */
export type AccountState = "ready" | "login_required" | "suspended";

/** A closed login-failure code, per the contract's `error` field on a failed flow. */
export type LoginFailedCode =
  | "denied"
  | "code_invalid"
  | "identity_mismatch"
  | "resolve_failed"
  | "upstream_unavailable"
  | "internal";

/** A failed usage read's stale reason, kept beside the last good figures. */
export type StaleReason = "login_required" | "upstream_unavailable" | "rate_limited";

/** A plan an upstream login holds. */
export interface Plan {
  id: string;
  label: string;
}

/** The opaque upstream credential an adapter hands the core to persist. JSON-serializable. */
export type AdapterBlob = unknown;

/** The adapter's own notion of who the upstream user is, used only for re-bind identity checks. */
export type UpstreamIdentity = string;

/** What the core keeps about an account's live upstream login. */
export interface ExistingLogin {
  identity: UpstreamIdentity;
  blob: AdapterBlob;
}

export type LoginMode = "poll" | "paste";

export interface LoginStartContext {
  /** `null` = a new account; an id = re-bind that account. */
  accountId: string | null;
  /** The previous login, on re-bind; `null` on a fresh login. */
  existing: ExistingLogin | null;
}

export interface LoginStartResult {
  url: string;
  modes: LoginMode[];
  poll_interval_ms: number;
  expires_at: string;
  /** An opaque upstream flow handle the core persists and passes back on every later call. */
  upstream: unknown;
}

export interface LoginPollContext {
  accountId: string | null;
  existing: ExistingLogin | null;
  upstream: unknown;
}

export interface LoginDoneResult {
  state: "done";
  identity: UpstreamIdentity;
  /** The label the proxy displays for this account. */
  label: string;
  plans: Plan[];
  blob: AdapterBlob;
}

export type LoginPollResult =
  | { state: "pending" }
  | LoginDoneResult
  | { state: "failed"; error: LoginFailedCode };

export interface LoginPasteContext {
  accountId: string | null;
  existing: ExistingLogin | null;
  upstream: unknown;
  code: string;
}

export interface LoginCancelContext {
  accountId: string | null;
  upstream: unknown;
}

/** The account record the core passes to the adapter; the adapter never writes it. */
export interface AccountView {
  id: string;
  label: string;
  state: AccountState;
  plans: Plan[];
  settings: Record<string, unknown>;
  created_at: string;
  blob: AdapterBlob;
}

export interface ForwardContext {
  accountId: string;
  account: AccountView;
  /** The original inbound request; path and query are the client's. */
  request: Request;
  /** `"messages"` or `"count_tokens"`. */
  route: "messages" | "count_tokens";
}

export interface ReadFiguresContext {
  accountId: string;
  account: AccountView;
}

export interface RunActionContext {
  accountId: string;
  account: AccountView;
  action: string;
  target: string | null;
}

export interface DropLoginContext {
  /** `null` when the login never became an account (a late `done` after a cancel). */
  accountId: string | null;
  /** `null` when no account exists (a late `done` after a cancel). */
  account: AccountView | null;
  /** The login blob to drop: the account's blob on delete, the `done` result's blob on a late drop. */
  upstream: unknown;
}

/**
 * A typed failure the adapter raises. `reason` picks the stale reason on a usage
 * read and the account state on a login-required/suspended signal; anything else
 * the adapter throws reads as a generic upstream failure.
 */
export type AdapterFailureReason = "login_required" | "suspended" | "upstream_unavailable" | "rate_limited";

export class AdapterError extends Error {
  readonly reason: AdapterFailureReason;
  /** Seconds to forward as `retry-after` on a `rate_limited` inference answer. */
  readonly retryAfter: number | undefined;
  constructor(reason: AdapterFailureReason, message?: string, retryAfter?: number) {
    super(message ?? reason);
    this.reason = reason;
    this.retryAfter = retryAfter;
  }
}

/** The provider-specific half of a proxy. The core owns everything else. */
export interface ProxyAdapter {
  manifest: AdapterManifest;

  /** Start an upstream login. Must not block; returns the flow's doors and handle. */
  loginStart(ctx: LoginStartContext): Promise<LoginStartResult>;

  /** Poll an in-flight login once. */
  loginPoll(ctx: LoginPollContext): Promise<LoginPollResult>;

  /** Deliver a pasted code. Present only when the flow's modes include `paste`. */
  loginPaste?(ctx: LoginPasteContext): Promise<LoginPollResult>;

  /** Stop polling and drop the upstream flow. */
  loginCancel(ctx: LoginCancelContext): Promise<void>;

  /** Forward one inference request, streaming passthrough, and return the upstream response. */
  forward(ctx: ForwardContext): Promise<Response>;

  /** Read one account's figures. Throw {@link AdapterError} to mark the read stale. */
  readFigures(ctx: ReadFiguresContext): Promise<unknown>;

  /** Run one declared action. The outcome rides the figure. */
  runAction(ctx: RunActionContext): Promise<void>;

  /** Drop the account's upstream login on delete. */
  dropLogin(ctx: DropLoginContext): Promise<void>;
}

export interface AdapterManifest {
  service: string;
  display_name: string;
  description?: string;
  version: string;
  capabilities: string[];
  drain_secs?: number;
  figures: FigureDeclaration[];
  settings: SettingField[];
  actions: DeclaredAction[];
  /** How often the core polls each account's figures, in milliseconds. */
  usage_cadence_ms: number;
}
