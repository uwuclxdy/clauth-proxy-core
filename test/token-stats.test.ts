import { afterEach, describe, expect, test } from "bun:test";
import { CONTRACT_VERSION, type ForwardContext, type TokenRecord, type TokenRecords } from "../src/index.ts";
import { tapTokenStats } from "../src/tokens.ts";
import { adminHeaders, cleanupTestDirs, makeTestServer, waitFor } from "./helpers.ts";

const servers: ReturnType<typeof makeTestServer>[] = [];

function ts(opts: Parameters<typeof makeTestServer>[0] = {}): ReturnType<typeof makeTestServer> {
  const s = makeTestServer(opts);
  servers.push(s);
  return s;
}

afterEach(() => {
  for (const s of servers) s.server.close();
  servers.length = 0;
  cleanupTestDirs();
});

const enc = new TextEncoder();
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function login(s: ReturnType<typeof makeTestServer>): Promise<{ id: string; key: string }> {
  const res = await s.app.request("/clauth/v1/accounts/login", { method: "POST", headers: adminHeaders(), body: "{}" });
  const { flow } = (await res.json()) as { flow: string };
  let done: { account: { id: string }; inference_key: string } | undefined;
  await waitFor(async () => {
    const r = await s.app.request(`/clauth/v1/accounts/login/${flow}`, { headers: adminHeaders() });
    const j = (await r.json()) as { state: string; account?: { id: string }; inference_key?: string };
    if (j.state === "done") done = j as { account: { id: string }; inference_key: string };
    return j.state === "done";
  });
  return { id: done!.account.id, key: done!.inference_key };
}

function sse(name: string, data: unknown): string {
  return `event: ${name}\ndata: ${JSON.stringify(data)}\n\n`;
}

const MESSAGE_START = sse("message_start", {
  type: "message_start",
  message: {
    id: "msg_01TokenStats",
    type: "message",
    role: "assistant",
    model: "glm-5.3",
    content: [],
    stop_reason: null,
    usage: { input_tokens: 12, output_tokens: 1 },
  },
});
const BLOCK_START = sse("content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } });
const DELTA = sse("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "hi" } });
const BLOCK_STOP = sse("content_block_stop", { type: "content_block_stop", index: 0 });
const MESSAGE_DELTA = sse("message_delta", {
  type: "message_delta",
  delta: { stop_reason: "end_turn", stop_sequence: null },
  usage: { output_tokens: 1450 },
});
const MESSAGE_STOP = sse("message_stop", { type: "message_stop" });
const PING = sse("ping", { type: "ping" });

const FULL_STREAM = [MESSAGE_START, BLOCK_START, DELTA, BLOCK_STOP, MESSAGE_DELTA, MESSAGE_STOP];

function sseResponse(chunks: string[], status = 200): Response {
  return new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        for (const c of chunks) controller.enqueue(enc.encode(c));
        controller.close();
      },
    }),
    { status, headers: { "content-type": "text/event-stream" } },
  );
}

