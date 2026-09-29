import { nowEpochMs } from "./contract.ts";
import { errorClass, log } from "./log.ts";
import { CHAIN_WINDOW_SECS, type FullManifest } from "./manifest.ts";
import { FigureSchema, type UsageAccountSchema } from "./schemas.ts";
import { AccountStore, toAdapterView, toPublic, type StoredAccount } from "./store.ts";
import { AdapterError, type FigureDeclaration, type ProxyAdapter, type StaleReason } from "./types.ts";
import type { z } from "zod";

export type Figure = z.infer<typeof FigureSchema>;
export type UsageAccount = z.infer<typeof UsageAccountSchema>;

/**
 * Why a figure would be dropped, or null when it is valid. One source of truth
 * for {@link validateFigure} and the drop log in {@link validateFigures}.
 */
export function figureDropReason(raw: unknown, declared: FigureDeclaration[]): string | null {
  if (typeof raw !== "object" || raw === null) return "not an object";
  const obj = raw as Record<string, unknown>;
  const id = typeof obj.id === "string" ? obj.id : "<no id>";
  // `chain` is valid on `window` only.
  if (obj.kind !== "window" && "chain" in obj) return `figure "${id}": chain on a non-window figure`;
  const parsed = FigureSchema.safeParse(raw);
  if (!parsed.success) return `figure "${id}": invalid shape`;
  const figure = parsed.data;
  const decl = declared.find((d) => d.id === figure.id);
  if (decl === undefined) return `figure "${id}": not declared`;
  if (decl.kind !== figure.kind) return `figure "${id}": kind mismatch (declared ${decl.kind})`;
  if (figure.kind === "window") {
    if (decl.chain !== undefined) {
      if (figure.chain !== decl.chain) return `figure "${id}": chain mismatch (declared ${decl.chain})`;
      if (figure.window_secs !== CHAIN_WINDOW_SECS[decl.chain]) {
        return `figure "${id}": window_secs ${figure.window_secs}, expected ${CHAIN_WINDOW_SECS[decl.chain]} for chain ${decl.chain}`;
      }
    } else if (figure.chain !== undefined && figure.chain !== null) {
      // a role the proxy never declared
      return `figure "${id}": chain on an undeclared role`;
    }
  }
  return null;
}

/** Validate one adapter figure against `/info.figures` and the kind rules. */
export function validateFigure(raw: unknown, declared: FigureDeclaration[]): Figure | null {
  return figureDropReason(raw, declared) === null ? (FigureSchema.parse(raw) as Figure) : null;
}

export function validateFigures(raw: unknown, declared: FigureDeclaration[]): Figure[] {
  if (!Array.isArray(raw)) throw new Error("adapter figures must be an array");
  const out: Figure[] = [];
  const seen = new Set<string>();
  for (const item of raw) {
    const reason = figureDropReason(item, declared);
    if (reason !== null) {
      log.error(`usage: dropped ${reason}`);
      continue;
    }
    const figure = FigureSchema.parse(item) as Figure;
    if (seen.has(figure.id)) {
      log.error(`usage: dropped figure "${figure.id}": duplicate id`);
      continue;
    }
    seen.add(figure.id);
    out.push(figure);
  }
  return out;
}

function staleReason(err: unknown): StaleReason {
  if (err instanceof AdapterError) {
    if (err.reason === "rate_limited") return "rate_limited";
    if (err.reason === "login_required") return "login_required";
  }
  return "upstream_unavailable";
}

interface CacheEntry {
  figures: Figure[];
}

export class UsageCache {
  private cache = new Map<string, CacheEntry>();
  private pollTimer?: ReturnType<typeof setInterval>;
  private inFlight = new Set<string>();

  constructor(
    private readonly adapter: ProxyAdapter,
    private readonly manifest: FullManifest,
    private readonly store: AccountStore,
    private readonly onUsage: (account: UsageAccount) => void,
    private readonly onAccount: (account: ReturnType<typeof toPublic>) => void,
    private readonly nowMs: () => number = nowEpochMs,
  ) {}

