import type { SettingField } from "./types.ts";

export type SettingsResult =
  | { ok: true; merged: Record<string, unknown>; restartRequired: boolean }
  | { ok: false; error: "unknown_setting" | "invalid_setting"; field: string; reason: string };

function deepEqual(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((v, i) => deepEqual(v, b[i]));
  }
  if (typeof a === "object" && typeof b === "object" && a !== null && b !== null) {
    const ka = Object.keys(a);
    const kb = Object.keys(b);
    if (ka.length !== kb.length) return false;
    return ka.every((k) => deepEqual((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]));
  }
  return false;
}

function alignedToStep(value: number, min: number | undefined, step: number | undefined): boolean {
  if (step === undefined) return true;
  const base = min ?? 0;
  const k = (value - base) / step;
  return Math.abs(k - Math.round(k)) < 1e-9;
}

export function valueError(field: SettingField, value: unknown): string | null {
  switch (field.type) {
    case "bool":
      return typeof value === "boolean" ? null : `expected a boolean, got ${JSON.stringify(value)}`;
    case "enum": {
      const ok = (field.options ?? []).some((o) => deepEqual(o.value, value));
      return ok ? null : `not one of the declared options: ${JSON.stringify(value)}`;
    }
    case "int":
      if (typeof value !== "number" || !Number.isInteger(value)) {
        return `expected an integer, got ${JSON.stringify(value)}`;
      }
      if (field.min !== undefined && value < field.min) return `below min ${field.min}`;
      if (field.max !== undefined && value > field.max) return `above max ${field.max}`;
      if (!alignedToStep(value, field.min, field.step)) return `not aligned to step ${field.step}`;
      return null;
    case "number":
      if (typeof value !== "number" || Number.isNaN(value)) {
        return `expected a number, got ${JSON.stringify(value)}`;
      }
      if (field.min !== undefined && value < field.min) return `below min ${field.min}`;
      if (field.max !== undefined && value > field.max) return `above max ${field.max}`;
      if (!alignedToStep(value, field.min, field.step)) return `not aligned to step ${field.step}`;
      return null;
    case "string":
      return typeof value === "string" ? null : `expected a string, got ${JSON.stringify(value)}`;
  }
}

/**
 * Validate a settings patch against the declared form for one scope. `null` resets
 * a key to its declared default. A field whose `active_when` no longer holds in the
 * merged result is refused, so a dimmed row cannot be written.
 */
export function validateSettings(
  fields: SettingField[],
  scope: "proxy" | "account",
  patch: Record<string, unknown>,
  current: Record<string, unknown>,
): SettingsResult {
  const byKey = new Map<string, SettingField>();
  for (const field of fields) {
    if (field.scope === scope) byKey.set(field.key, field);
  }

  const applied: Record<string, unknown> = {};
  for (const [key, raw] of Object.entries(patch)) {
    const field = byKey.get(key);
    if (field === undefined) {
      return { ok: false, error: "unknown_setting", field: key, reason: `unknown setting "${key}"` };
    }
    // `null` resets a key to its declared default. The default is the adapter's
    // declaration, checked against its type at manifest time (a `null` default
    // marks the setting nullable), so it is applied without a value check.
    const value = raw === null ? field.default : raw;
    const problem = raw === null ? null : valueError(field, value);
    if (problem !== null) {
      return { ok: false, error: "invalid_setting", field: key, reason: problem };
    }
    applied[key] = value;
  }

  const merged = { ...current, ...applied };

  for (const key of Object.keys(applied)) {
    const field = byKey.get(key)!;
    if (field.active_when !== undefined) {
      const cond = field.active_when;
      const other = merged[cond.key];
      if (!cond.in.some((v) => deepEqual(v, other))) {
        return {
          ok: false,
          error: "invalid_setting",
          field: key,
          reason: `${key} is inactive while ${cond.key} is ${JSON.stringify(other)}`,
        };
      }
    }
  }

  let restartRequired = false;
  for (const key of Object.keys(applied)) {
    const field = byKey.get(key)!;
    if (field.restart === true && !deepEqual(current[key], applied[key])) {
      restartRequired = true;
    }
  }

  return { ok: true, merged, restartRequired };
}

/** Every account-scope field's default, applied at account creation. */
export function defaultSettings(fields: SettingField[], scope: "proxy" | "account"): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const field of fields) {
    if (field.scope === scope) out[field.key] = field.default;
  }
  return out;
}
