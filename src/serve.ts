import { mkdirSync, readFileSync } from "node:fs";
import type { BuiltServer } from "./server.ts";
import { log } from "./log.ts";

export interface EnvContract {
  bind: string;
  stateDir: string;
  adminTokenFile: string;
}

/** `127.0.0.1:<port>` only; a non-loopback host refuses to start, naming the address. */
export function parseBind(bind: string): { hostname: string; port: number } {
  const match = /^(\[[0-9a-fA-F:]+\]|[^:]+):(\d+)$/.exec(bind);
  if (match === null) {
    throw new Error(`CLAUTH_PROXY_BIND must be host:port, got ${JSON.stringify(bind)}`);
  }
  let hostname = match[1]!;
  if (hostname.startsWith("[") && hostname.endsWith("]")) hostname = hostname.slice(1, -1);
  const port = Number(match[2]);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error(`CLAUTH_PROXY_BIND port out of range: ${match[2]}`);
  }
  const loopback = hostname === "127.0.0.1" || hostname === "::1" || hostname === "localhost";
  if (!loopback) {
    throw new Error(`CLAUTH_PROXY_BIND must be loopback-only, refused ${hostname}`);
  }
  return { hostname, port };
}

export function readAdminToken(adminTokenFile: string): string {
  return readFileSync(adminTokenFile, "utf8").trim();
}

export interface ServeOptions {
  server: BuiltServer;
  env: EnvContract;
  drainSecs?: number;
  hostname?: string;
  port?: number;
  signals?: NodeJS.Signals[];
  processExit?: (code: number) => void;
}

/**
 * Bind the app, then handle SIGTERM: close the listener first, let open streams
 * finish up to `drainSecs`, then exit 0. The drain rides `server.stop(false)`'s
 * own promise, which resolves only once the connections have flushed their final
 * bytes, so a stream cut only happens when the budget expires.
 */
export function serve(opts: ServeOptions): { hostname: string; port: number } {
  const { server, env, drainSecs = 0, signals = ["SIGTERM", "SIGINT"] } = opts;
  const bind = opts.hostname !== undefined && opts.port !== undefined
    ? { hostname: opts.hostname, port: opts.port }
    : parseBind(env.bind);

  const bunServer = Bun.serve({
    hostname: bind.hostname,
    port: bind.port,
    // No idle cut on a live stream: an inference stream or the SSE feed can sit
    // quiet for minutes (an off-peak queue wait); SIGTERM's drain budget still
    // bounds shutdown.
    idleTimeout: 0,
    fetch(req) {
      return server.app.fetch(req);
    },
  });

  const hostname = bunServer.hostname ?? bind.hostname;
  const port = bunServer.port ?? bind.port;
  log.info(`listening ${hostname}:${port}`);
  server.usage.start();
  server.flows.sweepLoop();

  let shuttingDown = false;
  const exit = opts.processExit ?? ((code: number) => process.exit(code));

  const shutdown = () => {
    if (shuttingDown) return;
    shuttingDown = true;
    // close SSE streams and clear the poll timers first, so neither holds the drain open
    server.close();
    // close the listener and let open connections flush; resolves when they drain
    const stopPromise = bunServer.stop(false);
    const timer = setTimeout(() => {
      exit(0);
    }, drainSecs * 1000);
    void stopPromise.then(() => {
      clearTimeout(timer);
      exit(0);
    });
  };

  for (const sig of signals) {
    process.on(sig, shutdown);
  }

  return { hostname, port };
}

export function ensureStateDir(stateDir: string): void {
  mkdirSync(stateDir, { recursive: true, mode: 0o700 });
}
