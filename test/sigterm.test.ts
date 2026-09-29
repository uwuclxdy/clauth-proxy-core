import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { KEY_PREFIX } from "../src/index.ts";
import { waitFor } from "./helpers.ts";

const ADMIN_TOKEN = "0".repeat(64);

const procs: { proc: ReturnType<typeof Bun.spawn>; dir: string }[] = [];
const decoder = new TextDecoder();

function spawnServe(opts: { mode: "finish" | "hang" | "pause"; drainSecs: number }): {
  proc: ReturnType<typeof Bun.spawn>;
  dir: string;
  logs(): string;
  port(): Promise<number>;
} {
  const dir = mkdtempSync(join(tmpdir(), "clauth-proxy-core-sigterm-"));
  const tokenFile = join(dir, "admin-token");
  writeFileSync(tokenFile, ADMIN_TOKEN, { mode: 0o600 });
  let logs = "";
  const proc = Bun.spawn(["bun", "test/fixtures/serve.ts", "serve"], {
    env: {
      ...process.env,
      CLAUTH_PROXY_BIND: "127.0.0.1:0",
      CLAUTH_PROXY_STATE_DIR: join(dir, "state"),
      CLAUTH_PROXY_ADMIN_TOKEN_FILE: tokenFile,
      FAKE_MODE: opts.mode,
      FAKE_STEP_MS: "500",
      FAKE_DRAIN_SECS: String(opts.drainSecs),
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  procs.push({ proc, dir });

  const pump = (stream: ReadableStream<Uint8Array>) => {
    void (async () => {
      const reader = stream.getReader();
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        logs += decoder.decode(value, { stream: true });
      }
    })();
  };
  pump(proc.stdout);
  pump(proc.stderr);

  return {
    proc,
    dir,
    logs: () => logs,
    port: async () => {
      await waitFor(() => /listening 127\.0\.0\.1:(\d+)/.test(logs), 5000);
      return Number(/listening 127\.0\.0\.1:(\d+)/.exec(logs)![1]!);
    },
  };
}

async function loginAndGetKey(port: number): Promise<string> {
  const res = await fetch(`http://127.0.0.1:${port}/clauth/v1/accounts/login`, {
    method: "POST",
    headers: { authorization: `Bearer ${ADMIN_TOKEN}`, "content-type": "application/json" },
    body: "{}",
  });
  const start = (await res.json()) as { flow: string };
  let key = "";
  await waitFor(async () => {
    const r = await fetch(`http://127.0.0.1:${port}/clauth/v1/accounts/login/${start.flow}`, {
      headers: { authorization: `Bearer ${ADMIN_TOKEN}` },
    });
    const j = (await r.json()) as { state: string; inference_key?: string };
    if (j.state === "done" && j.inference_key !== undefined) {
      key = j.inference_key;
      return true;
    }
    return false;
  }, 6000);
  return key;
}

async function waitForExitCode(proc: ReturnType<typeof Bun.spawn>, ms: number): Promise<number | null> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (proc.exitCode !== null) return proc.exitCode;
    await new Promise((r) => setTimeout(r, 20));
  }
  return null;
}

afterEach(() => {
  for (const { proc, dir } of procs) {
    if (proc.exitCode === null) {
      try {
        proc.kill("SIGKILL");
      } catch {
        // already gone
      }
    }
    rmSync(dir, { recursive: true, force: true });
  }
  procs.length = 0;
});

