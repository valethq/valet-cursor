import type { ModelListItem, ModelParameterDefinition, ModelSelection, ModelVariant } from "@cursor/sdk";
import type { ModelInfo, ModelOptions } from "@valethq/sdk";
import {
  CATALOG_TTL_MS,
  type CursorConfig,
  DEFAULT_LIMITS,
  DEFAULT_MODELS,
  EFFORTS,
  type Effort,
  type ModelConfig,
} from "./config";

/** Cursor's name for a model's effort knob differs by vendor; the first one a model has is used. */
export const EFFORT_PARAMS = ["effort", "reasoning_effort", "reasoning"] as const;

const EFFORT_SUFFIX = new RegExp(`-(${EFFORTS.join("|")})$`);
const WORDS: Record<string, string> = { "extra-high": "xhigh" };

/** Picker word for a Cursor effort value: "extra-high" -> "xhigh"; the rest pass through. */
export const effortWord = (value: string): string => WORDS[value] ?? value;

/** An effort valet's picker takes, or undefined for anything else. */
export const asEffort = (v: string | undefined): Effort | undefined =>
  v !== undefined && (EFFORTS as readonly string[]).includes(v) ? (v as Effort) : undefined;

/** For the utility model setting, which may name an effort: "composer-2-high" -> { model, effort }. */
export function resolveModel(id: string): { model: string; effort?: Effort } {
  const effort = asEffort(EFFORT_SUFFIX.exec(id)?.[1]);
  return effort ? { model: id.replace(EFFORT_SUFFIX, ""), effort } : { model: id };
}

/** Settings that pick a variant's non-effort, non-fast params. */
export interface Preferences {
  /** Allow Max-mode variants, which carry the large context windows. */
  maxMode: boolean;
  /** Leave Cursor's Auto model out of the catalog list. It still runs when a session names it. */
  hideAuto: boolean;
  /** Per-model param values that win over everything else, e.g. { thinking: "false" }. */
  overrides(modelId: string): Record<string, string>;
}

