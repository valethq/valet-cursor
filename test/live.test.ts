import { expect, test } from "bun:test";
import { realSdk } from "../src/sdk";
import { collect, fakeCtx, input, noTools, open, texts } from "./helpers";

const live = process.env.VALET_LIVE_CURSOR === "1" && !!process.env.CURSOR_API_KEY;
const model = process.env.VALET_LIVE_CURSOR_MODEL ?? "composer-2";

test.skipIf(!live)(
  "live Cursor SDK: two turns share one conversation",
  async () => {
    const h = fakeCtx({ idleCloseMs: 0 }, realSdk);
    try {
      const s = await open(h, { cwd: process.cwd(), model });
      const ac = new AbortController().signal;
      const one = await collect(s.prompt(input("reply with the word pong"), ac));
      expect(texts(one).toLowerCase()).toContain("pong");
      expect(one.at(-1)).toEqual({ type: "finish", reason: "stop" });
      const two = await collect(s.prompt(input("what single word did I ask you to reply with?"), ac));
      expect(texts(two).toLowerCase()).toContain("pong");
      await s.close();
    } finally {
      await h.dispose();
    }
  },
  180_000,
);

test.skipIf(!live)(
  "live: a built-in the gate denies does not complete",
  async () => {
    const h = fakeCtx({ idleCloseMs: 0 }, realSdk);
    try {
      const gate = { ...noTools, authorize: async () => ({ denied: "live test" }) };
      const s = await open(h, { cwd: process.cwd(), model, tools: gate });
      const events = await collect(
        s.prompt(
          input("Read package.json and tell me its `name` field. Use any tool you have."),
          new AbortController().signal,
        ),
      );
      expect(events.some((e) => e.type === "tool-end" && e.status === "done")).toBe(false);
      expect(texts(events)).not.toContain("valet-cursor");
      await s.close();
    } finally {
      await h.dispose();
    }
  },
  180_000,
);
