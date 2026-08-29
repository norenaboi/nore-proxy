import type {
  PublicModelDto,
  PublicModelPricing,
  PublicModelsResponse,
} from "$contracts/models";

export const MODEL_CACHE_KEY = "nore-proxy:model-catalog:v1";
const MODEL_CACHE_VERSION = 1;
const MODEL_NAME_ABBREVIATIONS = new Set(["gpt", "glm"]);
const MODEL_VERSION_SEGMENT = /^\d+(?:\.\d+)*$/;

export type Provider =
  | "Anthropic"
  | "Google"
  | "OpenAI"
  | "DeepSeek"
  | "ZhipuAI"
  | "xAI"
  | "MoonshotAI"
  | "Qwen"
  | "Others";

export interface CatalogModel {
  id: string;
  provider: Provider;
  pricing: Required<PublicModelPricing>;
}

interface CachedCatalog {
  version: number;
  models: Array<Pick<CatalogModel, "id" | "pricing">>;
}

/**
 * Model-family tokens: these name whoever trained the model. Patterns are
 * anchored on token boundaries so a family name is never matched mid-word, and
 * the first match wins, so every model id resolves to exactly one provider —
 * a model can only ever appear under one filter chip.
 *
 * `o\d` covers the OpenAI o-series (o1, o3, o4-mini). Its boundary excludes a
 * preceding digit as well, so the `4o` in `gpt-4o` is not read as an o-series
 * marker.
 */
const PROVIDER_FAMILIES: ReadonlyArray<readonly [Provider, RegExp]> = [
  ["Google", /(?:^|[^a-z])(?:gemini|gemma|veo|imagen|nano-?banana)/],
  ["Anthropic", /(?:^|[^a-z])(?:claude|sonnet|opus|haiku|fable|mythos)/],
  ["OpenAI", /(?:^|[^a-z])(?:chatgpt|gpt|codex|dall-?e)|(?:^|[^a-z0-9])o\d/],
  ["DeepSeek", /(?:^|[^a-z])deepseek/],
  ["ZhipuAI", /(?:^|[^a-z])glm/],
  ["xAI", /(?:^|[^a-z])grok/],
  ["MoonshotAI", /(?:^|[^a-z])(?:kimi|moonshot)/],
  ["Qwen", /(?:^|[^a-z])(?:qwen|qwq)/],
];

/**
 * Routing prefixes: these name whoever *serves* the model, so they only decide
 * the provider when no family token is present. `kiro-glm-5` is a ZhipuAI model
 * routed through Kiro, not an Anthropic one.
 */
const PROVIDER_ROUTES: ReadonlyArray<readonly [Provider, RegExp]> = [
  ["Google", /(?:^|[^a-z])google/],
  ["Anthropic", /(?:^|[^a-z])(?:anthropic|kiro)/],
  ["OpenAI", /(?:^|[^a-z])openai/],
  ["ZhipuAI", /(?:^|[^a-z])zhipu/],
  ["xAI", /(?:^|[^a-z])x-?ai/],
];

export function getProvider(modelId: string): Provider {
  const name = modelId.toLowerCase();
  for (const [provider, pattern] of PROVIDER_FAMILIES) {
    if (pattern.test(name)) return provider;
  }
  for (const [provider, pattern] of PROVIDER_ROUTES) {
    if (pattern.test(name)) return provider;
  }
  return "Others";
}

export function getProviderIcon(provider: Provider): string {
  const icons: Record<Provider, string> = {
    Anthropic: "/icons/providers/anthropic.png",
    Google: "/icons/providers/google.png",
    OpenAI: "/icons/providers/openai.png",
    DeepSeek: "/icons/providers/deepseek.png",
    ZhipuAI: "/icons/providers/zhipuai.png",
    xAI: "/icons/providers/xai.png",
    MoonshotAI: "/icons/providers/moonshot.png",
    Qwen: "/icons/providers/qwen.png",
    Others: "/icons/providers/other.png",
  };
  return icons[provider];
}

export function formatModelName(modelId: string): string {
  return modelId
    .split("-")
    .filter(Boolean)
    .reduce<string[]>((words, word) => {
      const previous = words[words.length - 1];
      if (previous !== undefined && MODEL_VERSION_SEGMENT.test(previous) && MODEL_VERSION_SEGMENT.test(word)) {
        words[words.length - 1] = `${previous}.${word}`;
        return words;
      }
      words.push(word);
      return words;
    }, [])
    .map((word) =>
      MODEL_NAME_ABBREVIATIONS.has(word.toLowerCase())
        ? word.toUpperCase()
        : word.charAt(0).toUpperCase() + word.slice(1),
    )
    .join(" ");
}

export function formatPrice(value: number): string {
  if (value === 0) return "$0.00";
  if (value >= 0.1) return `$${value.toFixed(2)}`;
  return `$${Number.parseFloat(value.toPrecision(2))}`;
}

function normalizePricing(pricing: PublicModelPricing | null | undefined): Required<PublicModelPricing> {
  return {
    input: Number(pricing?.input) || 0,
    output: Number(pricing?.output) || 0,
    cache_write: Number(pricing?.cache_write) || 0,
    cache_read: Number(pricing?.cache_read) || 0,
  };
}

function normalizeModel(model: PublicModelDto | string): CatalogModel | null {
  const id = typeof model === "string" ? model : model?.id;
  if (typeof id !== "string" || id.length === 0) return null;
  return {
    id,
    provider: getProvider(id),
    pricing: normalizePricing(typeof model === "string" ? null : model.pricing),
  };
}

export function normalizeModels(input: PublicModelsResponse | PublicModelDto[] | string[]): CatalogModel[] {
  const models = Array.isArray(input) ? input : input.data;
  if (!Array.isArray(models)) return [];
  return models
    .map((model) => normalizeModel(model))
    .filter((model): model is CatalogModel => model !== null)
    .sort((left, right) => left.id.localeCompare(right.id));
}

export function readModelCache(storage: Storage): CatalogModel[] | null {
  try {
    const value = storage.getItem(MODEL_CACHE_KEY);
    if (!value) return null;
    const cached = JSON.parse(value) as CachedCatalog;
    if (cached.version !== MODEL_CACHE_VERSION || !Array.isArray(cached.models)) return null;
    const models = cached.models
      .map((model) => normalizeModel(model as PublicModelDto))
      .filter((model): model is CatalogModel => model !== null)
      .sort((left, right) => left.id.localeCompare(right.id));
    return models.length > 0 ? models : null;
  } catch {
    return null;
  }
}

export function writeModelCache(storage: Storage, models: CatalogModel[]): void {
  const cached: CachedCatalog = {
    version: MODEL_CACHE_VERSION,
    models: models.map(({ id, pricing }) => ({ id, pricing })),
  };
  storage.setItem(MODEL_CACHE_KEY, JSON.stringify(cached));
}

export function clearModelCache(storage: Storage): void {
  storage.removeItem(MODEL_CACHE_KEY);
}
