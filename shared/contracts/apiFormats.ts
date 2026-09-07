import type { ModelModality } from "./models.js";

/**
 * Upstream API formats, grouped by the surface they speak.
 *
 * A format selects the adapter, the upstream URL, and the category. A category
 * maps one-to-one onto `ModelModality`: a model's modality is the category of
 * the endpoint serving it, and a model stores no modality of its own.
 *
 * Each category has its own client route: text on POST /v1/chat/completions
 * and POST /v1/messages, image on POST /v1/images, embedding on
 * POST /v1/embeddings. Only the text routes stream.
 */
export type ApiFormatCategory = ModelModality;

export type TextApiFormat =
  | "openai"
  | "anthropic"
  | "gemini"
  | "openai-responses"
  | "openai-codex";

export type ImageApiFormat = "openai-images" | "openai-images-generations" | "gemini-interactions";

export type EmbeddingApiFormat = "openai-embeddings" | "gemini-embeddings";

export type ApiFormat = TextApiFormat | ImageApiFormat | EmbeddingApiFormat;

export interface ApiFormatSpec {
  value: ApiFormat;
  label: string;
  category: ApiFormatCategory;
  /** Upstream path the proxy posts to, shown in the endpoint editor. */
  path: string;
  /** Short qualifier rendered next to the label in the picker. */
  note?: string;
}

export const API_FORMATS: readonly ApiFormatSpec[] = [
  { value: "openai", label: "OpenAI", category: "text", path: "/v1/chat/completions", note: "default" },
  { value: "anthropic", label: "Anthropic", category: "text", path: "/v1/messages" },
  { value: "gemini", label: "Gemini", category: "text", path: "/v1beta/generateContent" },
  { value: "openai-responses", label: "OpenAI Responses", category: "text", path: "/v1/responses" },
  { value: "openai-codex", label: "OpenAI Codex", category: "text", path: "/v1/responses" },
  { value: "openai-images", label: "OpenAI Images", category: "image", path: "/v1/images" },
  { value: "openai-images-generations", label: "OpenAI Images Generations", category: "image", path: "/v1/images/generations" },
  { value: "gemini-interactions", label: "Gemini Interactions", category: "image", path: "/v1beta/interactions" },
  { value: "openai-embeddings", label: "OpenAI Embeddings", category: "embedding", path: "/v1/embeddings" },
  { value: "gemini-embeddings", label: "Gemini Embeddings", category: "embedding", path: "/v1beta/embedContent" },
];

/** Category headers for the endpoint editor's format picker, in menu order. */
export const API_FORMAT_CATEGORIES: readonly { category: ApiFormatCategory; label: string; hint: string }[] = [
  { category: "text", label: "Text", hint: "Chat and completions" },
  { category: "image", label: "Image", hint: "Image generation" },
  { category: "embedding", label: "Embedding", hint: "Vector embeddings" },
];

export const DEFAULT_API_FORMAT: ApiFormat = "openai";

export const API_FORMAT_VALUES: readonly ApiFormat[] = API_FORMATS.map((format) => format.value);

const SPEC_BY_VALUE = new Map<string, ApiFormatSpec>(
  API_FORMATS.map((format) => [format.value, format]),
);

/** Former format names a stored endpoint may still carry, mapped onto the current name. */
const LEGACY_API_FORMATS: Record<string, ApiFormat> = {
  "openrouter-images": "openai-images",
};

/**
 * The current name for a stored format value. Legacy names resolve to their
 * replacement; every other string is returned unchanged; non-strings and empty
 * strings return null.
 */
export function normalizeApiFormat(value: unknown): string | null {
  if (typeof value !== "string" || !value) return null;
  return LEGACY_API_FORMATS[value] ?? value;
}

/** True for a current format name only. Legacy names are rejected at the admin API. */
export function isApiFormat(value: unknown): value is ApiFormat {
  return typeof value === "string" && SPEC_BY_VALUE.has(value);
}

export function apiFormatSpec(value: unknown): ApiFormatSpec | null {
  const normalized = normalizeApiFormat(value);
  return normalized ? SPEC_BY_VALUE.get(normalized) ?? null : null;
}

/**
 * The category of a stored format. Absent and unrecognized values return
 * "text", matching how endpoints written before the categories existed behave.
 */
export function apiFormatCategory(value: unknown): ApiFormatCategory {
  return apiFormatSpec(value)?.category ?? "text";
}

export function apiFormatLabel(value: unknown): string {
  const spec = apiFormatSpec(value);
  if (spec) return spec.label;
  return typeof value === "string" && value ? value : DEFAULT_API_FORMAT;
}

export function apiFormatsInCategory(category: ApiFormatCategory): ApiFormatSpec[] {
  return API_FORMATS.filter((format) => format.category === category);
}
