/**
 * Adapter Registry — maps apiFormat strings to their adapter modules.
 *
 * Each adapter exports:
 *   transformRequest(openaiReq, actualModel) -> backendBody (non-streaming)
 *   transformStreamRequest(openaiReq, actualModel) -> backendBody (streaming)
 *   parseStreamChunk(rawChunk, ctx) -> { deltaContent, finishReason, usage, toolCalls } | null
 *   buildStreamChunk(rawChunk, ctx) -> OpenAI-compatible SSE chunk object | null
 *   parseResponseData(rawData) -> { content, usage, response }
 *   isStreamEnd(payload) -> bool
 *
 * Some adapters also export:
 *   getExtraHeaders() -> object  (extra headers to merge, e.g. anthropic-version)
 *
 * Usage in chat.js:
 *   import { getAdapter, ADAPTERS } from "../utils/adapters/index.js";
 *   const adapter = getAdapter(endpointInfo.apiFormat);
 *   const body = adapter.transformStreamRequest(openaiReq, actualModel);
 */

import * as openaiAdapter from "./openai.js";
import * as geminiAdapter from "./gemini.js";
import * as anthropicAdapter from "./anthropic.js";

const ADAPTERS = {
  openai: openaiAdapter,
  gemini: geminiAdapter,
  anthropic: anthropicAdapter,
  // Gemini OpenAI-compatible endpoint uses the same passthrough as OpenAI
  'gemini-openai': openaiAdapter,
};

/**
 * Get the adapter module for a given apiFormat.
 * Falls back to the openai adapter for unknown or missing formats.
 */
export function getAdapter(apiFormat) {
  if (!apiFormat) return openaiAdapter;

  const adapter = ADAPTERS[apiFormat];
  if (!adapter) {
    console.warn(
      `Unknown apiFormat '${apiFormat}' — falling back to openai adapter`,
    );
    return openaiAdapter;
  }

  return adapter;
}

/**
 * Get extra headers that the adapter needs (e.g. anthropic-version).
 * Returns an empty object if the adapter has no getExtraHeaders export.
 */
export function getExtraHeaders(apiFormat) {
  const adapter = getAdapter(apiFormat);
  if (typeof adapter.getExtraHeaders === "function") {
    return adapter.getExtraHeaders();
  }
  return {};
}

export { ADAPTERS };
export default { getAdapter, getExtraHeaders, ADAPTERS };
