import { z } from "zod";
import { ID_RE, SEMVER_RE, SERVICE_RE } from "./contract.ts";

export const IdSchema = z.string().regex(ID_RE);
export const ServiceSchema = z.string().regex(SERVICE_RE);
export const VersionSchema = z.string().regex(SEMVER_RE);
export const ContractSchema = z.string().regex(/^\d+\.\d+$/);
/** RFC 3339 in UTC; clauth accepts both a `Z` and a `+00:00` suffix. */
export const TimestampSchema = z.string().regex(
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]00:00)$/,
  "RFC 3339 UTC time",
);

export const FigureKindSchema = z.enum(["window", "balance", "channel", "offer", "stats"]);
export const UnitSchema = z.enum(["percent", "tokens", "requests", "currency", "custom"]);
export const ChainRoleSchema = z.enum(["5h", "7d"]);
export const AccountStateSchema = z.enum(["ready", "login_required", "suspended"]);
export const FlowStateSchema = z.enum(["pending", "done", "failed", "expired"]);
export const LoginModeSchema = z.enum(["poll", "paste"]);
export const LoginFailedCodeSchema = z.enum([
  "denied",
  "code_invalid",
  "identity_mismatch",
  "resolve_failed",
  "upstream_unavailable",
  "internal",
]);
export const StaleReasonSchema = z.enum(["login_required", "upstream_unavailable", "rate_limited"]);

// ---- manifest + /info declarations ----

export const PlanSchema = z.object({
  id: IdSchema,
  label: z.string(),
});

export const SettingFieldSchema = z.object({
  key: IdSchema,
  scope: z.enum(["proxy", "account"]),
  label: z.string(),
  hint: z.string(),
  type: z.enum(["bool", "enum", "int", "number", "string"]),
  default: z.unknown(),
  options: z.array(z.object({ value: z.unknown(), label: z.string() })).optional(),
  min: z.number().optional(),
  max: z.number().optional(),
  step: z.number().optional(),
  unit: z.string().optional(),
  active_when: z.object({ key: IdSchema, in: z.array(z.unknown()) }).optional(),
  inactive_hint: z.string().optional(),
  restart: z.boolean().optional(),
});

export const DeclaredActionSchema = z.object({
  name: IdSchema,
  label: z.string(),
  scope: z.literal("account"),
  target: FigureKindSchema.nullable().optional(),
  confirm: z.boolean(),
});

export const FigureDeclarationSchema = z.object({
  id: IdSchema,
  kind: FigureKindSchema,
  label: z.string(),
  chain: ChainRoleSchema.optional(),
});

export const ManifestSchema = z.object({
  service: ServiceSchema,
  display_name: z.string(),
  description: z.string().optional(),
  version: VersionSchema,
  contract: ContractSchema,
  capabilities: z.array(z.string()),
  drain_secs: z.number().int().min(0).max(3600).optional(),
});

export const InfoSchema = z.object({
  service: ServiceSchema,
  version: VersionSchema,
  contract: ContractSchema,
  capabilities: z.array(z.string()),
  actions: z.array(DeclaredActionSchema),
  figures: z.array(FigureDeclarationSchema),
  settings: z.array(SettingFieldSchema),
});

export const HealthSchema = z.object({
  status: z.literal("ok"),
  service: ServiceSchema,
  version: VersionSchema,
  contract: ContractSchema,
});

// ---- accounts + login ----

export const AccountSchema = z.object({
  id: IdSchema,
  label: z.string(),
  state: AccountStateSchema,
  created_at: TimestampSchema,
  plans: z.array(PlanSchema),
  settings: z.record(z.string(), z.unknown()),
});

export const AccountsListSchema = z.object({
  accounts: z.array(AccountSchema),
});

export const KeyResponseSchema = z.object({
  inference_key: z.string(),
});

export const ActionAcceptedSchema = z.object({
  accepted: z.literal(true),
});

