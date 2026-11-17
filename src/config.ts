import type { SettingSource, ToolName } from "@cursor/sdk";

export type Mode = "agent" | "plan";
export const MODES: readonly Mode[] = ["agent", "plan"];

export interface ModelConfig {
  /** Picker id: a Cursor model id, optionally with variant params as "<id>?<param>=<value>&...". */
  id: string;
  name?: string;
  contextWindow?: number;
  maxOutputTokens?: number;
}

/** A model the user adds by hand; `id` goes to Cursor unchanged (params included), `name` is the picker label. */
export interface CustomModel {
  id: string;
  name?: string;
}

export interface CursorConfig {
  /** Secret holding the Cursor API key: ~/.valet/secrets/<name>, then the env var <NAME>. Default "cursor_api_key". */
  secret?: string;
  /** Conversation mode for each send. Also in the settings panel. Default "agent". */
  mode?: Mode;
  /** Built-in tools Cursor may never offer (SDK `disallowedTools`), e.g. ["shell"]. */
  denyTools?: ToolName[];
  /** Base set of built-in tools (SDK `tools`). Unset keeps Cursor's defaults. "mcp" is added so valet's tools stay. */
  tools?: ToolName[];
  /** Offer only valet's tools (`tools: ["mcp"]`). Wins over `tools`. Also in the settings panel. Default false. */
  hideBuiltinTools?: boolean;
  /** Cursor's Auto-review classifier for local tool calls. Also in the settings panel. Unset keeps the SDK default. */
  autoReview?: boolean;
  /** Cursor's local sandbox for shell commands. Also in the settings panel. Unset keeps the SDK default. */
  sandbox?: boolean;
  /** Cursor settings layers to load. Default none: valet supplies the persona and AGENTS.md. */
  settingSources?: SettingSource[];
  /** Close an idle agent after this long; the next prompt resumes it. 0 disables. Default 15 min. */
  idleCloseMs?: number;
  /** Model for small side jobs such as session naming. Empty string turns them off. */
  utilityModel?: string;
  /** Replaces the model list. Unset: Cursor's catalog when a key is available, else the built-in list. */
  models?: ModelConfig[];
  /** Extra picker entries added to the model list. Also in the settings panel. */
  customModels?: CustomModel[];
}

export const DEFAULT_SECRET = "cursor_api_key";

export const DEFAULT_LIMITS = { contextWindow: 200_000, maxOutputTokens: 64_000 } as const;

/** Offered when no key is available or the catalog call fails. */
export const DEFAULT_MODELS: ModelConfig[] = [
  { id: "composer-2.5", name: "Composer 2.5" },
  { id: "composer-2", name: "Composer 2" },
];

export const DEFAULT_UTILITY_MODEL = "composer-2";

export const DEFAULT_IDLE_CLOSE_MS = 15 * 60_000;

/** How long the model catalog is reused before Cursor is asked again. */
export const CATALOG_TTL_MS = 10 * 60_000;