const JSON_MESSAGE = {
  id: "msg_01JsonStats",
  type: "message",
  role: "assistant",
  model: "glm-5.3",
  content: [{ type: "text", text: "hi" }],
  stop_reason: "end_turn",
  usage: { input_tokens: 12, output_tokens: 77 },
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

async function tokens(s: ReturnType<typeof makeTestServer>, since?: string): Promise<TokenRecords> {
  const q = since === undefined ? "" : `?since=${encodeURIComponent(since)}`;
  const res = await s.app.request(`/clauth/v1/tokens${q}`, { headers: adminHeaders() });
  expect(res.status).toBe(200);
  return (await res.json()) as TokenRecords;
}

async function infer(s: ReturnType<typeof makeTestServer>, key: string, path = "/v1/messages"): Promise<Response> {
  return s.app.request(path, { method: "POST", headers: { "x-api-key": key }, body: JSON.stringify({ stream: true }) });
}

function numberedJson(): () => Response {
  let n = 0;
  return () => jsonResponse({ ...JSON_MESSAGE, id: `msg_${++n}` });
}

const RFC3339 = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/;

describe("token stats: contract", () => {
  test("the core serves contract 1.2", () => {
    expect(CONTRACT_VERSION).toBe("1.2");
  });

  test("GET /tokens without the token_stats capability is 501 unsupported", async () => {
    const s = ts({ capabilities: ["events"] });
    const res = await s.app.request("/clauth/v1/tokens", { headers: adminHeaders() });
    expect(res.status).toBe(501);
    expect(await res.json()).toEqual({ ok: false, error: "unsupported" });
  });

  test("GET /tokens requires the admin token", async () => {
    const s = ts({ capabilities: ["token_stats"] });
    const res = await s.app.request("/clauth/v1/tokens", { headers: { authorization: "Bearer " + "f".repeat(64) } });
    expect(res.status).toBe(401);
  });

  test("GET /tokens with no records answers an empty list and a cursor, no dropped flag", async () => {
    const s = ts({ capabilities: ["token_stats"] });
    const body = await tokens(s);
    expect(body.records).toEqual([]);
    expect(typeof body.cursor).toBe("string");
    expect(body.cursor.length).toBeGreaterThan(0);
    expect(Object.keys(body).sort()).toEqual(["cursor", "records"]);
  });
});

describe("token stats: recording", () => {
  test("a streamed response yields one record with the client-visible id, and its bytes pass unchanged", async () => {
    let forwardAt = 0;
    const s = ts({
      capabilities: ["token_stats"],
      forward: () => {
        forwardAt = Date.now();
        return sseResponse(FULL_STREAM);
      },
    });
    const { id, key } = await login(s);
    const res = await infer(s, key);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe(FULL_STREAM.join(""));

    const body = await tokens(s);
    expect(body.records).toHaveLength(1);
    const r = body.records[0]!;
    expect(Object.keys(r).sort()).toEqual(["account", "ended_at", "id", "model", "output_tokens", "started_at", "ttft_ms"]);
    expect(r.id).toBe("msg_01TokenStats");
    expect(r.account).toBe(id);
    expect(r.model).toBe("glm-5.3");
    expect(r.output_tokens).toBe(1450);
    expect(r.started_at).toMatch(RFC3339);
    expect(r.ended_at).toMatch(RFC3339);
    expect(Date.parse(r.started_at)).toBeLessThanOrEqual(forwardAt);
    expect(Date.parse(r.started_at)).toBeLessThanOrEqual(Date.parse(r.ended_at));
    expect(Number.isInteger(r.ttft_ms)).toBe(true);
    expect(r.ttft_ms!).toBeGreaterThanOrEqual(0);
  }, 15000);

  test("ttft_ms runs from request receipt to the first content_block_delta; ended_at is message_stop, not stream close", async () => {
    let stopSentAt = 0;
    const s = ts({
      capabilities: ["token_stats"],
      forward: () =>
        new Response(
          new ReadableStream<Uint8Array>({
            async start(controller) {
              controller.enqueue(enc.encode(MESSAGE_START + BLOCK_START));
              await sleep(120);
              controller.enqueue(enc.encode(DELTA));
              await sleep(120);
              controller.enqueue(enc.encode(BLOCK_STOP + MESSAGE_DELTA + MESSAGE_STOP));
              stopSentAt = Date.now();
              await sleep(400);
              controller.enqueue(enc.encode(PING));
              controller.close();
            },
          }),
          { headers: { "content-type": "text/event-stream" } },
        ),
    });
    const { key } = await login(s);
    await (await infer(s, key)).text();
    const [r] = (await tokens(s)).records;
    expect(r).toBeDefined();
    expect(r!.ttft_ms!).toBeGreaterThanOrEqual(100);
    expect(r!.ttft_ms!).toBeLessThan(400);
    const span = Date.parse(r!.ended_at) - Date.parse(r!.started_at);
    expect(span).toBeGreaterThanOrEqual(220);
    // the fixture waits 120 ms between the first delta and message_stop: a stop-time ttft leaves no gap
    expect(span - r!.ttft_ms!).toBeGreaterThanOrEqual(80);
    // the trailing 400 ms after message_stop is outside the span
    expect(Date.parse(r!.ended_at)).toBeLessThan(stopSentAt + 200);
  }, 15000);

  test("a wall-clock step back mid-stream leaves ttft_ms and the span non-negative", async () => {
    const realNow = Date.now;
    const s = ts({
      capabilities: ["token_stats"],
      forward: () =>
        new Response(
          new ReadableStream<Uint8Array>({
            async start(controller) {
              controller.enqueue(enc.encode(MESSAGE_START + BLOCK_START));
              await sleep(60);
              const stepped = realNow.call(Date) - 5000;
              const steppedAt = performance.now();
              Date.now = () => stepped + (performance.now() - steppedAt);
              for (const c of FULL_STREAM.slice(2)) controller.enqueue(enc.encode(c));
              controller.close();
            },
          }),
          { headers: { "content-type": "text/event-stream" } },
        ),
    });
    const { key } = await login(s);
    try {
      await (await infer(s, key)).text();
    } finally {
      Date.now = realNow;
    }
    const [r] = (await tokens(s)).records;
    expect(r).toBeDefined();
    expect(r!.ttft_ms!).toBeGreaterThanOrEqual(50);
    expect(Date.parse(r!.ended_at) - Date.parse(r!.started_at)).toBeGreaterThanOrEqual(50);
  }, 15000);

  test("a wall-clock step back mid-body leaves a JSON record's span non-negative", async () => {
    const realNow = Date.now;
    const body = JSON.stringify(JSON_MESSAGE);
    const s = ts({
      capabilities: ["token_stats"],
      forward: () =>
        new Response(
          new ReadableStream<Uint8Array>({
            async start(controller) {
              controller.enqueue(enc.encode(body.slice(0, 20)));
              await sleep(60);
              const stepped = realNow.call(Date) - 5000;
              const steppedAt = performance.now();
              Date.now = () => stepped + (performance.now() - steppedAt);
              controller.enqueue(enc.encode(body.slice(20)));
              controller.close();
            },
          }),
          { headers: { "content-type": "application/json" } },
        ),
    });
    const { key } = await login(s);
    try {
      await (await infer(s, key)).text();
    } finally {
      Date.now = realNow;
    }
    const [r] = (await tokens(s)).records;
    expect(r).toBeDefined();
    expect(Date.parse(r!.ended_at) - Date.parse(r!.started_at)).toBeGreaterThanOrEqual(50);
  }, 15000);

  test("started_at is taken before the request body is read", async () => {
    const s = ts({ capabilities: ["token_stats"], forward: () => sseResponse(FULL_STREAM) });
    const { key } = await login(s);
    const body = new ReadableStream<Uint8Array>({
      async start(controller) {
        controller.enqueue(enc.encode('{"stream":'));
        await sleep(150);
        controller.enqueue(enc.encode("true}"));
        controller.close();
      },
    });
    const sentAt = Date.now();
    const res = await s.app.request("/v1/messages", {
      method: "POST",
      headers: { "x-api-key": key },
      body,
      duplex: "half",
    } as RequestInit);
    await res.text();
    const [r] = (await tokens(s)).records;
    expect(r).toBeDefined();
    expect(Date.parse(r!.started_at) - sentAt).toBeLessThan(100);
    expect(r!.ttft_ms!).toBeGreaterThanOrEqual(140);
    expect(Date.parse(r!.ended_at) - Date.parse(r!.started_at)).toBeGreaterThanOrEqual(140);
  }, 15000);

  test("the tap streams through: the client reads the first chunk before the adapter finishes", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const s = ts({
      capabilities: ["token_stats"],
      forward: () =>
        new Response(
          new ReadableStream<Uint8Array>({
            async start(controller) {
              controller.enqueue(enc.encode(MESSAGE_START));
              await gate;
              for (const c of FULL_STREAM.slice(1)) controller.enqueue(enc.encode(c));
              controller.close();
            },
          }),
          { headers: { "content-type": "text/event-stream" } },
        ),
    });
    const { key } = await login(s);
    const res = await infer(s, key);
    const reader = res.body!.getReader();
    const first = await Promise.race([reader.read(), sleep(2000).then(() => "timeout" as const)]);
    expect(first).not.toBe("timeout");
    release();
    while (!(await reader.read()).done) {
      // drain
    }
    expect((await tokens(s)).records).toHaveLength(1);
  }, 15000);

  test("an SSE stream split at every character still yields one record", async () => {
    const whole = FULL_STREAM.join("");
    const s = ts({ capabilities: ["token_stats"], forward: () => sseResponse([...whole]) });
    const { key } = await login(s);
    expect(await (await infer(s, key)).text()).toBe(whole);
    const { records } = await tokens(s);
    expect(records).toHaveLength(1);
    expect(records[0]!.output_tokens).toBe(1450);
  }, 15000);

  test("a multi-byte character split across chunks decodes intact", async () => {
    const start = sse("message_start", {
      type: "message_start",
      message: { id: "msg_01ŻółćStats", model: "glm-5.3", usage: { output_tokens: 1 } },
    });
    const bytes = enc.encode([start, DELTA, MESSAGE_DELTA, MESSAGE_STOP].join(""));
    const s = ts({
      capabilities: ["token_stats"],
      forward: () =>
        new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              for (const b of bytes) controller.enqueue(new Uint8Array([b]));
              controller.close();
            },
          }),
          { headers: { "content-type": "text/event-stream" } },
        ),
    });
    const { key } = await login(s);
    await (await infer(s, key)).text();
    const { records } = await tokens(s);
    expect(records.map((r) => r.id)).toEqual(["msg_01ŻółćStats"]);
  }, 15000);

  test("CRLF line endings parse like LF", async () => {
    const crlf = FULL_STREAM.join("").replaceAll("\n", "\r\n");
    const s = ts({ capabilities: ["token_stats"], forward: () => sseResponse([crlf]) });
    const { key } = await login(s);
    await (await infer(s, key)).text();
    const { records } = await tokens(s);
    expect(records.map((r) => r.id)).toEqual(["msg_01TokenStats"]);
  }, 15000);

  test("a stream without message_delta makes no record", async () => {
    const s = ts({
      capabilities: ["token_stats"],
      forward: () => sseResponse([MESSAGE_START, BLOCK_START, DELTA, BLOCK_STOP, MESSAGE_STOP]),
    });
    const { key } = await login(s);
    await (await infer(s, key)).text();
    expect((await tokens(s)).records).toEqual([]);
  }, 15000);

  test("a stream that ends after message_delta without message_stop makes no record", async () => {
    const s = ts({
      capabilities: ["token_stats"],
      forward: () => sseResponse([MESSAGE_START, DELTA, MESSAGE_DELTA]),
    });
    const { key } = await login(s);
    await (await infer(s, key)).text();
    expect((await tokens(s)).records).toEqual([]);
  }, 15000);

  test("a stream the client cancels before message_delta makes no record", async () => {
    const s = ts({
      capabilities: ["token_stats"],
      forward: () =>
        new Response(
          new ReadableStream<Uint8Array>({
            async start(controller) {
              controller.enqueue(enc.encode(MESSAGE_START + BLOCK_START + DELTA));
              await sleep(300);
              try {
                controller.enqueue(enc.encode(BLOCK_STOP + MESSAGE_DELTA + MESSAGE_STOP));
                controller.close();
              } catch {
                // cancelled downstream
              }
            },
          }),
          { headers: { "content-type": "text/event-stream" } },
        ),
    });
    const { key } = await login(s);
    const reader = (await infer(s, key)).body!.getReader();
    await reader.read();
    await reader.cancel();
    await sleep(500);
    expect((await tokens(s)).records).toEqual([]);
  }, 15000);

  test("malformed SSE passes through byte-identical and makes no record", async () => {
    const junk = "event: message_start\ndata: {not json\n\nevent: message_delta\ndata: []\n\nevent: message_stop\ndata: {}\n\n";
    const s = ts({ capabilities: ["token_stats"], forward: () => sseResponse([junk]) });
    const { key } = await login(s);
    expect(await (await infer(s, key)).text()).toBe(junk);
    expect((await tokens(s)).records).toEqual([]);
  }, 15000);

  test("a missing id, or a non-integer or negative output_tokens, makes no record", async () => {
    const delta = (n: unknown) =>
      sse("message_delta", { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: n } });
    const noId = sse("message_start", { type: "message_start", message: { model: "glm-5.3", usage: { output_tokens: 1 } } });
    const variants = [
      [MESSAGE_START, DELTA, delta(1.5), MESSAGE_STOP],
      [MESSAGE_START, DELTA, delta(-1), MESSAGE_STOP],
      [MESSAGE_START, DELTA, delta("12"), MESSAGE_STOP],
      [MESSAGE_START, DELTA, delta(null), MESSAGE_STOP],
      [noId, DELTA, MESSAGE_DELTA, MESSAGE_STOP],
    ];
    let call = 0;
    const s = ts({ capabilities: ["token_stats"], forward: () => sseResponse(variants[call++]!) });
    const { key } = await login(s);
    for (let i = 0; i < variants.length; i++) await (await infer(s, key)).text();
    expect(call).toBe(variants.length);
    expect((await tokens(s)).records).toEqual([]);
  }, 15000);

  test("a non-streamed JSON response with usage yields one record without ttft_ms", async () => {
    const s = ts({ capabilities: ["token_stats"], forward: () => jsonResponse(JSON_MESSAGE) });
    const { id, key } = await login(s);
    expect(await (await infer(s, key)).json()).toEqual(JSON_MESSAGE);
    const { records } = await tokens(s);
    expect(records).toHaveLength(1);
    const r = records[0]!;
    expect(Object.keys(r).sort()).toEqual(["account", "ended_at", "id", "model", "output_tokens", "started_at"]);
    expect(r.id).toBe("msg_01JsonStats");
    expect(r.account).toBe(id);
    expect(r.model).toBe("glm-5.3");
    expect(r.output_tokens).toBe(77);
  }, 15000);

  test("count_tokens never makes a record", async () => {
    const s = ts({
      capabilities: ["token_stats", "count_tokens"],
      forward: (ctx: ForwardContext) => (ctx.route === "count_tokens" ? jsonResponse(JSON_MESSAGE) : jsonResponse({})),
    });
    const { key } = await login(s);
    const res = await infer(s, key, "/v1/messages/count_tokens");
    expect(res.status).toBe(200);
    await res.text();
    expect((await tokens(s)).records).toEqual([]);
  }, 15000);

  test("a non-2xx response makes no record, even carrying usage", async () => {
    const s = ts({
      capabilities: ["token_stats"],
      forward: () => jsonResponse({ ...JSON_MESSAGE, type: "error", error: { type: "overloaded_error", message: "x" } }, 529),
    });
    const { key } = await login(s);
    const res = await infer(s, key);
    expect(res.status).toBe(529);
    await res.text();
    expect((await tokens(s)).records).toEqual([]);
  }, 15000);

  test("a 3xx response makes no record, even carrying usage", async () => {
    const s = ts({ capabilities: ["token_stats"], forward: () => jsonResponse(JSON_MESSAGE, 302) });
    const { key } = await login(s);
    const res = await infer(s, key);
    expect(res.status).toBe(302);
    await res.text();
    expect((await tokens(s)).records).toEqual([]);
  }, 15000);

  test("without the capability the forwarded stream still passes unchanged", async () => {
    const s = ts({ capabilities: ["events"], forward: () => sseResponse(FULL_STREAM) });
    const { key } = await login(s);
    expect(await (await infer(s, key)).text()).toBe(FULL_STREAM.join(""));
  }, 15000);
});

