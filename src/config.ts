import type { SettingSource, ToolName } from "@cursor/sdk";

export type Mode = "agent" | "plan";
export const MODES: readonly Mode[] = ["agent", "plan"];

/** Effort words valet's picker and ModelOptions use (Cursor's "extra-high" is shown as "xhigh"). */
export const EFFORTS = ["none", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
export type Effort = (typeof EFFORTS)[number];

export interface ModelConfig {
  /** Cursor model id. */
  id: string;
  name?: string;
  contextWindow?: number;
  maxOutputTokens?: number;
  /** Effort levels the model takes. Unset = none to pick. */
  efforts?: Effort[];
  /** The effort a selection without one runs at. */
  defaultEffort?: Effort;
  /** Cursor param the effort is sent as when the catalog doesn't know the model. Default "effort". */
  effortParam?: string;
  /** Cursor's fast mode (`fast=true`) is available for this model. */
  fast?: boolean;
  /** Fast mode is on unless the selection turns it off. */
  fastByDefault?: boolean;
}

export interface CursorConfig {
  /** Secret holding the Cursor API key: ~/.valet/secrets/<name>, then the env var <NAME>. Default "cursor_api_key". */
  secret?: string;
  /** Conversation mode for each send. Default "agent". */
  mode?: Mode;
  /** Built-in tools Cursor may never offer (SDK `disallowedTools`), e.g. ["shell"]. */
  denyTools?: ToolName[];
  /** Base set of built-in tools (SDK `tools`). Unset keeps Cursor's defaults. "mcp" is added so valet's tools stay. */
  tools?: ToolName[];
  /** Offer only valet's tools (`tools: ["mcp"]`). Wins over `tools`. Default false. */
  hideBuiltinTools?: boolean;
  /** Cursor's Auto-review classifier for local tool calls. Unset keeps the SDK default. */
  autoReview?: boolean;
  /** Cursor's local sandbox for shell commands. Unset keeps the SDK default. */
  sandbox?: boolean;
  /** Cursor settings layers to load. Default none: valet supplies the persona and AGENTS.md. */
  settingSources?: SettingSource[];
  /** Close an idle agent after this long; the next prompt resumes it. 0 disables. Default 15 min. */
  idleCloseMs?: number;
  /** Allow Max-mode variants (the large context windows, billed higher). Default false. */
  maxMode?: boolean;
  /** Leave Cursor's Auto model (`default`) out of the picker; sessions already on it keep running. Default false. */
  hideAuto?: boolean;
  /** Per-model Cursor params that win over the picker, e.g. { "claude-opus-4-8": { "thinking": "false" } }. */
  modelParams?: Record<string, Record<string, string>>;
  /** Model for small side jobs such as session naming. Empty string turns them off. */
  utilityModel?: string;
  /** Replaces the model list. Unset: Cursor's catalog when a key is available, else the built-in list. */
  models?: ModelConfig[];
}

export const DEFAULT_SECRET = "cursor_api_key";

export const DEFAULT_LIMITS = { contextWindow: 200_000, maxOutputTokens: 64_000 } as const;

/** Offered when no key is available or the catalog call fails. */
export const DEFAULT_MODELS: ModelConfig[] = [
  { id: "composer-2.5", name: "Composer 2.5", fast: true, fastByDefault: true },
  { id: "composer-2", name: "Composer 2", fast: true },
];

export const DEFAULT_UTILITY_MODEL = "composer-2";

export const DEFAULT_IDLE_CLOSE_MS = 15 * 60_000;

/** How long the model catalog is reused before Cursor is asked again. */
export const CATALOG_TTL_MS = 10 * 60_000;
