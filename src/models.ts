import type { ModelListItem, ModelSelection } from "@cursor/sdk";
import type { ModelInfo } from "@valethq/sdk";
import {
  CATALOG_TTL_MS,
  type CursorConfig,
  type CustomModel,
  DEFAULT_LIMITS,
  DEFAULT_MODELS,
  type ModelConfig,
} from "./config";

/** "gpt-5.5?reasoning=high" -> { id: "gpt-5.5", params: [{ id: "reasoning", value: "high" }] }. */
export function resolveModel(pickerId: string): ModelSelection {
  const q = pickerId.indexOf("?");
  if (q < 0) return { id: pickerId };
  const params = [...new URLSearchParams(pickerId.slice(q + 1))].map(([id, value]) => ({ id, value }));
  return { id: pickerId.slice(0, q), ...(params.length && { params }) };
}

export function pickerId(id: string, params: { id: string; value: string }[] = []): string {
  if (!params.length) return id;
  return `${id}?${new URLSearchParams(params.map((p): [string, string] => [p.id, p.value])).toString()}`;
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

/** One picker entry per catalog variant; the default variant keeps the bare id. */
export function catalogEntries(item: ModelListItem): ModelConfig[] {
  const variants = item.variants ?? [];
  if (!variants.length) return [{ id: item.id, name: item.displayName }];
  return variants.map((v) => ({
    id: v.isDefault ? item.id : pickerId(item.id, v.params),
    name:
      v.isDefault || v.displayName === item.displayName
        ? item.displayName
        : `${item.displayName} (${v.displayName})`,
  }));
}

export interface Catalog {
  /** Cursor's model list, cached; undefined when there is no key or the call failed. */
  get(): Promise<ModelConfig[] | undefined>;
  clear(): void;
}

export function createCatalog(
  fetchList: () => Promise<ModelListItem[] | undefined>,
  onError: (e: Error) => void,
  now: () => number = Date.now,
): Catalog {
  let cached: { at: number; models: ModelConfig[] | undefined } | undefined;
  return {
    async get() {
      if (cached && now() - cached.at < CATALOG_TTL_MS) return cached.models;
      let models: ModelConfig[] | undefined;
      try {
        const list = await fetchList();
        models = list?.length ? list.flatMap(catalogEntries) : undefined;
      } catch (e) {
        onError(e as Error);
      }
      cached = { at: now(), models };
      return models;
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
) {
  return async (): Promise<ModelInfo[]> => {
    const listed = (cfg()?.models ?? (await catalog.get()) ?? DEFAULT_MODELS).map(toModelInfo);
    const seen = new Set(listed.map((m) => m.id));
    return [
      ...listed,
      ...custom()
        .filter((m) => !seen.has(m.id))
        .map(toModelInfo),
    ];
  };
}
