import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { InteractionUpdate } from "@cursor/sdk";
import type { AgentEvent, AgentSession, ToolSurface } from "@valethq/sdk";
import { fakeSdk, notFound, say, usage } from "./fake-sdk";
import { collect, fakeCtx, input, noTools, open, texts } from "./helpers";

const ac = () => new AbortController().signal;

const compact = (s: AgentSession) => {
  if (!s.compact) throw new Error("no compact");
  return s.compact(undefined, ac());
};

const shellCall = (command: string, result?: unknown) => ({
  type: "shell",
  args: { command },
  ...(result ? { result } : {}),
});

describe("turns", () => {
  test("streams text, reasoning and tools, then usage and stop", async () => {
    const { deps, sends } = fakeSdk(async function* () {
      yield { type: "thinking-delta", text: "hmm" };
      yield {
        type: "tool-call-started",
        callId: "c1",
        modelCallId: "m1",
        toolCall: shellCall("ls"),
      } as InteractionUpdate;
      yield { type: "shell-output-delta", event: { case: "stdout", value: { data: "a.txt\n" } } };
      yield {
        type: "tool-call-completed",
        callId: "c1",
        modelCallId: "m1",
        toolCall: shellCall("ls", {
          status: "success",
          value: { exitCode: 0, signal: "", stdout: "a.txt\n", stderr: "", executionTime: 3 },
        }),
      } as InteractionUpdate;
      yield { type: "text-delta", text: "done" };
      yield { type: "model-call-completed", modelCallId: "m1", usage };
      yield { type: "turn-ended", usage };
      return undefined;
    });
    const h = fakeCtx({}, deps);
    const s = await open(h);
    const events = await collect(s.prompt(input("list files", "You are valet."), ac()));
    expect(events).toEqual([
      { type: "reasoning-delta", text: "hmm" },
      { type: "tool-start", callId: "c1", name: "shell", title: "ls", input: { command: "ls" } },
      { type: "tool-update", callId: "c1", outputDelta: "a.txt\n" },
      { type: "tool-end", callId: "c1", status: "done", output: "a.txt\n", exitCode: 0 },
      { type: "text-delta", text: "done" },
      { type: "usage", contextTokens: 1230 },
      { type: "usage", contextTokens: 1230, inputTokens: 1200, outputTokens: 30 },
      { type: "finish", reason: "stop" },
    ]);
    expect(sends[0]?.text).toBe("You are valet.\n\nlist files");
    expect(sends[0]?.options.model).toEqual({ id: "composer-2.5" });
    expect(sends[0]?.options.mode).toBe("agent");
    expect(h.state["s1:cursor"]).toEqual({ resumeId: s.resumeId });
  });

  test("a new session creates its agent with the pinned id and valet's options", async () => {
    const { deps, agents } = fakeSdk(() => say("hi"));
    const h = fakeCtx({ denyTools: ["shell"], settingSources: ["project"] }, deps, {
      secrets: { cursor_api_key: "key-1\n" },
    });
    const s = await open(h);
    await collect(s.prompt(input("hi"), ac()));
    expect(agents[0]?.via).toBe("create");
    expect(agents[0]?.options).toEqual({
      apiKey: "key-1",
      agentId: s.resumeId,
      model: { id: "composer-2.5" },
      local: { cwd: "/tmp", settingSources: ["project"] },
      disallowedTools: ["shell"],
    });
  });

  test("no key and no Cursor login fails fast without starting an agent", async () => {
    const { deps, agents } = fakeSdk(() => say("x"));
    const s = await open(fakeCtx({}, deps, { secrets: {} }));
    expect(await collect(s.prompt(input("hi"), ac()))).toEqual([
      {
        type: "finish",
        reason: "error",
        error: "no Cursor API key: put one in ~/.valet/secrets/cursor_api_key or CURSOR_API_KEY",
      },
    ]);
    expect(agents.length).toBe(0);
    const loggedIn = fakeSdk(() => say("ok"), { auth: async () => ({ status: "logged-in" }) });
    const s2 = await open(fakeCtx({}, loggedIn.deps, { secrets: {} }));
    expect((await collect(s2.prompt(input("hi"), ac()))).at(-1)).toEqual({ type: "finish", reason: "stop" });
    expect(loggedIn.agents[0]?.options.apiKey).toBeUndefined();
  });

  test("a failed send is a finish error", async () => {
    const { deps } = fakeSdk(() => say("x"), { sendError: new Error("API key is required") });
    const s = await open(fakeCtx({}, deps));
    expect(await collect(s.prompt(input("hi"), ac()))).toEqual([
      { type: "finish", reason: "error", error: "API key is required" },
    ]);
  });

  test("a run that errors finishes with its message", async () => {
    const { deps } = fakeSdk(async function* () {
      yield { type: "text-delta", text: "par" };
      return { status: "error", error: { message: "rate limited" } };
    });
    const events = await collect((await open(fakeCtx({}, deps))).prompt(input("hi"), ac()));
    expect(events.at(-1)).toEqual({ type: "finish", reason: "error", error: "rate limited" });
  });

  test("setModel applies to the next send, with variant params", async () => {
    const { deps, sends } = fakeSdk(() => say("ok"));
    const s = await open(fakeCtx({}, deps));
    await s.setModel?.("gpt-5.5?reasoning=high");
    await collect(s.prompt(input("hi"), ac()));
    expect(sends[0]?.options.model).toEqual({ id: "gpt-5.5", params: [{ id: "reasoning", value: "high" }] });
  });

  test("images are sent inline", async () => {
    const dir = mkdtempSync(join(tmpdir(), "valet-cursor-"));
    writeFileSync(join(dir, "b1"), "png");
    const { deps, sends } = fakeSdk(() => say("ok"));
    const s = await open(fakeCtx({}, deps, { blobs: { b1: join(dir, "b1") } }));
    await collect(
      s.prompt(
        {
          content: [
            { type: "text", text: "see" },
            { type: "image", mime: "image/png", blobId: "b1" },
          ],
        },
        ac(),
      ),
    );
    expect(sends[0]?.images).toEqual([
      { data: Buffer.from("png").toString("base64"), mimeType: "image/png" },
    ]);
  });

  test("hideBuiltinTools leaves only the mcp family, which carries valet's tools", async () => {
    const { deps, agents } = fakeSdk(() => say("ok"));
    const h = fakeCtx({ hideBuiltinTools: true }, deps);
    await collect((await open(h)).prompt(input("hi"), ac()));
    expect(agents[0]?.options.tools).toEqual(["mcp"]);
  });
});

