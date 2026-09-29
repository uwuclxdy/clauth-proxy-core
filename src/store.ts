import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { hashKey, ID_RE, mintAccountId } from "./contract.ts";
import type { AccountState, AccountView, AdapterBlob, Plan, UpstreamIdentity } from "./types.ts";

/** The record the core persists; the key is stored hash-only and never appears. */
export interface StoredAccount {
  id: string;
  label: string;
  state: AccountState;
  identity: UpstreamIdentity;
  blob: AdapterBlob;
  plans: Plan[];
  settings: Record<string, unknown>;
  created_at: string;
  key_hash: string;
  /** Bumped by each re-bind, so a failure decision made on an older login is a no-op. */
  login_gen: number;
}

/** The wire shape `/accounts` and login `done` serve. */
export interface AccountPublic {
  id: string;
  label: string;
  state: AccountState;
  created_at: string;
  plans: Plan[];
  settings: Record<string, unknown>;
}

export function toPublic(account: StoredAccount): AccountPublic {
  return {
    id: account.id,
    label: account.label,
    state: account.state,
    created_at: account.created_at,
    plans: account.plans,
    settings: account.settings,
  };
}

export function toAdapterView(account: StoredAccount): AccountView {
  return {
    id: account.id,
    label: account.label,
    state: account.state,
    created_at: account.created_at,
    plans: account.plans,
    settings: account.settings,
    blob: account.blob,
  };
}

export class AccountStore {
  /** One in-flight mutation per account id, so a read-modify-write never clobbers a concurrent one. */
  private chains = new Map<string, Promise<void>>();

  constructor(readonly stateDir: string) {}

  private accountsDir(): string {
    return join(this.stateDir, "accounts");
  }

  private file(id: string): string {
    // Second guard behind the router's id validation: a caller that ever passes a
    // non-id (a traversal path) fails here before the join reaches the filesystem.
    if (!ID_RE.test(id)) throw new Error(`refusing non-id account path ${JSON.stringify(id)}`);
    return join(this.accountsDir(), `${id}.json`);
  }

  /** Create the state dir 0700 and the accounts dir 0700; every file below is 0600. */
  init(): void {
    mkdirSync(this.stateDir, { recursive: true, mode: 0o700 });
    chmodSync(this.stateDir, 0o700);
    mkdirSync(this.accountsDir(), { recursive: true, mode: 0o700 });
    chmodSync(this.accountsDir(), 0o700);
  }

  private write(account: StoredAccount): void {
    const target = this.file(account.id);
    const tmp = `${target}.tmp`;
    writeFileSync(tmp, JSON.stringify(account, null, 2), { mode: 0o600 });
    renameSync(tmp, target);
  }

  list(): StoredAccount[] {
    if (!existsSync(this.accountsDir())) return [];
    const out: StoredAccount[] = [];
    for (const entry of readdirSync(this.accountsDir())) {
      if (!entry.endsWith(".json")) continue;
      try {
        const raw = readFileSync(join(this.accountsDir(), entry), "utf8");
        out.push(JSON.parse(raw) as StoredAccount);
      } catch {
        // a torn or foreign file never blocks the store; it stays unread
      }
    }
    out.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    return out;
  }

  get(id: string): StoredAccount | null {
    const file = this.file(id);
    if (!existsSync(file)) return null;
    try {
      return JSON.parse(readFileSync(file, "utf8")) as StoredAccount;
    } catch {
      return null;
    }
  }

  /** Look an account up by a key's SHA-256. O(n) over the few accounts a proxy holds. */
  findByKeyHash(keyHash: string): StoredAccount | null {
    for (const account of this.list()) {
      if (account.key_hash === keyHash) return account;
    }
    return null;
  }

  create(data: {
    label: string;
    state: AccountState;
    identity: UpstreamIdentity;
    blob: AdapterBlob;
    plans: Plan[];
    settings: Record<string, unknown>;
    created_at: string;
    key: string;
  }): StoredAccount {
    const account: StoredAccount = {
      id: mintAccountId(),
      label: data.label,
      state: data.state,
      identity: data.identity,
      blob: data.blob,
      plans: data.plans,
      settings: data.settings,
      created_at: data.created_at,
      key_hash: hashKey(data.key),
      login_gen: 0,
    };
    this.write(account);
    return account;
  }

  update(account: StoredAccount): void {
    this.write(account);
  }

  /**
   * Re-read the record and apply a synchronous field change under this account's
   * serialization. `apply` may throw to abort the write; the error propagates to
   * the caller and the next queued patch still runs. Returns null when the record
   * is gone.
   */
  patch(id: string, apply: (account: StoredAccount) => void): Promise<StoredAccount | null> {
    const previous = this.chains.get(id) ?? Promise.resolve();
    const result = previous.then((): StoredAccount | null => {
      const account = this.get(id);
      if (account === null) return null;
      apply(account);
      this.write(account);
      return account;
    });
    // The chain itself never rejects, whatever a single patch throws.
    this.chains.set(id, result.then(() => undefined, () => undefined));
    return result;
  }

  delete(id: string): void {
    rmSync(this.file(id), { force: true });
  }
}
