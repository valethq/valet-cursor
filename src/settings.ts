import type { PluginContext, SettingsBlock } from "@valethq/sdk";
import {
  type CursorConfig,
  type CustomModel,
  DEFAULT_SECRET,
  DEFAULT_UTILITY_MODEL,
  MODES,
  type Mode,
} from "./config";
import type { Catalog, Preferences } from "./models";
import type { SdkDeps } from "./sdk";

type Ctx = PluginContext<CursorConfig>;

const FLAGS = ["hideBuiltinTools", "autoReview", "sandbox", "fast", "maxMode"] as const;
const KEYS = ["mode", "utilityModel", "customModels", ...FLAGS] as const;

export const secretName = (ctx: Ctx): string => ctx.config?.secret?.trim() || DEFAULT_SECRET;

/** The key from valet's secrets. Undefined lets the SDK fall back to CURSOR_API_KEY and `Cursor.auth.login()`. */
export async function apiKey(ctx: Ctx): Promise<string | undefined> {
  return (await ctx.secrets.get(secretName(ctx)))?.trim() || undefined;
}

/** Panel value wins over config.json so the UI can flip it without a restart. */
export function mode(ctx: Ctx): Mode {
  const v = ctx.storage.kv.get<string>("mode") ?? ctx.config?.mode;
  return (MODES as readonly string[]).includes(v ?? "") ? (v as Mode) : "agent";
}

/** The Utility model. Panel value wins over config.json; an empty string turns it off. */
export function utilityModel(ctx: Ctx): string | undefined {
  const v = ctx.storage.kv.get<string>("utilityModel") ?? ctx.config?.utilityModel ?? DEFAULT_UTILITY_MODEL;
  return v.trim() === "" ? undefined : v.trim();
}

/** Panel value wins over config.json. Default false: Cursor's built-in tools stay available. */
export const hideBuiltinTools = (ctx: Ctx): boolean =>
  ctx.storage.kv.get<boolean>("hideBuiltinTools") ?? ctx.config?.hideBuiltinTools ?? false;

/** Panel value wins over config.json. Undefined leaves the SDK default. */
export const autoReview = (ctx: Ctx): boolean | undefined =>
  ctx.storage.kv.get<boolean>("autoReview") ?? ctx.config?.autoReview;

/** Panel value wins over config.json. Undefined leaves the SDK default. */
export const sandbox = (ctx: Ctx): boolean | undefined =>
  ctx.storage.kv.get<boolean>("sandbox") ?? ctx.config?.sandbox;

/** Panel value wins over config.json. Default false: Cursor's standard speed. */
export const fast = (ctx: Ctx): boolean => ctx.storage.kv.get<boolean>("fast") ?? ctx.config?.fast ?? false;

/** Panel value wins over config.json. Default false: no Max-mode variants, so the standard context window. */
export const maxMode = (ctx: Ctx): boolean =>
  ctx.storage.kv.get<boolean>("maxMode") ?? ctx.config?.maxMode ?? false;

export const preferences = (ctx: Ctx): Preferences => ({
  fast: fast(ctx),
  maxMode: maxMode(ctx),
  overrides: (id) => ctx.config?.modelParams?.[id] ?? {},
});

const isCustomModel = (m: unknown): m is CustomModel =>
  typeof m === "object" &&
  m !== null &&
  typeof (m as CustomModel).id === "string" &&
  (m as CustomModel).id.trim() !== "";

/** Panel value wins over config.json. Entries without an id are dropped. */
export function customModels(ctx: Ctx): CustomModel[] {
  const v = ctx.storage.kv.get<unknown>("customModels") ?? ctx.config?.customModels;
  return Array.isArray(v)
    ? v
        .filter(isCustomModel)
        .map(({ id, name }) => ({ id: id.trim(), ...(name?.trim() && { name: name.trim() }) }))
    : [];
}

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

