import type { ModelListItem, ModelParameterDefinition, ModelSelection, ModelVariant } from "@cursor/sdk";
import type { ModelInfo } from "@valethq/sdk";
import {
  CATALOG_TTL_MS,
  type CursorConfig,
  type CustomModel,
  DEFAULT_LIMITS,
  DEFAULT_MODELS,
  type ModelConfig,
} from "./config";

/** Cursor's name for a model's effort knob differs by vendor; the first one a model has is used. */
export const EFFORT_PARAMS = ["effort", "reasoning_effort", "reasoning"] as const;

/** The effort words valet's picker groups as "<family>-<effort>" (valet-ui `familyOf`). */
const PICKER_EFFORTS = ["none", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
const EFFORT_SUFFIX = new RegExp(`-(${PICKER_EFFORTS.join("|")})$`);
const WORDS: Record<string, string> = { "extra-high": "xhigh" };

/** Picker word for a Cursor effort value: "extra-high" -> "xhigh"; the rest pass through. */
export const effortWord = (value: string): string => WORDS[value] ?? value;

/** Settings that pick a variant's non-effort params. */
export interface Preferences {
  /** Cursor fast mode (`fast=true`) where a model has it. */
  fast: boolean;
  /** Allow Max-mode variants, which carry the large context windows. */
  maxMode: boolean;
  /** Leave Cursor's Auto model out of the catalog list. It still runs when a session names it. */
  hideAuto: boolean;
  /** Per-model param values that win over everything else, e.g. { thinking: "false" }. */
  overrides(modelId: string): Record<string, string>;
}

export const DEFAULT_PREFERENCES: Preferences = {
  fast: false,
  maxMode: false,
  hideAuto: false,
  overrides: () => ({}),
};

/** Cursor's Auto model, which picks a model per request. */
export const AUTO_MODEL = "default";

export function effortParam(item: ModelListItem): ModelParameterDefinition | undefined {
  for (const id of EFFORT_PARAMS) {
    const p = item.parameters?.find((d) => d.id === id);
    if (p?.values.length) return p;
  }
  return undefined;
}

/** "272k" -> 272000, "1m" -> 1000000. */
export function contextTokens(value: string | undefined): number | undefined {
  const m = /^(\d+(?:\.\d+)?)([km])$/i.exec(value ?? "");
  if (!m) return undefined;
  return Math.round(Number(m[1]) * (m[2]?.toLowerCase() === "m" ? 1_000_000 : 1_000));
}

const paramsOf = (v: ModelVariant) => new Map(v.params.map((p) => [p.id, p.value]));

/**
 * The variant to run for an effort value: the effort and any per-model overrides must match, then fast
 * mode as set, then non-Max unless Max mode is on, then the largest context, then the catalog default.
 */
export function pickVariant(
  item: ModelListItem,
  effort: string | undefined,
  prefs: Preferences = DEFAULT_PREFERENCES,
): ModelVariant | undefined {
  const variants = item.variants ?? [];
  const knob = effortParam(item)?.id;
  const overrides = Object.entries(prefs.overrides(item.id));
  const defaults = paramsOf(
    variants.find((v) => v.isDefault) ?? variants[0] ?? { params: [], displayName: "" },
  );
  const hasFast = item.parameters?.some((p) => p.id === "fast") ?? false;
  const score = (v: ModelVariant): number => {
    const p = paramsOf(v);
    let s = 0;
    if (knob && effort !== undefined && p.get(knob) === effort) s += 100_000;
    s += 10_000 * overrides.filter(([k, val]) => p.get(k) === val).length;
    if (hasFast && p.get("fast") === String(prefs.fast)) s += 1_000;
    if (!!v.isMaxMode === prefs.maxMode) s += 500;
    s += Math.min(400, Math.floor((contextTokens(p.get("context")) ?? 0) / 5_000));
    s += [...defaults].filter(([k, val]) => p.get(k) === val).length;
    return s;
  };
  let best: ModelVariant | undefined;
  for (const v of variants) if (!best || score(v) > score(best)) best = v;
  return best;
}

const selection = (id: string, v: ModelVariant | undefined): ModelSelection =>
  v?.params.length ? { id, params: v.params } : { id };

/**
 * One picker row per catalog model, or one per effort as "<id>-<effort>" so valet's picker shows them as
 * one model with an effort menu. Fast, context and thinking come from the settings, not extra rows.
 */
export function catalogEntries(item: ModelListItem, prefs: Preferences = DEFAULT_PREFERENCES): ModelConfig[] {
  const knob = effortParam(item);
  const windowOf = (effort?: string) => {
    const v = pickVariant(item, effort, prefs);
    return contextTokens(v && paramsOf(v).get("context"));
  };
  const entry = (id: string, name: string, effort?: string): ModelConfig => {
    const contextWindow = windowOf(effort);
    return { id, name, ...(contextWindow && { contextWindow }) };
  };
  if (!knob) return [entry(item.id, item.displayName)];
  return knob.values.map((v) =>
    entry(`${item.id}-${effortWord(v.value)}`, `${item.displayName} (${effortWord(v.value)})`, v.value),
  );
}

/** Picker entries for a config model: one per declared effort, else the bare id. */
export function configEntries(m: ModelConfig): ModelConfig[] {
  if (!m.efforts?.length) return [m];
  return m.efforts.map((e) => ({ ...m, id: `${m.id}-${e}`, name: `${m.name ?? m.id} (${e})` }));
}

/** Legacy picker ids from 0.1.0: "gpt-5.5?reasoning=high" -> { id, params } as written. */
function legacySelection(pickerId: string): ModelSelection {
  const q = pickerId.indexOf("?");
  const params = [...new URLSearchParams(pickerId.slice(q + 1))].map(([id, value]) => ({ id, value }));
  return { id: pickerId.slice(0, q), ...(params.length && { params }) };
}

/**
 * Turns a picker id into what Cursor runs. "<id>-<effort>" sets the model's effort param to that value; a bare
 * id runs the catalog default effort. Other params follow `prefs`. Unknown ids go to Cursor unchanged.
 */
export function selectModel(
  pickerId: string,
  items: ModelListItem[] | undefined,
  configModels: ModelConfig[] | undefined,
  prefs: Preferences = DEFAULT_PREFERENCES,
): ModelSelection {
  if (pickerId.includes("?")) return legacySelection(pickerId);
  const exact = items?.find((m) => m.id === pickerId);
  if (exact) {
    const knob = effortParam(exact)?.id;
    const variants = exact.variants ?? [];
    const fallback = variants.find((v) => v.isDefault) ?? variants[0];
    const effort = knob ? fallback?.params.find((p) => p.id === knob)?.value : undefined;
    return selection(exact.id, pickVariant(exact, effort, prefs));
  }
  const suffix = EFFORT_SUFFIX.exec(pickerId);
  if (!suffix) return { id: pickerId };
  const base = pickerId.slice(0, suffix.index);
  const word = suffix[1] as string;
  const item = items?.find((m) => m.id === base);
  const value = item && effortParam(item)?.values.find((v) => effortWord(v.value) === word)?.value;
  if (item && value !== undefined) return selection(base, pickVariant(item, value, prefs));
  const declared = configModels?.find((m) => m.id === base && m.efforts?.includes(word));
  if (declared) return { id: base, params: [{ id: declared.effortParam ?? "effort", value: word }] };
  // spec-gap: without the catalog the effort param name is unknown, so Cursor runs the model's default effort.
  return item || !items ? { id: base } : { id: pickerId };
}

export function toModelInfo(m: ModelConfig): ModelInfo {
  return {
    id: m.id,
    name: m.name ?? m.id,
    contextWindow: m.contextWindow ?? DEFAULT_LIMITS.contextWindow,
    maxOutputTokens: m.maxOutputTokens ?? DEFAULT_LIMITS.maxOutputTokens,
    input: ["text", "image"],
    reasoning: true,
  };
}

export interface Catalog {
  /** Cursor's model list, cached; undefined when there is no key or the call failed. */
  get(): Promise<ModelListItem[] | undefined>;
  clear(): void;
}

export function createCatalog(
  fetchList: () => Promise<ModelListItem[] | undefined>,
  onError: (e: Error) => void,
  now: () => number = Date.now,
): Catalog {
  let cached: { at: number; items: ModelListItem[] | undefined } | undefined;
  return {
    async get() {
      if (cached && now() - cached.at < CATALOG_TTL_MS) return cached.items;
      let items: ModelListItem[] | undefined;
      try {
        const list = await fetchList();
        items = list?.length ? list : undefined;
      } catch (e) {
        onError(e as Error);
      }
      cached = { at: now(), items };
      return items;
    },
    clear() {
      cached = undefined;
    },
  };
}

/** config.models wins, then Cursor's catalog, then the built-in list. Custom models are appended unless listed. */
export function modelLister(
  cfg: () => CursorConfig | undefined,
  catalog: Catalog,
  custom: () => CustomModel[] = () => [],
  prefs: () => Preferences = () => DEFAULT_PREFERENCES,
) {
  return async (): Promise<ModelInfo[]> => {
    const configured = cfg()?.models;
    const items = configured ? undefined : await catalog.get();
    const listed = (
      configured?.flatMap(configEntries) ??
      items
        ?.filter((i) => !(prefs().hideAuto && i.id === AUTO_MODEL))
        .flatMap((i) => catalogEntries(i, prefs())) ??
      DEFAULT_MODELS
    ).map(toModelInfo);
    const seen = new Set(listed.map((m) => m.id));
    return [
      ...listed,
      ...custom()
        .filter((m) => !seen.has(m.id))
        .map(toModelInfo),
    ];
  };
}