describe("token stats: cursor and retention", () => {
  test("since=<cursor> returns only newer records; the cursor names the newest", async () => {
    const s = ts({ capabilities: ["token_stats"], forward: numberedJson() });
    const { key } = await login(s);
    await (await infer(s, key)).text();
    await (await infer(s, key)).text();
    const first = await tokens(s);
    expect(first.records.map((r) => r.id)).toEqual(["msg_1", "msg_2"]);
    expect(first.dropped).toBeUndefined();

    const empty = await tokens(s, first.cursor);
    expect(empty.records).toEqual([]);
    expect(empty.cursor).toBe(first.cursor);
    expect(empty.dropped).toBeUndefined();

    await (await infer(s, key)).text();
    const next = await tokens(s, first.cursor);
    expect(next.records.map((r) => r.id)).toEqual(["msg_3"]);
    expect(next.cursor).not.toBe(first.cursor);
    expect(next.dropped).toBeUndefined();
  }, 15000);

  test("the empty-ring cursor is known: records landing after it come back without dropped", async () => {
    const s = ts({ capabilities: ["token_stats"], forward: numberedJson() });
    const { key } = await login(s);
    const before = (await tokens(s)).cursor;
    await (await infer(s, key)).text();
    const body = await tokens(s, before);
    expect(body.records.map((r) => r.id)).toEqual(["msg_1"]);
    expect(body.dropped).toBeUndefined();
  }, 15000);

  test("an unknown cursor returns every retained record with dropped: true", async () => {
    const s = ts({ capabilities: ["token_stats"], forward: numberedJson() });
    const { key } = await login(s);
    await (await infer(s, key)).text();
    const body = await tokens(s, "not-a-cursor-from-this-proxy");
    expect(body.records.map((r) => r.id)).toEqual(["msg_1"]);
    expect(body.dropped).toBe(true);
  }, 15000);

  test("a cursor from a previous proxy life reads as unknown", async () => {
    const a = ts({ capabilities: ["token_stats"], forward: numberedJson() });
    const ka = await login(a);
    await (await infer(a, ka.key)).text();
    const oldCursor = (await tokens(a)).cursor;

    const b = ts({ capabilities: ["token_stats"], forward: numberedJson() });
    const kb = await login(b);
    await (await infer(b, kb.key)).text();
    await (await infer(b, kb.key)).text();
    const body = await tokens(b, oldCursor);
    expect(body.records.map((r) => r.id)).toEqual(["msg_1", "msg_2"]);
    expect(body.dropped).toBe(true);
  }, 15000);

  test("the ring keeps the newest 1024; a cursor stays known until a record after it is evicted", async () => {
    const s = ts({ capabilities: ["token_stats"], forward: numberedJson() });
    const { key } = await login(s);
    await (await infer(s, key)).text();
    const afterFirst = (await tokens(s)).cursor;
    for (let i = 0; i < 1024; i++) await (await infer(s, key)).text();
    // ring holds msg_2..msg_1025: every record after the cursor is still retained
    const edge = await tokens(s, afterFirst);
    expect(edge.records).toHaveLength(1024);
    expect(edge.records[0]!.id).toBe("msg_2");
    expect(edge.dropped).toBeUndefined();

    await (await infer(s, key)).text();
    // ring holds msg_3..msg_1026: msg_2 is gone
    const stale = await tokens(s, afterFirst);
    expect(stale.dropped).toBe(true);
    expect(stale.records).toHaveLength(1024);
    expect(stale.records[0]!.id).toBe("msg_3");
    expect(stale.records.at(-1)!.id).toBe("msg_1026");
  }, 90000);
});

