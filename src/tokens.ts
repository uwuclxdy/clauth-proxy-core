import type { TokenRecord, TokenRecords } from "./schemas.ts";

/** Newest records a proxy keeps in memory; older ones fall off the front. */
const RING_CAPACITY = 1024;
/** An unfinished SSE line above this disables the observer, bounding the unterminated line a hostile stream can pin. */
const MAX_SSE_LINE_CHARS = 1024 * 1024;
/** One event's accumulated `data:` characters above this disables the observer, bounding the data a hostile stream can pin. */
const MAX_EVENT_DATA_CHARS = 1024 * 1024;
/** A JSON body above this disables the observer rather than held whole. */
const MAX_JSON_BODY_BYTES = 4 * 1024 * 1024;

interface StoredRecord {
  seq: number;
  record: TokenRecord;
}

/**
 * One proxy life's completed-response records: the in-memory ring behind the
 * token route and the cursor that names its newest record.
 */
export class TokenStats {
  private readonly life = crypto.randomUUID().replaceAll("-", "");
  private readonly ring: StoredRecord[] = [];
  private newestSeq = 0;

  /** Append a completed record and return the cursor that now names it. */
  push(record: TokenRecord): string {
    this.newestSeq += 1;
    this.ring.push({ seq: this.newestSeq, record });
    if (this.ring.length > RING_CAPACITY) this.ring.shift();
    return this.cursor();
  }

  /** Records newer than a known cursor, or every retained record and `dropped` when the cursor is not. */
  read(since: string | undefined): TokenRecords {
    const cursor = this.cursor();
    const retained = this.ring.map((entry) => entry.record);
    if (since === undefined) return { records: retained, cursor };
    const seq = this.seqOf(since);
    if (seq === null || !this.isKnown(seq)) return { records: retained, cursor, dropped: true };
    return { records: this.ring.filter((entry) => entry.seq > seq).map((entry) => entry.record), cursor };
  }

  private cursor(): string {
    return `${this.life}.${this.newestSeq}`;
  }

  private seqOf(cursor: string): number | null {
    const dot = cursor.lastIndexOf(".");
    if (dot < 0 || cursor.slice(0, dot) !== this.life) return null;
    const digits = cursor.slice(dot + 1);
    if (!/^(0|[1-9]\d*)$/.test(digits)) return null;
    const seq = Number(digits);
    return Number.isSafeInteger(seq) ? seq : null;
  }

  private isKnown(seq: number): boolean {
    const oldestEdge = this.ring.length === 0 ? 0 : this.ring[0]!.seq - 1;
    return seq >= oldestEdge && seq <= this.newestSeq;
  }
}

export interface TokenTapContext {
  startedAt: number;
  /** Receipt on the monotonic clock: durations must not move when the wall clock steps. */
  startedMono: number;
  account: string;
  push(record: TokenRecord): void;
}

/** Whole milliseconds since receipt, measured on the monotonic clock. */
function elapsedMs(context: TokenTapContext): number {
  return Math.round(performance.now() - context.startedMono);
}

/**
 * Wrap a forwarded response so every chunk reaches the client unchanged and
 * immediately while a copy feeds the measurement; a parser failure drops the
 * measurement only.
 */
export function tapTokenStats(res: Response, context: TokenTapContext): Response {
  const observer = observerFor(res.headers.get("content-type") ?? "", context);
  if (observer === null || res.body === null) return res;
  let live: ResponseObserver | null = observer;
  const body = res.body.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        controller.enqueue(chunk);
        live = observe(live, chunk);
      },
      flush() {
        finish(live);
      },
    }),
  );
  return new Response(body, { status: res.status, statusText: res.statusText, headers: res.headers });
}

interface ResponseObserver {
  observe(chunk: Uint8Array): void;
  finish?(): void;
}

function observerFor(contentType: string, context: TokenTapContext): ResponseObserver | null {
  const lower = contentType.toLowerCase();
  if (lower.includes("text/event-stream")) return new SseObserver(context);
  if (lower.includes("application/json")) return new JsonObserver(context);
  return null;
}

function observe(observer: ResponseObserver | null, chunk: Uint8Array): ResponseObserver | null {
  if (observer === null) return null;
  try {
    observer.observe(chunk);
    return observer;
  } catch {
    return null;
  }
}

function finish(observer: ResponseObserver | null): void {
  try {
    observer?.finish?.();
  } catch {
    // a parser failure drops the measurement only
  }
}

const LINE_FEED = "\n".charCodeAt(0);
const CARRIAGE_RETURN = "\r".charCodeAt(0);

/** The Anthropic SSE events that carry a completed response's id, model, output count and first token. */
class SseObserver implements ResponseObserver {
  private readonly decoder = new TextDecoder();
  private readonly data: string[] = [];
  /** The unfinished line's decoded pieces, kept apart so a growing line is never re-read or re-joined per chunk. */
  private readonly lineParts: string[] = [];
  /** Characters held in `lineParts`, bounding the unterminated line without joining it. */
  private lineChars = 0;
  /** Set when a line ends on a chunk's last `\r`; a leading `\n` in the next decoded text is that ending's second half. */
  private skipLineFeed = false;
  private dataChars = 0;
  private messageStarted = false;
  private messageId: string | undefined;
  private model: string | undefined;
  private outputTokens: number | undefined;
  private ttftMs: number | undefined;
  private recorded = false;

  constructor(private readonly context: TokenTapContext) {}

  observe(chunk: Uint8Array): void {
    const text = this.decoder.decode(chunk, { stream: true });
    if (text !== "") this.takeLines(text);
    if (this.lineChars > MAX_SSE_LINE_CHARS) throw new Error("sse line too long");
  }

