import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AccountStore, buildServer, validateManifest } from "../src/index.ts";
import { makeFakeAdapter, type FakeAdapterOptions } from "./fake-adapter.ts";

/** 32 bytes as hex, the shape clauth mints into the token file. */
export const ADMIN_TOKEN = "0".repeat(64);

export interface TestServer {
  app: ReturnType<typeof buildServer>["app"];
  store: AccountStore;
  adapter: ReturnType<typeof makeFakeAdapter>["adapter"];
  calls: ReturnType<typeof makeFakeAdapter>["calls"];
  loginState: ReturnType<typeof makeFakeAdapter>["loginState"];
  readState: ReturnType<typeof makeFakeAdapter>["readState"];
  dir: string;
  server: ReturnType<typeof buildServer>;
  manifest: ReturnType<typeof validateManifest>;
  adminToken: string;
}

const created: string[] = [];

export function makeTestServer(opts: FakeAdapterOptions = {}): TestServer {
  const dir = mkdtempSync(join(tmpdir(), "clauth-proxy-core-"));
  created.push(dir);
  const store = new AccountStore(dir);
  store.init();
  const { adapter, calls, loginState, readState } = makeFakeAdapter(opts);
  const manifest = validateManifest(adapter.manifest);
  const server = buildServer({ adapter, manifest, store, adminToken: ADMIN_TOKEN, stateDir: dir });
  return { app: server.app, store, adapter, calls, loginState, readState, dir, server, manifest, adminToken: ADMIN_TOKEN };
}

export function adminHeaders(extra: Record<string, string> = {}): Record<string, string> {
  return { authorization: `Bearer ${ADMIN_TOKEN}`, ...extra };
}

export async function waitFor(fn: () => boolean | Promise<boolean>, timeoutMs = 4000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await fn()) return;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error("waitFor timeout");
}

export function cleanupTestDirs(): void {
  while (created.length > 0) {
    rmSync(created.pop()!, { recursive: true, force: true });
  }
}
