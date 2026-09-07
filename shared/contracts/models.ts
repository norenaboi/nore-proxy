export interface PublicModelPricing {
  input?: number;
  output?: number;
  cache_write?: number;
  cache_read?: number;
}

/**
 * How a model is exercised, and — for "embedding" — which client route may
 * serve it. "text" and "image" are both chat models and route identically;
 * they are distinguished so the catalogs can be filtered by what a model
 * produces. "embedding" is routing-relevant: those models answer on
 * /v1/embeddings and are refused by the chat routes.
 */
export type ModelModality = "text" | "image" | "embedding";

export const MODEL_MODALITIES: readonly ModelModality[] = ["text", "image", "embedding"];

export const DEFAULT_MODEL_MODALITY: ModelModality = "text";

/**
 * Coerces a stored or submitted modality to a known value. Absent and
 * unrecognized values become "text", so a models.json written before this field
 * existed keeps behaving exactly as it did. "vision" is the former name of
 * "image" and still maps onto it, so entries stored under the old name are not
 * silently demoted to "text".
 */
export function normalizeModality(value: unknown): ModelModality {
  if (value === "vision") return "image";
  return value === "image" || value === "embedding" ? value : DEFAULT_MODEL_MODALITY;
}

export function isEmbeddingModality(value: unknown): boolean {
  return normalizeModality(value) === "embedding";
}

export interface PublicModelDto {
  id: string;
  object: "model";
  created: number;
  owned_by: string;
  type: string;
  modality?: ModelModality;
  pricing: PublicModelPricing | null;
}

export interface PublicModelsResponse {
  object: "list";
  data: PublicModelDto[];
}

export type ModelTestResult =
  | { ok: true; latency_ms: number }
  | { ok: false; error: string; latency_ms?: number };
