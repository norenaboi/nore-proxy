import type {
  PublicModelDto,
  PublicModelPricing,
  PublicModelsResponse,
} from "$contracts/models";

export const MODEL_CACHE_KEY = "nore-proxy:model-catalog:v1";
const MODEL_CACHE_VERSION = 1;
const MODEL_NAME_ABBREVIATIONS = new Set(["gpt", "glm"]);

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

export function getProvider(modelId: string): Provider {
  const name = modelId.toLowerCase();
  if (["gemini", "google", "gemma", "veo", "nanobanana"].some((value) => name.includes(value))) return "Google";
  if (["claude", "sonnet", "fable", "mythos", "kiro", "opus"].some((value) => name.includes(value))) return "Anthropic";
  if (["gpt", "chatgpt"].some((value) => name.includes(value)) || name.startsWith("o")) return "OpenAI";
  if (name.includes("deepseek")) return "DeepSeek";
  if (name.includes("glm")) return "ZhipuAI";
  if (name.includes("grok")) return "xAI";
  if (name.includes("kimi")) return "MoonshotAI";
  if (name.includes("qwen")) return "Qwen";
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