export const LoginStartSchema = z.object({
  flow: IdSchema,
  state: z.literal("pending"),
  url: z.string(),
  modes: z.array(LoginModeSchema),
  poll_interval_ms: z.number().int().min(1000),
  expires_at: TimestampSchema,
});

export const LoginStatusSchema = z.object({
  flow: IdSchema,
  state: FlowStateSchema,
  poll_interval_ms: z.number().int().min(1000).optional(),
  expires_at: TimestampSchema.optional(),
  account: AccountSchema.optional(),
  inference_key: z.string().optional(),
  error: LoginFailedCodeSchema.optional(),
});

// ---- usage figures ----

export const FigureEnvelopeSchema = z.object({
  kind: FigureKindSchema,
  id: IdSchema,
  label: z.string(),
  read_at: TimestampSchema,
  stale_reason: StaleReasonSchema.optional(),
  summary: z.string().optional(),
});

const windowKindFields = {
  used: z.number(),
  limit: z.number().positive(),
  unit: UnitSchema,
  unit_label: z.string().optional(),
  window_secs: z.number().int(),
  resets_at: TimestampSchema.nullable(),
  chain: ChainRoleSchema.nullable().optional(),
};
export const WindowKindSchema = z.object(windowKindFields);
export const WindowFigureSchema = FigureEnvelopeSchema.extend({
  kind: z.literal("window"),
  ...windowKindFields,
}).superRefine((v, ctx) => {
  if (v.unit === "custom" && v.unit_label === undefined) {
    ctx.addIssue({
      code: "custom",
      message: "unit_label is required when unit is custom",
      path: ["unit_label"],
    });
  }
});

const balanceKindFields = {
  remaining: z.number(),
  limit: z.number().optional(),
  used: z.number().optional(),
  unit: UnitSchema,
  unit_label: z.string().optional(),
  currency: z.string().regex(/^[A-Z]{3}$/, "ISO 4217").optional(),
  expires_at: TimestampSchema.optional(),
};
export const BalanceKindSchema = z.object(balanceKindFields);
export const BalanceFigureSchema = FigureEnvelopeSchema.extend({
  kind: z.literal("balance"),
  ...balanceKindFields,
}).superRefine((v, ctx) => {
  if (v.unit === "custom" && v.unit_label === undefined) {
    ctx.addIssue({
      code: "custom",
      message: "unit_label is required when unit is custom",
      path: ["unit_label"],
    });
  }
  if (v.unit === "currency" && v.currency === undefined) {
    ctx.addIssue({
      code: "custom",
      message: "currency is required when unit is currency",
      path: ["currency"],
    });
  }
});

const channelKindFields = {
  open: z.boolean(),
  next_open_at: TimestampSchema.optional(),
  queue_position: z.number().int().optional(),
};
export const ChannelKindSchema = z.object(channelKindFields);
export const ChannelFigureSchema = FigureEnvelopeSchema.extend({
  kind: z.literal("channel"),
  ...channelKindFields,
});

export const GrantSchema = z.object({
  label: z.string(),
  amount: z.number(),
  unit: UnitSchema,
  unit_label: z.string().optional(),
  effective_at: TimestampSchema.optional(),
}).superRefine((v, ctx) => {
  if (v.unit === "custom" && v.unit_label === undefined) {
    ctx.addIssue({
      code: "custom",
      message: "unit_label is required when unit is custom",
      path: ["unit_label"],
    });
  }
});

export const OfferItemSchema = z.object({
  id: IdSchema,
  label: z.string(),
  description: z.string().optional(),
  state: z.enum(["available", "claiming", "claimed", "failed"]),
  failure: z.string().optional(),
  starts_at: TimestampSchema.optional(),
  ends_at: TimestampSchema.optional(),
  grants: z.array(GrantSchema),
});

const offerKindFields = {
  items: z.array(OfferItemSchema),
};
export const OfferKindSchema = z.object(offerKindFields);
export const OfferFigureSchema = FigureEnvelopeSchema.extend({
  kind: z.literal("offer"),
  ...offerKindFields,
});

