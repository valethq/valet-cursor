import type { Display, PluginContext, RuntimeSubsection } from "@valethq/sdk";
import { type CursorConfig, DEFAULT_SECRET, DEFAULT_UTILITY_MODEL, MODES, type Mode } from "./config";
import type { Catalog, Preferences } from "./models";
import type { SdkDeps } from "./sdk";
import { createUsage } from "./usage";

type Ctx = PluginContext<CursorConfig>;

// Settings are config (12.1): core fills in the manifest's defaults, so these fallbacks only matter without it.

/** The key from the apiKey setting. Undefined lets the SDK fall back to CURSOR_API_KEY and `Cursor.auth.login()`. */
export async function apiKey(ctx: Ctx): Promise<string | undefined> {
  return ctx.config?.apiKey?.trim() || undefined;
}

export function mode(ctx: Ctx): Mode {
  const v = ctx.config?.mode;
  return (MODES as readonly string[]).includes(v ?? "") ? (v as Mode) : "agent";
}

/** The Utility model; an empty string turns it off. */
export function utilityModel(ctx: Ctx): string | undefined {
  const v = (ctx.config?.utilityModel ?? DEFAULT_UTILITY_MODEL).trim();
  return v === "" ? undefined : v;
}

export const hideBuiltinTools = (ctx: Ctx): boolean => ctx.config?.hideBuiltinTools ?? false;

/** Undefined leaves the SDK default. */
export const autoReview = (ctx: Ctx): boolean | undefined => ctx.config?.autoReview;

/** Undefined leaves the SDK default. */
export const sandbox = (ctx: Ctx): boolean | undefined => ctx.config?.sandbox;

/** Allow Max-mode variants (large context windows). Default false. */
export const maxMode = (ctx: Ctx): boolean => ctx.config?.maxMode ?? false;

/** Leave Cursor's Auto model out of the picker. Default false. */
export const hideAuto = (ctx: Ctx): boolean => ctx.config?.hideAuto ?? false;

export const preferences = (ctx: Ctx): Preferences => ({
  maxMode: maxMode(ctx),
  hideAuto: hideAuto(ctx),
  overrides: (id) => ctx.config?.modelParams?.[id] ?? {},
});

async function authItems(ctx: Ctx, deps: SdkDeps): Promise<Display[]> {
  if (await apiKey(ctx)) return [{ type: "badge", text: "API key found", tone: "good" }];
  const status = await deps.authStatus().catch(() => ({ status: "logged-out" as const }));
  if (status.status === "logged-in")
    return [
      { type: "badge", text: status.email ? `Cursor login: ${status.email}` : "Cursor login", tone: "good" },
    ];
  return [
    { type: "badge", text: "No API key", tone: "critical" },
    { type: "note", text: `Set the API key above, or put one in ~/.valet/secrets/${DEFAULT_SECRET}.` },
  ];
}

/** Auth status with a reload action, and live plan usage, as runtime subsections (settings@2). */
export function registerSettings(ctx: Ctx, deps: SdkDeps, catalog: Catalog): void {
  const usage = createUsage(ctx, { key: () => apiKey(ctx) });
  ctx.scopes.define({ name: "settings", version: 2, cardinality: "many" });
  ctx.onConfigChange(() => {}); // every value is read from ctx.config when it is used
  ctx.scopes.provide("settings", {
    actions: {
      reloadModels: () => catalog.clear(),
      refresh: () => usage.refresh(true),
    },
    subsections: async (): Promise<RuntimeSubsection[]> => [
      {
        id: "account",
        label: "Account",
        order: -1,
        refreshMs: 15_000,
        items: [
          ...(await authItems(ctx, deps)),
          { type: "action", text: "Reload models", action: "reloadModels" },
        ],
      },
      { id: "usage", label: "Plan usage", order: -1, refreshMs: 15_000, items: await usage.view() },
    ],
  });
}
