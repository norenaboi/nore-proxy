/**
 * Image adapters — wire-protocol transformation for POST /v1/images.
 *
 * The proxy's client-facing images route speaks the OpenAI Images shape:
 * `{ model, prompt, ... }` in, `{ created, data: [{ b64_json | url }], usage }`
 * out. `openai-images` (/v1/images) and `openai-images-generations`
 * (/v1/images/generations) are passthroughs differing only in upstream path;
 * Google's Interactions surface is translated.
 *
 * Which models this serves is decided by the endpoint: a model is an image
 * model when its endpoint uses an Image API format.
 *
 * Adapter contract:
 *   transformImageRequest(clientReq, actualModel) -> upstream body
 *   parseImageResponse(rawData, ctx) -> { response, imageCount, usage }
 *
 * `ctx` carries { modelName } — the proxy-facing model name the response must
 * report, never the upstream's own name.
 */

import * as openaiImages from "./openai-images.js";
import * as openaiImagesGenerations from "./openai-images-generations.js";
import * as geminiInteractions from "./gemini-interactions.js";
import { normalizeApiFormat } from "../../shared/contracts/apiFormats.js";

export interface ImageContext {
  modelName: string;
}

export interface ImageUsage {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
}

export interface ParsedImageResponse {
  /** The OpenAI Images-shaped body handed back to the client. */
  response: Record<string, any>;
  imageCount: number;
  usage: ImageUsage;
}

export interface ImageAdapter {
  transformImageRequest(clientReq: any, actualModel: string): Record<string, any>;
  parseImageResponse(rawData: any, ctx: ImageContext): ParsedImageResponse;
}

export class ImageInputError extends Error {
  statusCode = 400;
  constructor(message: string) {
    super(message);
    this.name = "ImageInputError";
  }
}

/**
 * Params the proxy owns and never forwards. `model` is replaced with the
 * resolved upstream name. `stream` is dropped: this route always returns one
 * finished body, so a partial-frame stream the client never reads would only
 * cost time. `cache_depth` is the proxy's own prompt-caching control.
 */
export const PROXY_OWNED_IMAGE_PARAMS = ["model", "stream", "cache_depth"];

/** The prompt an image request carries, validated once for every format. */
export function imagePromptOf(clientReq: any): string {
  const prompt = clientReq?.prompt;
  if (typeof prompt !== "string" || !prompt.trim()) {
    throw new ImageInputError("Image request requires a non-empty 'prompt'.");
  }
  return prompt;
}

const IMAGE_ADAPTERS: Record<string, ImageAdapter> = {
  "openai-images": openaiImages,
  "openai-images-generations": openaiImagesGenerations,
  "gemini-interactions": geminiInteractions,
};

/**
 * The image adapter for an upstream format, or null for every format outside
 * the image category, an absent format included. Unlike getAdapter() this does
 * not fall back: posting an images body at an endpoint configured for
 * completions would turn a configuration mistake into an unexplained upstream
 * failure.
 */
export function getImageAdapter(apiFormat: string | null | undefined): ImageAdapter | null {
  const normalized = normalizeApiFormat(apiFormat);
  return normalized ? IMAGE_ADAPTERS[normalized] ?? null : null;
}

export { openaiImages, openaiImagesGenerations, geminiInteractions };
