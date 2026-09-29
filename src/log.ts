import { KEY_RE } from "./contract.ts";

/**
 * The proxy's log line, redacted. Keys (`clp_…`) are replaced by a placeholder, and
 * a long hex token (an admin token shape) is redacted too, so neither ever reaches a
 * log even when a caller interpolates one by mistake.
 */
export function redact(value: string): string {
  return value.replace(KEY_RE, "clp_[redacted]").replace(/\b[0-9a-f]{64}\b/g, "[redacted]");
}

export function logLine(stream: "stdout" | "stderr", value: string): void {
  const safe = redact(value);
  if (stream === "stderr") {
    process.stderr.write(safe + "\n");
  } else {
    process.stdout.write(safe + "\n");
  }
}

/** The error's class name only; never its message, which may carry upstream bytes. */
export function errorClass(err: unknown): string {
  if (err instanceof Error) return err.constructor.name;
  return typeof err === "string" ? "String" : "UnknownError";
}

export const log = {
  info(value: string): void {
    logLine("stdout", value);
  },
  error(value: string): void {
    logLine("stderr", value);
  },
};