export const DEFAULT_PREFERENCES: Preferences = {
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

const defaultVariant = (item: ModelListItem): ModelVariant | undefined =>
  item.variants?.find((v) => v.isDefault) ?? item.variants?.[0];

const hasFastParam = (item: ModelListItem): boolean => item.parameters?.some((p) => p.id === "fast") ?? false;

/** Fast mode on by default when the catalog's default variant has fast=true. */
export function catalogFastByDefault(item: ModelListItem): boolean {
  const d = defaultVariant(item);
  return hasFastParam(item) && !!d && paramsOf(d).get("fast") === "true";
}

/**
 * The variant to run for an effort value: the effort and any per-model overrides must match, then fast
 * mode as set, then non-Max unless Max mode is on, then the largest context, then the catalog default.
 */
export function pickVariant(
  item: ModelListItem,
  effort: string | undefined,
  prefs: Preferences,
  fast: boolean,
): ModelVariant | undefined {
  const variants = item.variants ?? [];
  const knob = effortParam(item)?.id;
  const overrides = Object.entries(prefs.overrides(item.id));
  const defaults = paramsOf(defaultVariant(item) ?? { params: [], displayName: "" });
  const hasFast = hasFastParam(item);
  const score = (v: ModelVariant): number => {
    const p = paramsOf(v);
    let s = 0;
    if (knob && effort !== undefined && p.get(knob) === effort) s += 100_000;
    s += 10_000 * overrides.filter(([k, val]) => p.get(k) === val).length;
    if (hasFast && p.get("fast") === String(fast)) s += 1_000;
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

/** Resolve ModelOptions.fast against the catalog (or a config row): unset follows fastByDefault. */
export function resolveFast(
  options: ModelOptions,
  item: ModelListItem | undefined,
  declared: ModelConfig | undefined,
): boolean {
  if (options.fast !== undefined) return options.fast;
  if (item) return catalogFastByDefault(item);
  return declared?.fastByDefault ?? false;
}

/** Cursor raw effort value for a picker word, or the catalog default when unset. */
function rawEffort(item: ModelListItem, effort: string | undefined): string | undefined {
  const knob = effortParam(item);
  if (!knob) return undefined;
  if (effort !== undefined) {
    const hit = knob.values.find((v) => effortWord(v.value) === effort)?.value;
    if (hit !== undefined) return hit;
  }
  const d = defaultVariant(item);
  return d?.params.find((p) => p.id === knob.id)?.value;
}

/** Legacy picker ids from 0.1.0: "gpt-5.5?reasoning=high" -> { id, params } as written. */
function legacySelection(pickerId: string): ModelSelection {
  const q = pickerId.indexOf("?");
  const params = [...new URLSearchParams(pickerId.slice(q + 1))].map(([id, value]) => ({ id, value }));
  return { id: pickerId.slice(0, q), ...(params.length && { params }) };
}

/**
 * Turns a model id + options into what Cursor runs. Effort and fast come from ModelOptions; other params
 * follow `prefs` (Max mode, modelParams). Unknown ids go to Cursor unchanged.
 */
export function selectModel(
  modelId: string,
  options: ModelOptions,
  items: ModelListItem[] | undefined,
  configModels: ModelConfig[] | undefined,
  prefs: Preferences = DEFAULT_PREFERENCES,
): ModelSelection {
  if (modelId.includes("?")) return legacySelection(modelId);
  const item = items?.find((m) => m.id === modelId);
  if (item) {
    const effort = rawEffort(item, options.effort);
    const fast = resolveFast(options, item, undefined);
    return selection(item.id, pickVariant(item, effort, prefs, fast));
  }
  const declared = configModels?.find((m) => m.id === modelId);
  if (declared) {
    const params: { id: string; value: string }[] = [];
    const effort = asEffort(options.effort) ?? declared.defaultEffort;
    if (effort) params.push({ id: declared.effortParam ?? "effort", value: effort });
    if (declared.fast) {
      const fast = resolveFast(options, undefined, declared);
      params.push({ id: "fast", value: String(fast) });
    }
    return params.length ? { id: modelId, params } : { id: modelId };
  }
  // Bare id with a trailing effort word and no catalog: strip the word so Cursor sees the base id.
  const suffix = EFFORT_SUFFIX.exec(modelId);
  if (suffix && !items) return { id: modelId.slice(0, suffix.index) };
  return { id: modelId };
}

export function toModelInfo(m: ModelConfig): ModelInfo {
  return {
    id: m.id,
    name: m.name ?? m.id,
    contextWindow: m.contextWindow ?? DEFAULT_LIMITS.contextWindow,
    maxOutputTokens: m.maxOutputTokens ?? DEFAULT_LIMITS.maxOutputTokens,
    input: ["text", "image"],
    reasoning: true,
    ...(m.efforts?.length ? { efforts: m.efforts } : {}),
    ...(m.defaultEffort ? { defaultEffort: m.defaultEffort } : {}),
    ...(m.fast ? { fast: true } : {}),
    ...(m.fast && m.fastByDefault ? { fastByDefault: true } : {}),
  };
}

/** One ModelInfo per catalog model: efforts and fast capability, never one row per variant. */
export function fromCatalog(item: ModelListItem, prefs: Preferences = DEFAULT_PREFERENCES): ModelInfo {
  const knob = effortParam(item);
  const efforts = knob?.values
    .map((v) => effortWord(v.value))
    .filter((e): e is Effort => (EFFORTS as readonly string[]).includes(e));
  const d = defaultVariant(item);
  const defaultRaw = knob && d ? d.params.find((p) => p.id === knob.id)?.value : undefined;
  const defaultEffort = defaultRaw !== undefined ? asEffort(effortWord(defaultRaw)) : undefined;
  const hasFast = hasFastParam(item);
  const fastByDefault = catalogFastByDefault(item);
  const variant = pickVariant(item, defaultRaw, prefs, fastByDefault);
  const contextWindow = contextTokens(variant && paramsOf(variant).get("context"));
  return toModelInfo({
    id: item.id,
    name: item.displayName,
    ...(contextWindow && { contextWindow }),
    ...(efforts?.length ? { efforts } : {}),
    ...(defaultEffort ? { defaultEffort } : {}),
    ...(hasFast ? { fast: true, ...(fastByDefault ? { fastByDefault: true } : {}) } : {}),
  });
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

/** config.models wins, then Cursor's catalog, then the built-in list. Each model is listed once. */
export function modelLister(
  cfg: () => CursorConfig | undefined,
  catalog: Catalog,
  prefs: () => Preferences = () => DEFAULT_PREFERENCES,
) {
  return async (): Promise<ModelInfo[]> => {
    const configured = cfg()?.models;
    if (configured) return configured.map(toModelInfo);
    const items = await catalog.get();
    const p = prefs();
    if (items) return items.filter((i) => !(p.hideAuto && i.id === AUTO_MODEL)).map((i) => fromCatalog(i, p));
    return DEFAULT_MODELS.map(toModelInfo);
  };
}
