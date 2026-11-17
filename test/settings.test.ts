import { expect, test } from "bun:test";
import type { SettingsBlock } from "@valethq/sdk";
import { fakeSdk, say } from "./fake-sdk";
import { collect, fakeCtx, input, open } from "./helpers";

const ac = () => new AbortController().signal;

const badge = async (h: ReturnType<typeof fakeCtx>) => {
  const blocks = (await h.panel().view?.()) ?? [];
  const row = blocks[0] as Extract<SettingsBlock, { type: "group" }>;
  return row.blocks[0];
};

test("panel values override config and apply to the next prompt", async () => {
  const { deps, agents, sends } = fakeSdk(() => say("ok"));
  const h = fakeCtx({ mode: "plan", autoReview: true }, deps);
  const panel = h.panel();
  expect(await panel.get?.()).toEqual({
    mode: "plan",
    utilityModel: "composer-2",
    customModels: [],
    hideBuiltinTools: false,
    autoReview: true,
    sandbox: false,
  });
  await panel.set?.({
    mode: "agent",
    sandbox: true,
    hideBuiltinTools: true,
    customModels: [{ id: " m1 ", name: "M" }],
  });
  const s = await open(h);
  await collect(s.prompt(input("hi"), ac()));
  expect(sends[0]?.options.mode).toBe("agent");
  expect(agents[0]?.options.local).toEqual({
    cwd: "/tmp",
    settingSources: [],
    autoReview: true,
    sandboxOptions: { enabled: true },
  });
  expect(agents[0]?.options.tools).toEqual(["mcp"]);
  expect((await h.provider.listModels()).map((m) => m.id)).toContain("m1");
  await panel.actions?.reset?.({});
  expect((await panel.get?.())?.mode).toBe("plan");
});

test("set rejects bad values", async () => {
  const panel = fakeCtx({}, fakeSdk(() => say("x")).deps).panel();
  expect(() => panel.set?.({ mode: "yolo" })).toThrow("mode must be one of");
  expect(() => panel.set?.({ sandbox: "yes" })).toThrow("sandbox must be true or false");
  expect(() => panel.set?.({ customModels: [{ name: "no id" }] })).toThrow("need a model id");
  expect(() => panel.set?.({ utilityModel: 3 })).toThrow("utilityModel must be a string");
});

test("the view reports where the key comes from", async () => {
  const { deps } = fakeSdk(() => say("x"));
  expect(await badge(fakeCtx({}, deps, { secrets: { cursor_api_key: "k" } }))).toEqual({
    type: "badge",
    text: "API key found",
    tone: "good",
  });
  expect(await badge(fakeCtx({}, deps, { secrets: {} }))).toEqual({
    type: "badge",
    text: "No API key",
    tone: "critical",
  });
  const loggedIn = fakeSdk(() => say("x"), { auth: async () => ({ status: "logged-in", email: "a@b.c" }) });
  expect(await badge(fakeCtx({}, loggedIn.deps, { secrets: {} }))).toEqual({
    type: "badge",
    text: "Cursor login: a@b.c",
    tone: "good",
  });
});

test("the utility model runs one tool-free send and returns its text", async () => {
  const { deps, agents, sends } = fakeSdk(async function* () {
    yield* say("Session name");
    return { result: "  Session name \n" };
  });
  const h = fakeCtx({}, deps);
  const out = await h.provider.utility?.complete({ system: "Name it.", prompt: "chat" }, ac());
  expect(out).toBe("Session name");
  expect(sends[0]?.text).toBe("Name it.\n\nchat");
  expect(agents[0]?.options.tools).toEqual([]);
  expect(agents[0]?.closed).toBe(true);
  await h.panel().set?.({ utilityModel: "" });
  expect(h.provider.utility?.model()).toBeUndefined();
  expect(h.provider.utility?.complete({ system: "", prompt: "" }, ac())).rejects.toThrow("no utility model");
});
