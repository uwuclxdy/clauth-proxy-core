/** The contract this core serves. The major matches the `/clauth/v1` path. */
export const CONTRACT_VERSION = "1.0";
export const CONTRACT_MAJOR = "1";

/** Ids (`account`, `flow`, figure `id`, action `name`, setting `key`) sit in a path segment without percent-encoding. */
export const ID_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/;
/** The `<service>` in `clauth-<service>-proxy`. */
export const SERVICE_RE = /^[a-z0-9][a-z0-9-]{0,31}$/;
export const SEMVER_RE =
  /^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?(\+[0-9A-Za-z.-]+)?$/;

/** The inference-key prefix, so secret scanners and the log redactor spot a key. */
export const KEY_PREFIX = "clp_";
/** 32 bytes -> 43 base64url chars, no padding. */
export const KEY_BODY_LENGTH = 43;
export const KEY_RE = /^clp_[A-Za-z0-9_-]{43}$/;

const ID_ALPHABET = "abcdefghijklmnopqrstuvwxyz0123456789";

export function mintInferenceKey(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return KEY_PREFIX + Buffer.from(bytes).toString("base64url");
}

export function hashKey(key: string): string {
  return Bun.SHA256.hash(key, "hex");
}

function randomToken(length: number): string {
  const bytes = new Uint8Array(length);
  crypto.getRandomValues(bytes);
  let out = "";
  for (let i = 0; i < length; i++) out += ID_ALPHABET[bytes[i]! % ID_ALPHABET.length]!;
  return out;
}

/** A stable, unguessable account id; first char is a letter so it reads as an id. */
export function mintAccountId(): string {
  const token = randomToken(12);
  // first char: a-z only
  return ID_ALPHABET[Math.floor(Math.random() * 26)]! + token.slice(1);
}

/** A poll handle; `f_` + 10 unguessable chars. */
export function mintFlowId(): string {
  return "f_" + randomToken(10);
}

export function nowIso(): string {
  return new Date().toISOString();
}

export function nowEpochMs(): number {
  return Date.now();
}
