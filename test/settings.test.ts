// biome-ignore-all lint/suspicious/noTemplateCurlyInString: settings refs are written ${resolver:arg}
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Display, PluginContext, Setting, SettingsContribution } from "@valethq/sdk";
import type { CursorConfig } from "../src/config";
import { hideAuto, hideBuiltinTools, maxMode, mode, registerSettings, utilityModel } from "../src/settings";
import { CATALOG } from "./catalog";
import { fakeSdk, say } from "./fake-sdk";
import { collect, fakeCtx, input, open } from "./helpers";

const ac = () => new AbortController().signal;

function ctxWith(config: CursorConfig) {
  const { ctx } = fakeCtx(config, fakeSdk(() => say("x")).deps);
  return ctx as unknown as PluginContext<CursorConfig>;
}

const manifest = JSON.parse(readFileSync(join(import.meta.dir, "..", "manifest.json"), "utf8"));
const props: Record<string, { default?: unknown }> = {};
for (const sub of manifest.settings.sections.inference.subsections)
  for (const item of sub.items as Setting[]) if (item.input) props[item.id] = { default: item.input.default };

const account = async (h: ReturnType<typeof fakeCtx>): Promise<Display[]> =>
  (await h.panel().subsections?.())?.find((s) => s.id === "account")?.items as Display[];
const badge = async (h: ReturnType<typeof fakeCtx>) => (await account(h))[0];

describe("settings are config", () => {
  test("accessors fall back to the same defaults the manifest declares", () => {
    const ctx = ctxWith({});
    expect(mode(ctx)).toBe(props.mode?.default as "agent");
    expect(hideBuiltinTools(ctx)).toBe(props.hideBuiltinTools?.default as boolean);
    expect(maxMode(ctx)).toBe(props.maxMode?.default as boolean);
    expect(hideAuto(ctx)).toBe(props.hideAuto?.default as boolean);
    expect(utilityModel(ctx)).toBe(props.utilityModel?.default as string);
  });

  test("config values win; an empty utility model turns side jobs off", () => {
    const ctx = ctxWith({
      mode: "plan",
      hideBuiltinTools: true,
      maxMode: true,
      hideAuto: true,
      utilityModel: " ",
    });
    expect(mode(ctx)).toBe("plan");
    expect(hideBuiltinTools(ctx)).toBe(true);
    expect(maxMode(ctx)).toBe(true);
    expect(hideAuto(ctx)).toBe(true);
    expect(utilityModel(ctx)).toBeUndefined();
  });

  test("the manifest no longer carries a global fast toggle or custom models", () => {
    expect(props.fast).toBeUndefined();
    expect(props.customModels).toBeUndefined();
  });
});

describe("settings@2 contribution", () => {
  test("account and plan usage are runtime subsections; reload and refresh are actions", async () => {
    const { deps } = fakeSdk(() => say("x"));
    const registered: SettingsContribution[] = [];
    const ctx = fakeCtx({}, deps).ctx;
    registerSettings(
      {
        ...ctx,
        config: ctx.config,
        onConfigChange() {},
        scopes: {
          define() {},
          provide(_s: string, impl: SettingsContribution) {
            registered.push(impl);
            return { dispose() {} };
          },
        },
      } as unknown as PluginContext<CursorConfig>,
      deps,
      { get: async () => undefined, clear() {} },
    );
    expect(registered).toHaveLength(1);
    const subs = (await registered[0]?.subsections?.()) ?? [];
    expect(subs.map((s) => [s.id, s.label, s.refreshMs])).toEqual([
      ["account", "Account", 15_000],
      ["usage", "Plan usage", 15_000],
    ]);
    expect(subs[0]?.items.at(-1)).toEqual({ type: "action", text: "Reload models", action: "reloadModels" });
    expect(typeof registered[0]?.actions?.refresh).toBe("function");
  });

  test("the old secret name migrates to an apiKey ref", () => {
    const apiKey = (manifest.settings.sections.inference.subsections as { items: Setting[] }[])
      .flatMap((s) => s.items)
      .find((s) => s.id === "apiKey");
    expect(apiKey?.input).toEqual({ type: "secret", default: "${secret:cursor_api_key}" });
    expect(apiKey?.migrate).toEqual([{ from: "secret", map: { template: "${secret:{}}" } }]);
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
});

test("setConfig applies to the next prompt", async () => {
  const { deps, agents, sends } = fakeSdk(() => say("ok"));
  const h = fakeCtx({ mode: "plan", autoReview: true }, deps);
  h.setConfig({ mode: "agent", sandbox: true, hideBuiltinTools: true });
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
  h.setConfig({ utilityModel: "" });
  expect(h.provider.utility?.model()).toBeUndefined();
  expect(h.provider.utility?.complete({ system: "", prompt: "" }, ac())).rejects.toThrow("no utility model");
});

test("Max mode from config changes the advertised window; fast is a model option", async () => {
  const { deps, sends } = fakeSdk(() => say("ok"), { models: async () => CATALOG });
  const h = fakeCtx({ modelParams: { "claude-sonnet-5": { thinking: "false" } } }, deps);
  const window = async () =>
    (await h.provider.listModels()).find((m) => m.id === "claude-sonnet-5")?.contextWindow;
  expect(await window()).toBe(300_000);
  h.setConfig({ maxMode: true });
  h.panel().actions?.reloadModels?.({});
  expect(await window()).toBe(1_000_000);
  const s = await open(h, { model: "claude-sonnet-5", effort: "high", fast: true });
  await collect(s.prompt(input("hi"), ac()));
  expect(sends[0]?.options.model).toEqual({
    id: "claude-sonnet-5",
    params: [
      { id: "thinking", value: "false" },
      { id: "context", value: "1m" },
      { id: "effort", value: "high" },
    ],
  });
});

test("hideAuto drops Auto from the picker, but a session on it still runs", async () => {
  const { deps, sends } = fakeSdk(() => say("ok"), { models: async () => CATALOG });
  const h = fakeCtx({}, deps);
  const ids = async () => (await h.provider.listModels()).map((m) => m.id);
  expect(await ids()).toContain("default");
  h.setConfig({ hideAuto: true });
  expect(await ids()).not.toContain("default");
  expect(await ids()).toContain("composer-2.5");
  const s = await open(h, { model: "default" });
  expect((await collect(s.prompt(input("hi"), ac()))).at(-1)).toEqual({ type: "finish", reason: "stop" });
  expect(sends[0]?.options.model).toEqual({ id: "default" });
});

test("hideAuto from config.json", async () => {
  const h = fakeCtx({ hideAuto: true }, fakeSdk(() => say("ok"), { models: async () => CATALOG }).deps);
  expect((await h.provider.listModels()).map((m) => m.id)).not.toContain("default");
  h.setConfig({ hideAuto: false });
  expect((await h.provider.listModels()).map((m) => m.id)).toContain("default");
});