  /** Split one decoded chunk into lines; only this chunk's characters are scanned. */
  private takeLines(text: string): void {
    let start = 0;
    if (this.skipLineFeed) {
      this.skipLineFeed = false;
      if (text.charCodeAt(0) === LINE_FEED) start = 1;
    }
    for (let i = start; i < text.length; i++) {
      const code = text.charCodeAt(i);
      if (code === LINE_FEED) {
        this.completeLine(text.slice(start, i));
        start = i + 1;
      } else if (code === CARRIAGE_RETURN) {
        this.completeLine(text.slice(start, i));
        if (i === text.length - 1) {
          this.skipLineFeed = true;
          return;
        }
        if (text.charCodeAt(i + 1) === LINE_FEED) i++;
        start = i + 1;
      }
    }
    if (start === text.length) return;
    const held = text.slice(start);
    this.lineParts.push(held);
    this.lineChars += held.length;
  }

  /** Hand off a line that ends here; pieces held from earlier chunks join only now. */
  private completeLine(tail: string): void {
    const line = this.lineParts.join("") + tail;
    this.lineParts.length = 0;
    this.lineChars = 0;
    this.takeLine(line);
  }

  private takeLine(line: string): void {
    if (line === "") {
      this.dispatch();
      return;
    }
    if (!line.startsWith("data:")) return;
    const value = line.slice("data:".length);
    const data = value.startsWith(" ") ? value.slice(1) : value;
    this.dataChars += data.length + 1;
    if (this.dataChars > MAX_EVENT_DATA_CHARS) throw new Error("sse event data too long");
    this.data.push(data);
  }

  private dispatch(): void {
    this.dataChars = 0;
    const payload = this.data.join("\n");
    this.data.length = 0;
    if (payload === "") return;
    const event = parseObject(payload);
    if (event === null) return;
    if (event.type === "message_start") this.takeMessageStart(event);
    else if (event.type === "content_block_delta") this.takeFirstDelta();
    else if (event.type === "message_delta") this.takeMessageDelta(event);
    else if (event.type === "message_stop") this.takeMessageStop();
  }

  private takeMessageStart(event: Record<string, unknown>): void {
    if (this.messageStarted) return;
    const message = event.message;
    if (typeof message !== "object" || message === null) return;
    this.messageStarted = true;
    this.outputTokens = undefined;
    const fields = message as Record<string, unknown>;
    if (isWireString(fields.id)) this.messageId = fields.id;
    if (isWireString(fields.model)) this.model = fields.model;
  }

  private takeFirstDelta(): void {
    if (this.ttftMs === undefined) this.ttftMs = elapsedMs(this.context);
  }

  private takeMessageDelta(event: Record<string, unknown>): void {
    const usage = event.usage;
    if (typeof usage !== "object" || usage === null) return;
    const output = (usage as Record<string, unknown>).output_tokens;
    if (isTokenCount(output)) this.outputTokens = output;
  }

  private takeMessageStop(): void {
    if (this.recorded || this.messageId === undefined || this.outputTokens === undefined) return;
    this.recorded = true;
    this.context.push(
      makeRecord({
        id: this.messageId,
        account: this.context.account,
        model: this.model,
        outputTokens: this.outputTokens,
        startedAt: this.context.startedAt,
        endedAt: this.context.startedAt + elapsedMs(this.context),
        ttftMs: this.ttftMs,
      }),
    );
  }
}

/** A whole JSON response body, parsed once the body completes with its top-level id, model and output count. */
class JsonObserver implements ResponseObserver {
  private readonly chunks: Uint8Array[] = [];
  private size = 0;

  constructor(private readonly context: TokenTapContext) {}

  observe(chunk: Uint8Array): void {
    this.size += chunk.byteLength;
    if (this.size > MAX_JSON_BODY_BYTES) throw new Error("json body too large");
    this.chunks.push(chunk);
  }

  finish(): void {
    const message = parseObject(new TextDecoder().decode(joinChunks(this.chunks, this.size)));
    if (message === null) return;
    const usage = message.usage;
    if (!isWireString(message.id)) return;
    if (typeof usage !== "object" || usage === null) return;
    const output = (usage as Record<string, unknown>).output_tokens;
    if (!isTokenCount(output)) return;
    this.context.push(
      makeRecord({
        id: message.id,
        account: this.context.account,
        model: isWireString(message.model) ? message.model : undefined,
        outputTokens: output,
        startedAt: this.context.startedAt,
        endedAt: this.context.startedAt + elapsedMs(this.context),
        ttftMs: undefined,
      }),
    );
  }
}

function joinChunks(chunks: Uint8Array[], size: number): Uint8Array {
  const body = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return body;
}

function makeRecord(fields: {
  id: string;
  account: string;
  model: string | undefined;
  outputTokens: number;
  startedAt: number;
  endedAt: number;
  ttftMs: number | undefined;
}): TokenRecord {
  return {
    id: fields.id,
    account: fields.account,
    ...(fields.model !== undefined ? { model: fields.model } : {}),
    output_tokens: fields.outputTokens,
    started_at: new Date(fields.startedAt).toISOString(),
    ended_at: new Date(fields.endedAt).toISOString(),
    ...(fields.ttftMs !== undefined ? { ttft_ms: fields.ttftMs } : {}),
  };
}

function parseObject(text: string): Record<string, unknown> | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;
  return parsed as Record<string, unknown>;
}

function isWireString(value: unknown): value is string {
  return typeof value === "string" && value.length >= 1 && value.length <= 256;
}

function isTokenCount(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}
