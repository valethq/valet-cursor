import type { AgentEvent, AgentProvider, PluginContext, SettingsPanel, ToolSurface } from "@valethq/sdk";
import type { CursorConfig } from "../src/config";
import { createCatalog } from "../src/models";
import { createProvider } from "../src/provider";
import type { SdkDeps } from "../src/sdk";
import { registerSettings } from "../src/settings";

export function fakeCtx(
  config: CursorConfig,
  deps: SdkDeps,
  opts: { blobs?: Record<string, string>; secrets?: Record<string, string> } = {},
) {
  const state: Record<string, unknown> = {};
  const kv = new Map<string, unknown>();
  const panels: SettingsPanel[] = [];
  const logs: { level: string; msg: string; data?: Record<string, unknown> }[] = [];
  const logger = (level: string) => (msg: string, data?: Record<string, unknown>) =>
    logs.push({ level, msg, data });
  const ctx = {
    config,
    plugin: { id: "valet-cursor", version: "0.1.0" },
    log: { debug: logger("debug"), info: logger("info"), warn: logger("warn"), error: logger("error") },
    secrets: {
      get: async (name: string) => (opts.secrets ?? { cursor_api_key: "test-key" })[name],
    },
    scopes: {
      define: () => undefined,
      provide: (scope: string, value: unknown) => {
        if (scope === "settings") panels.push(value as SettingsPanel);
        return { dispose() {} };
      },
    },
    storage: {
      kv: {
        get: <T>(k: string) => kv.get(k) as T | undefined,
        set: (k: string, v: unknown) => void kv.set(k, v),
        delete: (k: string) => void kv.delete(k),
        list: () => [...kv.keys()],
      },
    },
    store: {
      sessions: {
        get: () => ({ projectId: "p1" }),
        setProviderState: (id: string, provider: string, s: unknown) => {
          state[`${id}:${provider}`] = s;
        },
      },
      projects: { get: () => ({ workspaceDir: "/tmp" }) },
      blobs: {
        path: (id: string) => {
          const p = opts.blobs?.[id];
          if (p === undefined) throw new Error(`unknown blob "${id}"`);
          return p;
        },
      },
    },
  } as unknown as PluginContext<CursorConfig>;
  const catalog = createCatalog(
    async () => deps.listModels(),
    () => undefined,
  );
  const { provider, dispose } = createProvider(ctx, catalog, deps);
  registerSettings(ctx, deps, catalog);
  return {
    provider: provider as AgentProvider,
    state,
    logs,
    kv,
    dispose,
    ctx,
    panel: () => panels[0] as SettingsPanel,
  };
}

export async function collect(it: AsyncIterable<AgentEvent>): Promise<AgentEvent[]> {
  const events: AgentEvent[] = [];
  for await (const e of it) events.push(e);
  return events;
}

export const input = (t: string, preamble?: string) => ({
  content: [{ type: "text" as const, text: t }],
  ...(preamble && { preamble }),
});

export const noTools: ToolSurface = {
  list: () => [],
  call: async () => ({ content: [] }),
  authorize: async (_name, input) => ({ input }),
};

export const open = (h: ReturnType<typeof fakeCtx>, extra: Record<string, unknown> = {}) =>
  h.provider.open({
    sessionId: "s1",
    cwd: "/tmp",
    model: "composer-2.5",
    tools: noTools,
    signal: new AbortController().signal,
    ...extra,
  });

export const texts = (events: AgentEvent[]) =>
  events.flatMap((e) => (e.type === "text-delta" ? [e.text] : [])).join("");
