import { describe, expect, test } from "bun:test";
import type { ModelListItem } from "@cursor/sdk";
import { EventQueue } from "../src/channel";
import { DEFAULT_MODELS } from "../src/config";
import { mapUpdate, newTurnState, toolInfo, toolOutcome } from "../src/events";
import {
  catalogEntries,
  configEntries,
  contextTokens,
  createCatalog,
  DEFAULT_PREFERENCES,
  modelLister,
  selectModel,
} from "../src/models";
import { toolSet } from "../src/session";
import { CATALOG } from "./catalog";

describe("models", () => {
  const sonnet = CATALOG[0] as ModelListItem;
  const gpt = CATALOG[1] as ModelListItem;
  const param = (sel: { params?: { id: string; value: string }[] }, id: string) =>
    sel.params?.find((p) => p.id === id)?.value;

  test("each catalog model is one family, with one row per effort", () => {
    expect(catalogEntries(sonnet)).toEqual(
      ["low", "medium", "high", "xhigh", "max"].map((e) => ({
        id: `claude-sonnet-5-${e}`,
        name: `Claude Sonnet 5 (${e})`,
        contextWindow: 300_000,
      })),
    );
    expect(catalogEntries(gpt).map((m) => m.id)).toEqual([
      "gpt-5.5-none",
      "gpt-5.5-low",
      "gpt-5.5-medium",
      "gpt-5.5-high",
      "gpt-5.5-xhigh",
    ]);
    expect(catalogEntries(CATALOG[2] as ModelListItem)).toEqual([
      { id: "composer-2.5", name: "Composer 2.5" },
    ]);
    expect(catalogEntries(sonnet, { ...DEFAULT_PREFERENCES, maxMode: true })[0]?.contextWindow).toBe(
      1_000_000,
    );
  });

  test("the effort picks Cursor's effort param; other params default to non-Max, non-fast", () => {
    const s = selectModel("claude-sonnet-5-xhigh", CATALOG, undefined);
    expect(s.id).toBe("claude-sonnet-5");
    expect([param(s, "effort"), param(s, "context"), param(s, "thinking")]).toEqual([
      "xhigh",
      "300k",
      "true",
    ]);
    const g = selectModel("gpt-5.5-xhigh", CATALOG, undefined);
    expect([param(g, "reasoning"), param(g, "context"), param(g, "fast")]).toEqual([
      "extra-high",
      "272k",
      "false",
    ]);
    const fastMax = selectModel("gpt-5.5-low", CATALOG, undefined, {
      ...DEFAULT_PREFERENCES,
      fast: true,
      maxMode: true,
    });
    expect([param(fastMax, "reasoning"), param(fastMax, "context"), param(fastMax, "fast")]).toEqual([
      "low",
      "1m",
      "true",
    ]);
    expect(param(selectModel("composer-2.5", CATALOG, undefined), "fast")).toBe("false");
    expect(selectModel("default", CATALOG, undefined)).toEqual({ id: "default" });
  });

  test("a bare id runs the catalog's default effort; overrides win", () => {
    const s = selectModel("claude-sonnet-5", CATALOG, undefined);
    expect([param(s, "effort"), param(s, "context")]).toEqual(["high", "300k"]);
    const o = selectModel("claude-sonnet-5-low", CATALOG, undefined, {
      ...DEFAULT_PREFERENCES,
      overrides: () => ({ thinking: "false" }),
    });
    expect([param(o, "effort"), param(o, "thinking")]).toEqual(["low", "false"]);
  });

  test("legacy, config and unknown ids", () => {
    expect(selectModel("gpt-5.5?reasoning=high&fast=true", CATALOG, undefined)).toEqual({
      id: "gpt-5.5",
      params: [
        { id: "reasoning", value: "high" },
        { id: "fast", value: "true" },
      ],
    });
    expect(
      selectModel("mine-high", CATALOG, [{ id: "mine", efforts: ["high"], effortParam: "reasoning" }]),
    ).toEqual({
      id: "mine",
      params: [{ id: "reasoning", value: "high" }],
    });
    expect(selectModel("someone-else-high", CATALOG, undefined)).toEqual({ id: "someone-else-high" });
    expect(selectModel("claude-sonnet-5-high", undefined, undefined)).toEqual({ id: "claude-sonnet-5" });
    expect(configEntries({ id: "mine", name: "Mine", efforts: ["low", "high"] }).map((m) => m.name)).toEqual([
      "Mine (low)",
      "Mine (high)",
    ]);
    expect(contextTokens("272k")).toBe(272_000);
    expect(contextTokens("1m")).toBe(1_000_000);
    expect(contextTokens("lots")).toBeUndefined();
  });

  test("the lister prefers config, then the catalog, then the built-in list, plus custom models", async () => {
    let calls = 0;
    let list: ModelListItem[] | undefined;
    const errors: string[] = [];
    const catalog = createCatalog(
      async () => {
        calls++;
        if (list === undefined) throw new Error("no key");
        return list;
      },
      (e) => errors.push(e.message),
    );
    const custom = () => [{ id: "my-model" }, { id: "composer-2.5" }];
    const ids = async (cfg = {}) => (await modelLister(() => cfg, catalog, custom)()).map((m) => m.id);
    expect(await ids()).toEqual([...DEFAULT_MODELS.map((m) => m.id), "my-model"]);
    expect(errors).toEqual(["no key"]);
    await ids();
    expect(calls).toBe(1);
    catalog.clear();
    list = CATALOG;
    const all = await ids();
    expect(all.filter((id) => id.startsWith("claude-sonnet-5"))).toHaveLength(5);
    expect(all.slice(-2)).toEqual(["default", "my-model"]);
    expect(await ids({ models: [{ id: "only", efforts: ["low"] }] })).toEqual([
      "only-low",
      "my-model",
      "composer-2.5",
    ]);
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