describe("token stats: parser edges", () => {
  async function recordsFor(chunks: string[] | Response, capabilities = ["token_stats"]): Promise<{ text: string; records: TokenRecord[] }> {
    const s = ts({ capabilities, forward: () => (Array.isArray(chunks) ? sseResponse(chunks) : chunks) });
    const { key } = await login(s);
    const text = await (await infer(s, key)).text();
    return { text, records: (await tokens(s)).records };
  }

  test("a later message_delta overrides an earlier one", async () => {
    const delta = (n: number) => sse("message_delta", { type: "message_delta", usage: { output_tokens: n } });
    const { records } = await recordsFor([MESSAGE_START, DELTA, delta(10), delta(20), MESSAGE_STOP]);
    expect(records.map((r) => r.output_tokens)).toEqual([20]);
  }, 15000);

  test("a second message_stop makes no second record and no second token event", async () => {
    const s = ts({ capabilities: ["events", "token_stats"], forward: () => sseResponse([...FULL_STREAM, MESSAGE_STOP]) });
    const events: string[] = [];
    s.server.events.subscribe((name) => events.push(name));
    const { key } = await login(s);
    await (await infer(s, key)).text();
    expect((await tokens(s)).records).toHaveLength(1);
    expect(events.filter((e) => e === "token")).toHaveLength(1);
  }, 15000);

  test("a second message_start keeps the first message's id and model", async () => {
    const second = sse("message_start", {
      type: "message_start",
      message: { id: "msg_02Spliced", model: "other-model", usage: { output_tokens: 1 } },
    });
    const { records } = await recordsFor([MESSAGE_START, DELTA, second, MESSAGE_DELTA, MESSAGE_STOP]);
    expect(records.map((r) => [r.id, r.model, r.output_tokens])).toEqual([["msg_01TokenStats", "glm-5.3", 1450]]);
  }, 15000);

  test("a message_delta before message_start does not count", async () => {
    const { records } = await recordsFor([MESSAGE_DELTA, MESSAGE_START, DELTA, MESSAGE_STOP]);
    expect(records).toEqual([]);
  }, 15000);

  test("a response naming no model has no model key", async () => {
    const noModel = sse("message_start", { type: "message_start", message: { id: "msg_no_model" } });
    const streamed = await recordsFor([noModel, DELTA, MESSAGE_DELTA, MESSAGE_STOP]);
    expect(streamed.records).toHaveLength(1);
    expect(Object.keys(streamed.records[0]!)).not.toContain("model");
    const { model: _model, ...noModelJson } = JSON_MESSAGE;
    const json = await recordsFor(jsonResponse(noModelJson));
    expect(json.records).toHaveLength(1);
    expect(Object.keys(json.records[0]!)).not.toContain("model");
  }, 15000);

  test("one event's data split over two data: lines joins with a newline", async () => {
    const structural = 'event: message_delta\ndata: {"type":"message_delta",\ndata: "usage":{"output_tokens":1450}}\n\n';
    const ok = await recordsFor([MESSAGE_START, DELTA, structural, MESSAGE_STOP]);
    expect(ok.records.map((r) => r.output_tokens)).toEqual([1450]);
    // joined with "\n" the number reads `14\n50`, which is no JSON; joined with "" it would read 1450
    const midNumber = 'event: message_delta\ndata: {"type":"message_delta","usage":{"output_tokens":14\ndata: 50}}\n\n';
    const split = await recordsFor([MESSAGE_START, DELTA, midNumber, MESSAGE_STOP]);
    expect(split.records).toEqual([]);
  }, 15000);

  test("data: with no space after the colon parses", async () => {
    const tight = FULL_STREAM.join("").replaceAll("data: ", "data:");
    const { text, records } = await recordsFor([tight]);
    expect(text).toBe(tight);
    expect(records.map((r) => r.id)).toEqual(["msg_01TokenStats"]);
  }, 15000);

  test("bare CR line endings parse like LF", async () => {
    const cr = FULL_STREAM.join("").replaceAll("\n", "\r");
    const { text, records } = await recordsFor([...cr]);
    expect(text).toBe(cr);
    expect(records.map((r) => r.id)).toEqual(["msg_01TokenStats"]);
  }, 15000);

  test("a CRLF split between chunks is one line ending", async () => {
    const crlf = FULL_STREAM.join("").replaceAll("\n", "\r\n");
    const at = crlf.indexOf("\r\n\r\n") + 1;
    const { records } = await recordsFor([crlf.slice(0, at), crlf.slice(at)]);
    expect(records.map((r) => r.id)).toEqual(["msg_01TokenStats"]);
  }, 15000);

  test("a CRLF split between chunks never ends a line twice", async () => {
    // read as two endings, the `\n` would close the message_delta event early and let the next data line count alone
    const deltaThenStop = [
      'event: message_delta\r\ndata: {"type":"message_delta","usage":{"output_tokens":20}}\r',
      '\ndata: {"type":"message_stop"}\r\n\r\n',
    ];
    const { records } = await recordsFor([MESSAGE_START, DELTA, ...deltaThenStop]);
    expect(records).toEqual([]);
  }, 15000);

  test("many small events summing past 1 MiB still make a record", async () => {
    const pad = "p".repeat(40 * 1024);
    const delta = (n: number) => sse("message_delta", { type: "message_delta", usage: { output_tokens: n }, pad });
    const events = Array.from({ length: 30 }, (_, i) => delta(i + 1));
    const { records } = await recordsFor([MESSAGE_START, DELTA, ...events, MESSAGE_STOP]);
    expect(records.map((r) => r.output_tokens)).toEqual([30]);
  }, 15000);

  test("a later message_start does not clear a held output count", async () => {
    const early = sse("message_delta", { type: "message_delta", usage: { output_tokens: 10 } });
    const second = sse("message_start", { type: "message_start", message: { id: "msg_02Spliced", model: "other-model" } });
    const { records } = await recordsFor([MESSAGE_START, early, second, MESSAGE_STOP]);
    expect(records.map((r) => [r.id, r.output_tokens])).toEqual([["msg_01TokenStats", 10]]);
  }, 15000);

  test("a message_start with no message object does not take the latch", async () => {
    const empty = sse("message_start", { type: "message_start" });
    const { records } = await recordsFor([empty, MESSAGE_START, DELTA, MESSAGE_DELTA, MESSAGE_STOP]);
    expect(records.map((r) => r.id)).toEqual(["msg_01TokenStats"]);
  }, 15000);

  test("an id or model over 256 characters, or an unsafe output count, makes no record", async () => {
    const long = "m".repeat(257);
    const start = (message: Record<string, unknown>) => sse("message_start", { type: "message_start", message });
    const delta = (n: number) => sse("message_delta", { type: "message_delta", usage: { output_tokens: n } });
    const longId = await recordsFor([start({ id: long, model: "glm-5.3" }), DELTA, MESSAGE_DELTA, MESSAGE_STOP]);
    expect(longId.records).toEqual([]);
    const longModel = await recordsFor([start({ id: "msg_long_model", model: long }), DELTA, MESSAGE_DELTA, MESSAGE_STOP]);
    expect(longModel.records).toHaveLength(1);
    expect(Object.keys(longModel.records[0]!)).not.toContain("model");
    const unsafe = await recordsFor([MESSAGE_START, DELTA, delta(2 ** 53), MESSAGE_STOP]);
    expect(unsafe.records).toEqual([]);
    const jsonLongId = await recordsFor(jsonResponse({ ...JSON_MESSAGE, id: long }));
    expect(jsonLongId.records).toEqual([]);
    const jsonUnsafe = await recordsFor(jsonResponse({ ...JSON_MESSAGE, usage: { output_tokens: 2 ** 53 } }));
    expect(jsonUnsafe.records).toEqual([]);
  }, 30000);

  test("a 2xx response with no body passes through and makes no record", async () => {
    const s = ts({
      capabilities: ["token_stats"],
      forward: () => new Response(null, { status: 204, headers: { "content-type": "text/event-stream" } }),
    });
    const { key } = await login(s);
    const res = await infer(s, key);
    expect(res.status).toBe(204);
    await res.text();
    expect((await tokens(s)).records).toEqual([]);
  }, 15000);

  test("a first message_start without a valid id latches: a later valid one makes no record", async () => {
    const noId = sse("message_start", { type: "message_start", message: { id: "", model: "glm-5.3" } });
    const { records } = await recordsFor([noId, DELTA, MESSAGE_START, MESSAGE_DELTA, MESSAGE_STOP]);
    expect(records).toEqual([]);
  }, 15000);

  test("the content type matches case-insensitively", async () => {
    const upper = new Response(FULL_STREAM.join(""), { headers: { "content-type": "Text/Event-Stream; charset=UTF-8" } });
    expect((await recordsFor(upper)).records).toHaveLength(1);
    const json = new Response(JSON.stringify(JSON_MESSAGE), { headers: { "content-type": "Application/JSON" } });
    expect((await recordsFor(json)).records).toHaveLength(1);
  }, 15000);

  test("another content type makes no record, even carrying a message body", async () => {
    const body = JSON.stringify(JSON_MESSAGE);
    const { text, records } = await recordsFor(new Response(body, { headers: { "content-type": "text/plain" } }));
    expect(text).toBe(body);
    expect(records).toEqual([]);
  }, 15000);

  test("an invalid JSON response id or output count makes no record", async () => {
    const { id: _id, ...noId } = JSON_MESSAGE;
    const variants: unknown[] = [
      noId,
      { ...JSON_MESSAGE, usage: { output_tokens: -1 } },
      { ...JSON_MESSAGE, usage: { output_tokens: 1.5 } },
      { ...JSON_MESSAGE, usage: { output_tokens: "12" } },
      { ...JSON_MESSAGE, usage: { output_tokens: null } },
      { ...JSON_MESSAGE, id: "" },
    ];
    let call = 0;
    const s = ts({ capabilities: ["token_stats"], forward: () => jsonResponse(variants[call++]) });
    const { key } = await login(s);
    for (let i = 0; i < variants.length; i++) await (await infer(s, key)).text();
    expect(call).toBe(variants.length);
    expect((await tokens(s)).records).toEqual([]);
  }, 15000);
});

