import { z } from "zod";
import { CONTRACT_VERSION } from "./contract.ts";
import {
  ChainRoleSchema,
  DeclaredActionSchema,
  FigureDeclarationSchema,
  FigureKindSchema,
  SettingFieldSchema,
} from "./schemas.ts";
import { valueError } from "./settings.ts";
import type { AdapterManifest } from "./types.ts";

const AdapterManifestSchema = z.object({
  service: z.string().regex(/^[a-z0-9][a-z0-9-]{0,31}$/),
  display_name: z.string().min(1),
  description: z.string().optional(),
  version: z.string().regex(/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?(\+[0-9A-Za-z.-]+)?$/),
  capabilities: z.array(z.string()),
  drain_secs: z.number().int().min(0).max(3600).optional(),
  figures: z.array(FigureDeclarationSchema),
  settings: z.array(SettingFieldSchema),
  actions: z.array(DeclaredActionSchema),
  usage_cadence_ms: z.number().int().min(1000),
});

/** A validated manifest, ready to serve. Fail-fast on an adapter that declares nonsense. */
export interface FullManifest {
  service: string;
  display_name: string;
  description?: string;
  version: string;
  contract: string;
  capabilities: string[];
  drain_secs?: number;
  figures: z.infer<typeof FigureDeclarationSchema>[];
  settings: z.infer<typeof SettingFieldSchema>[];
  actions: z.infer<typeof DeclaredActionSchema>[];
  usage_cadence_ms: number;
  /** The capability-gated optional routes the proxy serves. */
  hasEvents: boolean;
  hasCountTokens: boolean;
}

export function validateManifest(adapter: AdapterManifest): FullManifest {
  const parsed = AdapterManifestSchema.parse(adapter);

  // chain is valid on `window` figures only, one figure per role per account.
  const chainOwners = new Set<string>();
  const figureIds = new Set<string>();
  for (const figure of parsed.figures) {
    if (figureIds.has(figure.id)) {
      throw new Error(`duplicate figure id "${figure.id}"`);
    }
    figureIds.add(figure.id);
    if (figure.chain !== undefined) {
      if (figure.kind !== "window") {
        throw new Error(
          `figure "${figure.id}": chain is valid on window figures only (kind ${figure.kind})`,
        );
      }
      if (chainOwners.has(figure.chain)) {
        throw new Error(`figure "${figure.id}": chain role "${figure.chain}" already declared`);
      }
      chainOwners.add(figure.chain);
    }
  }

  const actionNames = new Set<string>();
  for (const action of parsed.actions) {
    if (actionNames.has(action.name)) {
      throw new Error(`duplicate action name "${action.name}"`);
    }
    actionNames.add(action.name);
  }

  const keys = new Set<string>();
  for (const field of parsed.settings) {
    if (keys.has(`${field.scope}\u0000${field.key}`)) {
      throw new Error(`duplicate setting "${field.key}" in scope ${field.scope}`);
    }
    keys.add(`${field.scope}\u0000${field.key}`);
    const maxLabel = field.scope === "account" ? 14 : 17;
    if (field.label.length > maxLabel) {
      throw new Error(
        `setting "${field.key}": label is ${field.label.length} chars, at most ${maxLabel} for ${field.scope} scope`,
      );
    }
    if (field.type === "enum" && (field.options === undefined || field.options.length === 0)) {
      throw new Error(`setting "${field.key}": an enum needs at least one option`);
    }
    // a non-null default must match the declared type (a null default is the
    // adapter's way of declaring the setting nullable)
    if (field.default !== null) {
      const problem = valueError(field, field.default);
      if (problem !== null) {
        throw new Error(`setting "${field.key}": default ${problem}`);
      }
    }
  }

  return {
    service: parsed.service,
    display_name: parsed.display_name,
    ...(parsed.description !== undefined ? { description: parsed.description } : {}),
    version: parsed.version,
    contract: CONTRACT_VERSION,
    capabilities: parsed.capabilities,
    ...(parsed.drain_secs !== undefined ? { drain_secs: parsed.drain_secs } : {}),
    figures: parsed.figures,
    settings: parsed.settings,
    actions: parsed.actions,
    usage_cadence_ms: parsed.usage_cadence_ms,
    hasEvents: parsed.capabilities.includes("events"),
    hasCountTokens: parsed.capabilities.includes("count_tokens"),
  };
}

/** The JSON `manifest` prints: nothing but the adapter's own fields plus the contract. */
export function manifestJson(manifest: FullManifest): Record<string, unknown> {
  const out: Record<string, unknown> = {
    service: manifest.service,
    display_name: manifest.display_name,
    ...(manifest.description !== undefined ? { description: manifest.description } : {}),
    version: manifest.version,
    contract: manifest.contract,
    capabilities: manifest.capabilities,
    ...(manifest.drain_secs !== undefined ? { drain_secs: manifest.drain_secs } : {}),
  };
  return out;
}

export const CHAIN_WINDOW_SECS: Record<string, number> = {
  "5h": 18000,
  "7d": 604800,
};

export function windowSecsForChain(chain: string | null | undefined): number | undefined {
  if (chain === null || chain === undefined) return undefined;
  return CHAIN_WINDOW_SECS[chain];
}

export const FIGURE_KINDS = FigureKindSchema.options as readonly string[];
export const CHAIN_ROLES = ChainRoleSchema.options as readonly string[];