describe("resume", () => {
  test("a stored agent is resumed and its first send forces out a stale run", async () => {
    const { deps, agents, sends } = fakeSdk(() => say("again"), { stored: new Set(["a1"]) });
    const h = fakeCtx({}, deps);
    const s = await open(h, { resumeId: "a1" });
    expect(s.resumeId).toBe("a1");
    expect((s as unknown as { reseeded: boolean }).reseeded).toBe(false);
    await collect(s.prompt(input("one"), ac()));
    await collect(s.prompt(input("two"), ac()));
    expect(agents.filter((a) => a.via === "resume").length).toBe(2);
    expect(agents.some((a) => a.via === "create")).toBe(false);
    expect(sends.map((x) => x.options.local?.force)).toEqual([true, undefined]);
  });

  test("a missing agent reseeds under a new id", async () => {
    const { deps, agents } = fakeSdk(() => say("hi"));
    const h = fakeCtx({}, deps);
    const s = await open(h, { resumeId: "gone" });
    expect(s.resumeId).not.toBe("gone");
    expect((s as unknown as { reseeded: boolean }).reseeded).toBe(true);
    expect(h.state["s1:cursor"]).toEqual({ resumeId: s.resumeId });
    await collect(s.prompt(input("hi"), ac()));
    expect(agents.at(-1)?.via).toBe("create");
  });

  test("an unclear resume failure keeps the id", async () => {
    const { deps } = fakeSdk(() => say("hi"));
    deps.resume = (async () => {
      throw new Error("disk busy");
    }) as never;
    const s = await open(fakeCtx({}, deps), { resumeId: "a1" });
    expect(s.resumeId).toBe("a1");
    expect(notFound("x").message).toContain("not found");
  });

  test("an idle agent is closed and the next prompt resumes it", async () => {
    const { deps, agents } = fakeSdk(() => say("hi"));
    const s = await open(fakeCtx({ idleCloseMs: 5 }, deps));
    await collect(s.prompt(input("one"), ac()));
    await Bun.sleep(20);
    expect(agents[0]?.closed).toBe(true);
    await collect(s.prompt(input("two"), ac()));
    expect(agents[1]?.via).toBe("resume");
  });
});