describe("token stats: bounds", () => {
  test("an unterminated SSE line past 1 MiB disables the measurement for that response; bytes still pass", async () => {
    // a non-data line, so the per-event data budget cannot be what stops it
    const head = MESSAGE_START + "x".repeat(1.2 * 1024 * 1024);
    const tail = "\n\n" + DELTA + MESSAGE_DELTA + MESSAGE_STOP;
    const s = ts({ capabilities: ["token_stats"], forward: () => sseResponse([head, tail]) });
    const { key } = await login(s);
    expect(await (await infer(s, key)).text()).toBe(head + tail);
    expect((await tokens(s)).records).toEqual([]);
  }, 30000);

  test("one event's data past 1 MiB, over many short lines, disables the measurement; bytes still pass", async () => {
    const lines = ("data: " + "a".repeat(94) + "\n").repeat(12_000);
    const tail = "\n" + DELTA + MESSAGE_DELTA + MESSAGE_STOP;
    const s = ts({ capabilities: ["token_stats"], forward: () => sseResponse([MESSAGE_START, lines, tail]) });
    const { key } = await login(s);
    expect(await (await infer(s, key)).text()).toBe(MESSAGE_START + lines + tail);
    expect((await tokens(s)).records).toEqual([]);
  }, 30000);

  test("a JSON body past 4 MiB makes no record; bytes still pass", async () => {
    const big = JSON.stringify({ ...JSON_MESSAGE, pad: "z".repeat(5 * 1024 * 1024) });
    const s = ts({
      capabilities: ["token_stats"],
      forward: () => new Response(big, { headers: { "content-type": "application/json" } }),
    });
    const { key } = await login(s);
    expect(await (await infer(s, key)).text()).toBe(big);
    expect((await tokens(s)).records).toEqual([]);
  }, 30000);

  test("a long unterminated line in small chunks costs time linear in its length", async () => {
    // 1000 KiB in 128-byte chunks: rescanning or re-reading the whole held line per chunk costs seconds or
    // hundreds of ms (measured 2026-11-03 on 7f0913b + this change's earlier splitters: 4.6 s, then ~380 ms);
    // scanning only each new chunk stays within a small multiple of a bare per-chunk transform over the same chunks
    const line = enc.encode("data: " + "y".repeat(1000 * 1024));
    const chunked = () =>
      new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            for (let i = 0; i < line.length; i += 128) controller.enqueue(line.subarray(i, i + 128));
            controller.close();
          },
        }),
        { headers: { "content-type": "text/event-stream" } },
      );
    async function timed(read: () => Promise<ArrayBuffer>): Promise<number> {
      const started = performance.now();
      expect((await read()).byteLength).toBe(line.length);
      return performance.now() - started;
    }
    const identity = await timed(() =>
      new Response(chunked().body!.pipeThrough(new TransformStream<Uint8Array, Uint8Array>())).arrayBuffer(),
    );
    const context = { startedAt: Date.now(), startedMono: performance.now(), account: "a", push: () => {} };
    const tapped = await timed(() => tapTokenStats(chunked(), context).arrayBuffer());
    expect(tapped).toBeLessThan(4 * identity + 30);
  }, 30000);

  test("a leading-zero cursor is not one the core served, so it reads as unknown", async () => {
    const s = ts({ capabilities: ["token_stats"], forward: numberedJson() });
    const { key } = await login(s);
    await (await infer(s, key)).text();
    const { cursor } = await tokens(s);
    const padded = cursor.slice(0, cursor.lastIndexOf(".")) + ".01";
    const body = await tokens(s, padded);
    expect(body.records.map((r) => r.id)).toEqual(["msg_1"]);
    expect(body.dropped).toBe(true);
  }, 15000);

  test("a cursor newer than the newest record is unknown", async () => {
    const s = ts({ capabilities: ["token_stats"], forward: numberedJson() });
    const { key } = await login(s);
    await (await infer(s, key)).text();
    const { cursor } = await tokens(s);
    const ahead = cursor.slice(0, cursor.lastIndexOf(".")) + ".2";
    const body = await tokens(s, ahead);
    expect(body.records.map((r) => r.id)).toEqual(["msg_1"]);
    expect(body.dropped).toBe(true);
  }, 15000);
});