export function registerSettings(ctx: Ctx, deps: SdkDeps, catalog: Catalog): void {
  ctx.scopes.define({ name: "settings", version: 1, cardinality: "many" });
  ctx.scopes.provide(
    "settings",
    {
      title: "Cursor",
      description:
        "Overrides plugins.valet-cursor.config; applies to the next prompt. The API key is a secret file, not a setting.",
      view: async () => [
        { type: "group", layout: "row", blocks: await authBlocks(ctx, deps) },
        {
          type: "group",
          layout: "row",
          blocks: [
            { type: "button", label: "Reload models", action: "reloadModels" },
            {
              type: "button",
              label: "Reset to config.json",
              action: "reset",
              confirm: "Discard values saved from this panel?",
            },
          ],
        },
      ],
      refreshMs: 15_000,
      actions: {
        reloadModels: () => catalog.clear(),
        reset: () => {
          for (const k of KEYS) ctx.storage.kv.delete(k);
        },
      },
      schema: {
        type: "object",
        properties: {
          mode: {
            type: "string",
            title: "Mode",
            description: "Cursor conversation mode for each prompt.",
            enum: MODES,
            enumNames: ["Agent", "Plan"],
          },
          utilityModel: {
            type: "string",
            title: "Utility model",
            description: "Model for small side jobs such as naming sessions. Empty turns them off.",
          },
          customModels: {
            type: "array",
            title: "Custom models",
            description: 'Extra models for the picker: a Cursor model id, or "<id>-<effort>" for one effort.',
            items: {
              type: "object",
              required: ["id"],
              properties: {
                id: { type: "string", title: "Model id" },
                name: { type: "string", title: "Friendly name" },
              },
            },
          },
          fast: {
            type: "boolean",
            title: "Fast mode",
            description: "Use Cursor's fast variant on models that have one.",
          },
          maxMode: {
            type: "boolean",
            title: "Max mode",
            description: "Allow Max-mode variants: the largest context windows, billed at Max-mode rates.",
          },
          hideBuiltinTools: {
            type: "boolean",
            title: "Hide built-in tools",
            description:
              "Remove Cursor's own tools (shell, read, edit, grep, ...) so only valet's tools are offered.",
          },
          autoReview: {
            type: "boolean",
            title: "Cursor Auto-review",
            description: "Let Cursor's classifier review local tool calls.",
          },
          sandbox: {
            type: "boolean",
            title: "Cursor sandbox",
            description: "Run Cursor's shell commands in its local sandbox.",
          },
        },
      },
      get: () => ({
        mode: mode(ctx),
        utilityModel: utilityModel(ctx) ?? "",
        customModels: customModels(ctx),
        hideBuiltinTools: hideBuiltinTools(ctx),
        autoReview: autoReview(ctx) ?? false,
        sandbox: sandbox(ctx) ?? false,
        fast: fast(ctx),
        maxMode: maxMode(ctx),
      }),
      set: (v) => {
        if (
          v.mode !== undefined &&
          (typeof v.mode !== "string" || !(MODES as readonly string[]).includes(v.mode))
        )
          throw new Error(`mode must be one of: ${MODES.join(", ")}`);
        if (v.utilityModel !== undefined && typeof v.utilityModel !== "string")
          throw new Error("utilityModel must be a string");
        if (
          v.customModels !== undefined &&
          !(Array.isArray(v.customModels) && v.customModels.every(isCustomModel))
        )
          throw new Error("customModels entries need a model id");
        for (const key of FLAGS)
          if (v[key] !== undefined && typeof v[key] !== "boolean")
            throw new Error(`${key} must be true or false`);
        if (v.mode !== undefined) ctx.storage.kv.set("mode", v.mode);
        if (v.utilityModel !== undefined) ctx.storage.kv.set("utilityModel", v.utilityModel);
        if (v.customModels !== undefined) ctx.storage.kv.set("customModels", v.customModels);
        for (const key of FLAGS) if (v[key] !== undefined) ctx.storage.kv.set(key, v[key]);
      },
    },
    { key: "valet-cursor" },
  );
}