export const StatsRequestsSchema = z.object({
  attempted: z.number().int(),
  succeeded: z.number().int(),
  failed: z.number().int(),
  cancelled: z.number().int(),
});

export const StatsTokensSchema = z.object({
  input: z.number().int(),
  output: z.number().int(),
  cache_read: z.number().int(),
  cache_creation: z.number().int(),
});

const statsKindFields = {
  since: TimestampSchema,
  requests: StatsRequestsSchema,
  mean_latency_ms: z.number().nullable(),
  tokens: StatsTokensSchema,
};
export const StatsKindSchema = z.object(statsKindFields);
export const StatsFigureSchema = FigureEnvelopeSchema.extend({
  kind: z.literal("stats"),
  ...statsKindFields,
});

export const FigureSchema = z.discriminatedUnion("kind", [
  WindowFigureSchema,
  BalanceFigureSchema,
  ChannelFigureSchema,
  OfferFigureSchema,
  StatsFigureSchema,
]);

export const UsageAccountSchema = z.object({
  account: IdSchema,
  state: AccountStateSchema,
  available: z.boolean(),
  figures: z.array(FigureSchema),
});

export const UsageSchema = z.object({
  accounts: z.array(UsageAccountSchema),
});

// ---- config ----

export const ConfigGetSchema = z.object({
  values: z.record(z.string(), z.unknown()),
});

export const ConfigPatchSchema = z.object({
  values: z.record(z.string(), z.unknown()),
  restart_required: z.boolean(),
});

// ---- error envelopes ----

export const ControlErrorSchema = z.object({
  ok: z.literal(false),
  error: z.string(),
  reason: z.string().optional(),
  field: z.string().optional(),
});

export const InferenceErrorSchema = z.object({
  type: z.literal("error"),
  error: z.object({
    type: z.string(),
    message: z.string(),
  }),
});

// ---- requests ----

export const LoginRequestSchema = z.object({
  account: IdSchema.optional(),
});

export const PasteRequestSchema = z.object({
  code: z.string(),
});

export const SettingsPatchRequestSchema = z.object({
  settings: z.record(z.string(), z.unknown()),
});

export const ConfigPatchRequestSchema = z.object({
  values: z.record(z.string(), z.unknown()),
});

export const ActionRequestSchema = z.object({
  target: z.string().optional(),
});

/**
 * The field tables a `clauth proxy check` parity test compares against the skill.
 * Each key names the skill's `### <name>` field table; each schema's `.shape`
 * keys are the field names.
 */
export const SHAPES: Record<string, z.ZodObject<Record<string, z.ZodType>>> = {
  manifest: ManifestSchema,
  health: HealthSchema,
  info: InfoSchema,
  action: DeclaredActionSchema,
  "figure-declaration": FigureDeclarationSchema,
  "setting-field": SettingFieldSchema,
  account: AccountSchema,
  plan: PlanSchema,
  accounts: AccountsListSchema,
  key: KeyResponseSchema,
  "action-accepted": ActionAcceptedSchema,
  "login-start": LoginStartSchema,
  "login-status": LoginStatusSchema,
  usage: UsageSchema,
  "usage-account": UsageAccountSchema,
  "figure-envelope": FigureEnvelopeSchema,
  "figure-window": WindowKindSchema,
  "figure-balance": BalanceKindSchema,
  "figure-channel": ChannelKindSchema,
  "figure-offer": OfferKindSchema,
  "figure-stats": StatsKindSchema,
  "offer-item": OfferItemSchema,
  grant: GrantSchema,
  "stats-requests": StatsRequestsSchema,
  "stats-tokens": StatsTokensSchema,
  "config-get": ConfigGetSchema,
  "config-patch": ConfigPatchSchema,
  "control-error": ControlErrorSchema,
  "inference-error": InferenceErrorSchema,
};
