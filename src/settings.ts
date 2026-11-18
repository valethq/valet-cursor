import type { PluginContext, SettingsBlock } from "@valethq/sdk";
import { type CursorConfig, DEFAULT_SECRET, DEFAULT_UTILITY_MODEL, MODES, type Mode } from "./config";
import type { Catalog, Preferences } from "./models";
import type { SdkDeps } from "./sdk";

type Ctx = PluginContext<CursorConfig>;

// Settings are config (12.1): core fills in the manifest's defaults, so these fallbacks only matter without it.

export const secretName = (ctx: Ctx): string => ctx.config?.secret?.trim() || DEFAULT_SECRET;

/** The key from valet's secrets. Undefined lets the SDK fall back to CURSOR_API_KEY and `Cursor.auth.login()`. */
export async function apiKey(ctx: Ctx): Promise<string | undefined> {
  return (await ctx.secrets.get(secretName(ctx)))?.trim() || undefined;
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

async function authBlocks(ctx: Ctx, deps: SdkDeps): Promise<SettingsBlock[]> {
  const name = secretName(ctx);
  const where: SettingsBlock = { type: "text", text: `~/.valet/secrets/${name} or ${name.toUpperCase()}` };
  if (await apiKey(ctx)) return [{ type: "badge", text: "API key found", tone: "good" }, where];
  const status = await deps.authStatus().catch(() => ({ status: "logged-out" as const }));
  if (status.status === "logged-in")
    return [
      { type: "badge", text: status.email ? `Cursor login: ${status.email}` : "Cursor login", tone: "good" },
      where,
    ];
  return [{ type: "badge", text: "No API key", tone: "critical" }, where];
}

/** Auth status and a reload action above the config form; settings themselves are config. */
export function registerSettings(ctx: Ctx, deps: SdkDeps, catalog: Catalog): void {
  ctx.scopes.define({ name: "settings", version: 1, cardinality: "many" });
  ctx.onConfigChange(() => {}); // every value is read from ctx.config when it is used
  ctx.scopes.provide(
    "settings",
    {
      title: "Cursor",
      description: "The API key is a secret file, not a setting.",
      view: async () => [
        { type: "group", layout: "row", blocks: await authBlocks(ctx, deps) },
        {
          type: "group",
          layout: "row",
          blocks: [{ type: "button", label: "Reload models", action: "reloadModels" }],
        },
      ],
      refreshMs: 15_000,
      actions: {
        reloadModels: () => catalog.clear(),
      },
    },
    { key: "valet-cursor" },
  );
}
