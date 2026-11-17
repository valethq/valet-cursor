import { describe, expect, test } from "bun:test";
import { EventQueue } from "../src/channel";
import { DEFAULT_MODELS } from "../src/config";
import { mapUpdate, newTurnState, toolInfo, toolOutcome } from "../src/events";
import { catalogEntries, createCatalog, modelLister, pickerId, resolveModel } from "../src/models";
import { toolSet } from "../src/session";

describe("models", () => {
  test("picker ids round-trip variant params", () => {
    const params = [
      { id: "reasoning", value: "high" },
      { id: "fast", value: "true" },
    ];
    expect(resolveModel(pickerId("gpt-5.5", params))).toEqual({ id: "gpt-5.5", params });
    expect(resolveModel("composer-2")).toEqual({ id: "composer-2" });
    expect(pickerId("composer-2")).toBe("composer-2");
  });

  test("catalog variants become picker entries; the default keeps the bare id", () => {
    expect(
      catalogEntries({
        id: "gpt-5.5",
        displayName: "GPT-5.5",
        variants: [
          { params: [{ id: "reasoning", value: "medium" }], displayName: "GPT-5.5", isDefault: true },
          { params: [{ id: "reasoning", value: "high" }], displayName: "High" },
        ],
      }),
    ).toEqual([
      { id: "gpt-5.5", name: "GPT-5.5" },
      { id: "gpt-5.5?reasoning=high", name: "GPT-5.5 (High)" },
    ]);
    expect(catalogEntries({ id: "composer-2", displayName: "Composer 2" })).toEqual([
      { id: "composer-2", name: "Composer 2" },
    ]);
  });

  test("the lister prefers config, then the catalog, then the built-in list, plus custom models", async () => {
    let calls = 0;
    let list: unknown[] | undefined;
    const errors: string[] = [];
    const catalog = createCatalog(
      async () => {
        calls++;
        if (list === undefined) throw new Error("no key");
        return list as never;
      },
      (e) => errors.push(e.message),
    );
    const custom = () => [{ id: "my-model" }, { id: "composer-2" }];
    const ids = async (cfg = {}) => (await modelLister(() => cfg, catalog, custom)()).map((m) => m.id);
    expect(await ids()).toEqual([...DEFAULT_MODELS.map((m) => m.id), "my-model"]);
    expect(errors).toEqual(["no key"]);
    await ids();
    expect(calls).toBe(1);
    catalog.clear();
    list = [{ id: "claude-5", displayName: "Claude 5" }];
    expect(await ids()).toEqual(["claude-5", "my-model", "composer-2"]);
    expect(await ids({ models: [{ id: "only" }] })).toEqual(["only", "my-model", "composer-2"]);
  });
});

describe("events", () => {
  test("toolInfo names MCP calls after the MCP tool and marks valet's", () => {
    expect(
      toolInfo({
        type: "mcp",
        args: { toolName: "exec", providerIdentifier: "custom-user-tools", args: { command: "ls" } },
      }),
    ).toEqual({ name: "exec", title: "ls", input: { command: "ls" }, valet: true });
    expect(toolInfo({ type: "mcp", args: { toolName: "x", providerIdentifier: "github" } }).valet).toBe(
      false,
    );
    expect(toolInfo({ type: "read", args: { path: "a.ts" } })).toEqual({
      name: "read",
      title: "a.ts",
      input: { path: "a.ts" },
      valet: false,
    });
  });

  test("toolOutcome reads shell, mcp, error and generic results", () => {
    expect(
      toolOutcome(
        { type: "shell", result: { status: "success", value: { exitCode: 2, stdout: "o", stderr: "e" } } },
        false,
      ),
    ).toEqual({ status: "error", output: "o\ne", exitCode: 2 });
    expect(
      toolOutcome(
        {
          type: "mcp",
          result: { status: "success", value: { isError: false, content: [{ text: { text: "hi" } }] } },
        },
        false,
      ),
    ).toEqual({ status: "done", output: "hi" });
    expect(
      toolOutcome({ type: "read", result: { status: "error", error: { message: "nope" } } }, false),
    ).toEqual({
      status: "error",
      output: "nope",
    });
    expect(
      toolOutcome({ type: "read", result: { status: "error", error: { message: "x" } } }, true).status,
    ).toBe("cancelled");
    expect(toolOutcome({ type: "ls", result: { status: "success", value: { files: 3 } } }, false)).toEqual({
      status: "done",
      output: '{"files":3}',
    });
    expect(toolOutcome({ type: "ls" }, false)).toEqual({ status: "done" });
  });

  test("shell output goes to the named call, else the latest open shell", () => {
    const st = newTurnState();
    const start = (callId: string, type: string) =>
      mapUpdate(
        { type: "tool-call-started", callId, modelCallId: "m", toolCall: { type, args: {} } as never },
        st,
        () => false,
      );
    start("a", "shell");
    start("b", "read");
    start("c", "shell");
    const out = (event: Record<string, unknown>) =>
      mapUpdate({ type: "shell-output-delta", event }, st, () => false);
    expect(out({ case: "stdout", value: { data: "x" } })).toEqual([
      { type: "tool-update", callId: "c", outputDelta: "x" },
    ]);
    expect(out({ case: "stderr", value: { data: "y" }, toolCallId: "a" })).toEqual([
      { type: "tool-update", callId: "a", outputDelta: "y" },
    ]);
    expect(out({ case: "exit", value: { code: 0 } })).toEqual([]);
  });

  test("summaries are compaction events; usage tracks context and totals", () => {
    const st = newTurnState();
    expect(mapUpdate({ type: "summary-started" }, st, () => false)).toEqual([{ type: "compaction-start" }]);
    expect(mapUpdate({ type: "summary-completed", failed: true }, st, () => false)).toEqual([
      { type: "compaction-end", status: "failed" },
    ]);
    const usage = { inputTokens: 10, outputTokens: 2, cacheReadTokens: 0, cacheWriteTokens: 0 };
    mapUpdate({ type: "turn-ended", usage }, st, () => false);
    mapUpdate({ type: "turn-ended", usage }, st, () => false);
    expect([st.inputTokens, st.outputTokens, st.stepped]).toEqual([20, 4, true]);
  });
});

test("toolSet keeps the mcp family so valet's tools stay offered", () => {
  expect(toolSet({}, { hideBuiltinTools: false })).toBeUndefined();
  expect(toolSet({ tools: ["read"] }, { hideBuiltinTools: false })).toEqual(["read", "mcp"]);
  expect(toolSet({ tools: ["read", "mcp"] }, { hideBuiltinTools: true })).toEqual(["mcp"]);
});

test("EventQueue yields pushed items, then the terminal value", async () => {
  const q = new EventQueue<number, string>();
  q.push(1, 2);
  setTimeout(() => {
    q.push(3);
    q.end("done");
    q.push(4);
  }, 1);
  const got: unknown[] = [];
  for (;;) {
    const n = await q.next();
    if ("done" in n) {
      got.push(n.done);
      break;
    }
    got.push(n.item);
  }
  expect(got).toEqual([1, 2, 3, "done"]);
});