describe("SIGTERM drain", () => {
  test("a stream held open mid-SIGTERM finishes intact before exit 0", async () => {
    const { proc, logs, port } = spawnServe({ mode: "finish", drainSecs: 5 });
    const bindPort = await port();

    // /health answers
    await waitFor(async () => {
      try {
        const r = await fetch(`http://127.0.0.1:${bindPort}/health`);
        return r.status === 200;
      } catch {
        return false;
      }
    }, 5000);

    const key = await loginAndGetKey(bindPort);

    const res = await fetch(`http://127.0.0.1:${bindPort}/v1/messages`, {
      method: "POST",
      headers: { "x-api-key": key, "content-type": "application/json" },
      body: JSON.stringify({ model: "x" }),
    });
    const reader = res.body!.getReader();
    const first = await reader.read();
    expect(first.done).toBe(false);

    proc.kill("SIGTERM");

    // /health refuses new connections while the stream drains
    await waitFor(async () => {
      try {
        await fetch(`http://127.0.0.1:${bindPort}/health`);
        return false;
      } catch {
        return true;
      }
    }, 3000);

    // the process is still alive while the stream is open
    expect(proc.exitCode).toBeNull();

    // the final bytes arrive intact; a cut stream leaves the body partial and fails the assertion
    let body = decoder.decode(first.value);
    try {
      while (true) {
        const chunk = await reader.read();
        if (chunk.done) break;
        body += decoder.decode(chunk.value);
      }
    } catch {
      // the connection was reset before the stream ended
    }
    expect(body).toBe("part1part2part3");

    // and the exit comes only after the stream ended
    expect(await waitForExitCode(proc, 3000)).toBe(0);

    // no key or key body ever reached a log line
    const captured = logs();
    expect(captured).not.toContain(key);
    expect(captured).not.toContain(key.slice(KEY_PREFIX.length));
  }, 20000);

  test("a stream that never ends is cut at drain_secs, not a fixed delay", async () => {
    const openHang = async (drainSecs: number) => {
      const s = spawnServe({ mode: "hang", drainSecs });
      const bindPort = await s.port();
      const key = await loginAndGetKey(bindPort);
      const res = await fetch(`http://127.0.0.1:${bindPort}/v1/messages`, {
        method: "POST",
        headers: { "x-api-key": key, "content-type": "application/json" },
        body: JSON.stringify({ model: "x" }),
      });
      const reader = res.body!.getReader();
      const first = await reader.read();
      expect(first.done).toBe(false);
      return s;
    };

    // short budget: alive just before 1 s, gone by 1.5 s (a fixed 1600 ms cut would
    // still be alive at 1.5 s)
    {
      const s = await openHang(1);
      s.proc.kill("SIGTERM");
      await new Promise((r) => setTimeout(r, 700));
      expect(s.proc.exitCode).toBeNull();
      expect(await waitForExitCode(s.proc, 800)).toBe(0);
    }

    // long budget: alive at 2.5 s (a fixed 1600 ms cut would be gone), gone by 4 s
    {
      const s = await openHang(3);
      s.proc.kill("SIGTERM");
      await new Promise((r) => setTimeout(r, 2500));
      expect(s.proc.exitCode).toBeNull();
      expect(await waitForExitCode(s.proc, 1500)).toBe(0);
    }
  }, 30000);
});

describe("stream idle and SSE head", () => {
  test("a stream quiet for 12 s survives (no idle cut)", async () => {
    const { proc, port } = spawnServe({ mode: "pause", drainSecs: 5 });
    const bindPort = await port();
    const key = await loginAndGetKey(bindPort);

    const res = await fetch(`http://127.0.0.1:${bindPort}/v1/messages`, {
      method: "POST",
      headers: { "x-api-key": key, "content-type": "application/json" },
      body: JSON.stringify({ model: "x" }),
    });
    const reader = res.body!.getReader();
    const chunks: Uint8Array[] = [];
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
    }
    expect(chunks.map((c) => decoder.decode(c)).join("")).toBe("part1part2");
    proc.kill("SIGTERM");
    await waitForExitCode(proc, 3000);
  }, 30000);

  test("an event stream sends its head and a first comment at open", async () => {
    const { proc, port } = spawnServe({ mode: "finish", drainSecs: 5 });
    const bindPort = await port();

    const started = Date.now();
    const res = await fetch(`http://127.0.0.1:${bindPort}/clauth/v1/events`, {
      headers: { authorization: `Bearer ${ADMIN_TOKEN}` },
    });
    expect(res.status).toBe(200);
    const reader = res.body!.getReader();
    const first = await reader.read();
    expect(first.done).toBe(false);
    expect(Date.now() - started).toBeLessThan(1000);
    expect(decoder.decode(first.value)).toContain(": ok");
    await reader.cancel();
    proc.kill("SIGTERM");
    await waitForExitCode(proc, 3000);
  }, 20000);
});