describe("token stats: wake-up event", () => {
  test("a throwing event listener costs neither the record, the other listeners' event, nor the response", async () => {
    const s = ts({ capabilities: ["events", "token_stats"], forward: () => sseResponse(FULL_STREAM) });
    s.server.events.subscribe(() => {
      throw new Error("listener broke");
    });
    const events: string[] = [];
    s.server.events.subscribe((name) => events.push(name));
    const { key } = await login(s);
    expect(await (await infer(s, key)).text()).toBe(FULL_STREAM.join(""));
    expect((await tokens(s)).records).toHaveLength(1);
    expect(events.filter((e) => e === "token")).toHaveLength(1);
  }, 15000);

  test("a landed record publishes a token event carrying the route's cursor, never the record", async () => {
    const s = ts({ capabilities: ["events", "token_stats"], forward: () => sseResponse(FULL_STREAM) });
    const events: { name: string; data: unknown }[] = [];
    s.server.events.subscribe((name, data) => events.push({ name, data }));
    const { key } = await login(s);
    await (await infer(s, key)).text();
    const token = events.filter((e) => e.name === "token");
    expect(token).toHaveLength(1);
    const { cursor } = await tokens(s);
    expect(token[0]!.data).toEqual({ cursor });
  }, 15000);

  test("no token event when no record lands", async () => {
    const s = ts({ capabilities: ["events", "token_stats"], forward: () => sseResponse([MESSAGE_START, DELTA, MESSAGE_STOP]) });
    const events: string[] = [];
    s.server.events.subscribe((name) => events.push(name));
    const { key } = await login(s);
    await (await infer(s, key)).text();
    expect(events.filter((e) => e === "token")).toEqual([]);
  }, 15000);
});