describe("cancel", () => {
  test("abort cancels the run, closes open tools and carries an unsaved prompt", async () => {
    const ctl = new AbortController();
    const { deps, sends } = fakeSdk(async function* (text, c) {
      if (text.includes("second")) {
        yield* say("ok");
        return undefined;
      }
      yield {
        type: "tool-call-started",
        callId: "c1",
        modelCallId: "m1",
        toolCall: shellCall("sleep 9"),
      } as InteractionUpdate;
      ctl.abort();
      while (!c.cancelled()) await Bun.sleep(1);
      return undefined;
    });
    const s = await open(fakeCtx({}, deps));
    const events = await collect(s.prompt(input("first"), ctl.signal));
    expect(sends[0]?.cancelled).toBe(true);
    expect(events.slice(-2)).toEqual([
      { type: "tool-end", callId: "c1", status: "cancelled" },
      { type: "finish", reason: "cancelled" },
    ]);
    await collect(s.prompt(input("second"), ac()));
    expect(sends[1]?.text).toBe(
      "[valet: your previous turn was stopped before it started. It said:]\nfirst\n\nsecond",
    );
  });

  test("a prompt cancelled after Cursor saved a step is not carried", async () => {
    const ctl = new AbortController();
    const { deps, sends } = fakeSdk(async function* (text, c) {
      if (text === "second") {
        yield* say("ok");
        return undefined;
      }
      yield { type: "model-call-completed", modelCallId: "m1", usage };
      ctl.abort();
      while (!c.cancelled()) await Bun.sleep(1);
      return undefined;
    });
    const s = await open(fakeCtx({}, deps));
    await collect(s.prompt(input("first"), ctl.signal));
    await collect(s.prompt(input("second"), ac()));
    expect(sends[1]?.text).toBe("second");
  });
});

