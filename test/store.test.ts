import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AccountStore, hashKey, KEY_PREFIX, mintInferenceKey } from "../src/index.ts";

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) out.push(...walk(p));
    else out.push(p);
  }
  return out;
}

function makeStore(): { store: AccountStore; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), "clauth-proxy-core-store-"));
  const store = new AccountStore(dir);
  store.init();
  return { store, dir };
}

describe("inference keys", () => {
  test("a minted key is clp_ + 43 base64url chars", () => {
    expect(mintInferenceKey()).toMatch(/^clp_[A-Za-z0-9_-]{43}$/);
  });

  test("the store holds only the key's hash, never the key bytes", () => {
    const { store, dir } = makeStore();
    const key = mintInferenceKey();
    const keyBody = key.slice(KEY_PREFIX.length);
    store.create({
      label: "kitty@example.com",
      state: "ready",
      identity: "u-1",
      blob: { upstream: "credential" },
      plans: [],
      settings: {},
      created_at: "2026-09-29T10:00:00Z",
      key,
    });

    const raw = walk(dir)
      .map((p) => readFileSync(p).toString("utf8"))
      .join("\n");
    expect(raw).not.toContain(key);
    expect(raw).not.toContain(keyBody);
    expect(raw).toContain(hashKey(key));
    rmSync(dir, { recursive: true, force: true });
  });

  test("re-minting invalidates the old hash at once", () => {
    const { store, dir } = makeStore();
    const key = mintInferenceKey();
    const account = store.create({
      label: "kitty@example.com",
      state: "ready",
      identity: "u-1",
      blob: {},
      plans: [],
      settings: {},
      created_at: "2026-09-29T10:00:00Z",
      key,
    });
    const key2 = mintInferenceKey();
    account.key_hash = hashKey(key2);
    store.update(account);

    expect(store.findByKeyHash(hashKey(key))).toBeNull();
    expect(store.findByKeyHash(hashKey(key2))!.id).toBe(account.id);
    rmSync(dir, { recursive: true, force: true });
  });
});
