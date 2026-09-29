import { defineProxy, runCli } from "../../src/index.ts";
import { makeFakeAdapter } from "../fake-adapter.ts";

const mode = process.env.FAKE_MODE ?? "finish";
const stepMs = Number(process.env.FAKE_STEP_MS ?? "500");
const pauseMs = Number(process.env.FAKE_PAUSE_MS ?? "12000");
const drainSecsRaw = process.env.FAKE_DRAIN_SECS;
const drainSecs = drainSecsRaw === undefined ? undefined : Number(drainSecsRaw);

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const { adapter } = makeFakeAdapter({
  ...(drainSecs === undefined ? {} : { drain_secs: drainSecs }),
  forward: () => {
    const encoder = new TextEncoder();
    const body = new ReadableStream<Uint8Array>({
      async start(controller) {
        controller.enqueue(encoder.encode("part1"));
        if (mode === "hang") return; // hold the stream open forever
        if (mode === "pause") {
          // a stream quiet far longer than Bun's 10 s default idle cut: it must survive
          await sleep(pauseMs);
          controller.enqueue(encoder.encode("part2"));
          controller.close();
          return;
        }
        await sleep(stepMs);
        controller.enqueue(encoder.encode("part2"));
        await sleep(stepMs);
        controller.enqueue(encoder.encode("part3"));
        controller.close();
      },
    });
    return new Response(body, { headers: { "content-type": "text/plain" } });
  },
});

runCli(defineProxy(adapter));