describe("tools", () => {
  const surface = (log: string[], deny?: string): ToolSurface => ({
    list: () => [
      { name: "web_search", description: "search", inputSchema: { type: "object" } },
      { name: "exec", description: "run", inputSchema: { type: "object" } },
    ],
    call: async (name, input, call) => {
      log.push(`call ${name} ${JSON.stringify(input)} ${call.callId}`);
      return { content: [{ type: "text", text: "result" }] };
    },
    authorize: async (name, input) => {
      log.push(`authorize ${name}`);
      return deny === name ? { denied: "not on this host" } : { input };
    },
  });

  test("valet's tools are custom tools that run through ToolSurface.call", async () => {
    const log: string[] = [];
    const { deps, sends } = fakeSdk(async function* (_t, c) {
      const tools = c.options.local?.customTools ?? {};
      expect(Object.keys(tools)).toEqual(["exec", "web_search"]);
      const out = await tools.exec?.execute({ command: "ls" }, { toolCallId: "c9" });
      expect(out).toEqual({ content: [{ type: "text", text: "result" }] });
      yield {
        type: "tool-call-started",
        callId: "c9",
        modelCallId: "m1",
        toolCall: {
          type: "mcp",
          args: { toolName: "exec", providerIdentifier: "custom-user-tools", args: { command: "ls" } },
        },
      } as InteractionUpdate;
      yield* say("ok");
      return undefined;
    });
    const s = await open(fakeCtx({}, deps), { tools: surface(log) });
    const events = await collect(s.prompt(input("hi"), ac()));
    expect(log).toEqual(['call exec {"command":"ls"} c9']);
    expect(events[0]).toEqual({
      type: "tool-start",
      callId: "c9",
      name: "exec",
      title: "ls",
      input: { command: "ls" },
    });
    expect(sends.length).toBe(1);
  });

  test("a built-in the gate denies stops the run", async () => {
    const log: string[] = [];
    const { deps, sends } = fakeSdk(async function* (_t, c) {
      yield {
        type: "tool-call-started",
        callId: "c1",
        modelCallId: "m1",
        toolCall: shellCall("rm -rf /"),
      } as InteractionUpdate;
      while (!c.cancelled()) await Bun.sleep(1);
      return undefined;
    });
    const s = await open(fakeCtx({}, deps), { tools: surface(log, "shell") });
    const events = await collect(s.prompt(input("hi"), ac()));
    expect(log).toEqual(["authorize shell"]);
    expect(sends[0]?.cancelled).toBe(true);
    const denied = "valet denied shell: not on this host";
    expect(events).toEqual([
      { type: "tool-start", callId: "c1", name: "shell", title: "rm -rf /", input: { command: "rm -rf /" } },
      { type: "notice", level: "error", text: denied },
      { type: "tool-end", callId: "c1", status: "error" },
      { type: "finish", reason: "error", error: denied },
    ]);
  });

  test("a gate that throws or rewrites the input fails closed", async () => {
    for (const authorize of [
      async () => Promise.reject(new Error("gate down")),
      async () => ({ input: { command: "echo safe" } }),
    ]) {
      const { deps } = fakeSdk(async function* (_t, c) {
        yield {
          type: "tool-call-started",
          callId: "c1",
          modelCallId: "m1",
          toolCall: shellCall("ls"),
        } as InteractionUpdate;
        while (!c.cancelled()) await Bun.sleep(1);
        return undefined;
      });
      const s = await open(fakeCtx({}, deps), { tools: { ...noTools, authorize } as ToolSurface });
      const last = (await collect(s.prompt(input("hi"), ac()))).at(-1) as Extract<
        AgentEvent,
        { type: "finish" }
      >;
      expect(last.reason).toBe("error");
      expect(last.error).toStartWith("valet denied shell:");
    }
  });
});

describe("compact", () => {
  test("summarize maps to compaction events", async () => {
    const { deps } = fakeSdk(() => say("hi"), {
      summary: [
        { type: "summary", agent_id: "a", run_id: "r", status: "running" },
        { type: "summary", agent_id: "a", run_id: "r", status: "completed" },
      ],
    });
    const s = await open(fakeCtx({}, deps));
    expect(await collect(compact(s))).toEqual([
      { type: "compaction-start" },
      { type: "compaction-start" },
      { type: "compaction-end", status: "completed" },
      { type: "finish", reason: "stop" },
    ]);
  });

  test("a failed summary is reported", async () => {
    const { deps } = fakeSdk(() => say("hi"), {
      summary: [{ type: "summary", agent_id: "a", run_id: "r", status: "error" }],
    });
    const events = await collect(compact(await open(fakeCtx({}, deps))));
    expect(events).toContainEqual({ type: "compaction-end", status: "failed" });
    expect(events.at(-1)).toEqual({ type: "finish", reason: "error", error: "cursor summarize failed" });
  });
});

test("text helper joins deltas", async () => {
  const { deps } = fakeSdk(() => say("pong"));
  expect(texts(await collect((await open(fakeCtx({}, deps))).prompt(input("ping"), ac())))).toBe("pong");
});
