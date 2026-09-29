import { log } from "./log.ts";
import { manifestJson, validateManifest, type FullManifest } from "./manifest.ts";
import { buildServer } from "./server.ts";
import { ensureStateDir, readAdminToken, serve, type EnvContract } from "./serve.ts";
import { AccountStore } from "./store.ts";
import type { ProxyAdapter } from "./types.ts";

export interface Proxy {
  manifest: FullManifest;
  /** Print the manifest JSON to stdout and touch no network or state. */
  printManifest(): void;
  /** Bind and serve per the env contract; blocks the process until SIGTERM drains it. */
  serve(): { hostname: string; port: number };
}

function readEnv(): EnvContract {
  const bind = process.env.CLAUTH_PROXY_BIND;
  const stateDir = process.env.CLAUTH_PROXY_STATE_DIR;
  const adminTokenFile = process.env.CLAUTH_PROXY_ADMIN_TOKEN_FILE;
  if (bind === undefined) throw new Error("CLAUTH_PROXY_BIND is required");
  if (stateDir === undefined) throw new Error("CLAUTH_PROXY_STATE_DIR is required");
  if (adminTokenFile === undefined) throw new Error("CLAUTH_PROXY_ADMIN_TOKEN_FILE is required");
  return { bind, stateDir, adminTokenFile };
}

/** Build the one object a proxy's CLI drives: the validated manifest plus `serve`. */
export function defineProxy(adapter: ProxyAdapter): Proxy {
  const manifest = validateManifest(adapter.manifest);
  return {
    manifest,
    printManifest() {
      process.stdout.write(JSON.stringify(manifestJson(manifest)) + "\n");
    },
    serve() {
      const env = readEnv();
      ensureStateDir(env.stateDir);
      const store = new AccountStore(env.stateDir);
      store.init();
      const adminToken = readAdminToken(env.adminTokenFile);
      const server = buildServer({ adapter, manifest, store, adminToken, stateDir: env.stateDir });
      return serve({ server, env, drainSecs: manifest.drain_secs ?? 0 });
    },
  };
}

/** The proxy's `bin` calls this: `runCli(defineProxy(adapter))`. */
export function runCli(proxy: Proxy): void {
  const cmd = process.argv[2];
  if (cmd === "manifest") {
    proxy.printManifest();
    return;
  }
  if (cmd === "serve") {
    try {
      proxy.serve();
    } catch (err) {
      log.error(err instanceof Error ? err.message : String(err));
      process.exitCode = 1;
    }
    return;
  }
  log.error(`usage: <binary> manifest | serve`);
  process.exitCode = 2;
}