  /** Poll every account at the adapter's declared cadence. */
  start(): void {
    this.pollTimer = setInterval(() => {
      void this.pollAll();
    }, this.manifest.usage_cadence_ms);
  }

  async pollAll(): Promise<void> {
    for (const account of this.store.list()) {
      if (account.state === "ready") {
        try {
          await this.pollOne(account);
        } catch (err) {
          // a store write or validation failure on one account never rejects the loop
          log.error(`usage: poll of ${account.id} failed (${errorClass(err)})`);
        }
      }
    }
  }

  async pollOne(account: StoredAccount): Promise<UsageAccount | null> {
    if (this.inFlight.has(account.id)) {
      return this.buildPayload(account, this.cache.get(account.id) ?? { figures: [] });
    }
    this.inFlight.add(account.id);
    const usedLoginGen = account.login_gen ?? 0;
    try {
      const raw = await this.adapter.readFigures({
        accountId: account.id,
        account: toAdapterView(account),
      });
      // a read that finished after the account was deleted caches nothing and
      // publishes nothing for the dead account
      if (this.store.get(account.id) === null) return null;
      const figures = validateFigures(raw, this.manifest.figures);
      // a successful read that omits a figure keeps that figure's last good value,
      // marked stale: its data is unavailable upstream this round
      const previous = this.cache.get(account.id);
      const freshIds = new Set(figures.map((f) => f.id));
      const carried = (previous?.figures ?? [])
        .filter((f) => !freshIds.has(f.id))
        .map((f) => ({ ...f, stale_reason: "upstream_unavailable" as const }));
      this.cache.set(account.id, { figures: [...figures, ...carried] });
    } catch (err) {
      // same guard on the failure path: a stale failure after the delete neither
      // flips state nor caches nor publishes for the dead account
      if (this.store.get(account.id) === null) return null;
      const reason = staleReason(err);
      if (err instanceof AdapterError && (err.reason === "login_required" || err.reason === "suspended")) {
        const state = err.reason;
        // re-read and flip only the state field inside the account's serialization,
        // so this write never revives a key a concurrent re-mint already replaced,
        // and never flips an account whose login was re-bound while the read was in
        // flight (the read's credential is no longer the account's current one)
        try {
          let flipped = false;
          const updated = await this.store.patch(account.id, (current) => {
            if ((current.login_gen ?? 0) === usedLoginGen && current.state !== state) {
              current.state = state;
              flipped = true;
            }
          });
          if (updated !== null) {
            account = updated;
            if (flipped) this.onAccount(toPublic(updated));
          }
        } catch (writeErr) {
          log.error(`usage: state write for ${account.id} failed (${errorClass(writeErr)})`);
        }
      }
      const existing = this.cache.get(account.id);
      if (existing !== undefined) {
        existing.figures = existing.figures.map((f) => ({ ...f, stale_reason: reason }));
      } else {
        this.cache.set(account.id, { figures: [] });
      }
    } finally {
      this.inFlight.delete(account.id);
    }
    const payload = this.buildPayload(account, this.cache.get(account.id) ?? { figures: [] });
    this.onUsage(payload);
    return payload;
  }

  private buildPayload(account: StoredAccount, entry: CacheEntry): UsageAccount {
    return {
      account: account.id,
      state: account.state,
      available: account.state === "ready",
      figures: entry.figures,
    };
  }

  payload(accountId: string): UsageAccount | null {
    const account = this.store.get(accountId);
    if (account === null) return null;
    const entry = this.cache.get(accountId) ?? { figures: [] };
    return {
      account: account.id,
      state: account.state,
      available: account.state === "ready",
      figures: entry.figures,
    };
  }

  all(): UsageAccount[] {
    const out: UsageAccount[] = [];
    for (const account of this.store.list()) {
      const payload = this.payload(account.id);
      if (payload !== null) out.push(payload);
    }
    return out;
  }

  /** Drop an account's cached figures, called when the account is deleted. */
  drop(accountId: string): void {
    this.cache.delete(accountId);
  }

  close(): void {
    if (this.pollTimer !== undefined) clearInterval(this.pollTimer);
  }
}
