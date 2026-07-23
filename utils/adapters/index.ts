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
 *   getExtraHeaders(ctx?) -> object  (extra headers to merge, e.g. anthropic-version
 *     or the Codex marker/ID headers; ctx = { requestId, isStreaming })
 *
 * Codex-style adapters accept an optional per-request ctx as a third argument
 * to transformRequest/transformStreamRequest ({ requestId, isStreaming }).
 * Adapters that ignore the extra argument continue to work unchanged.
 *
 * Usage in chat.js:
 *   import { getAdapter, ADAPTERS } from "../utils/adapters/index.js";
 *   const adapter = getAdapter(endpointInfo.apiFormat);
 *   const body = adapter.transformStreamRequest(openaiReq, actualModel);
 */

import * as openaiAdapter from "./openai.js";
import * as geminiAdapter from "./gemini.js";
import * as anthropicAdapter from "./anthropic.js";
import * as openaiResponsesAdapter from "./openai-responses.js";
import * as openaiCodexAdapter from "./openai-codex.js";

const ADAPTERS = {
  openai: openaiAdapter,
  gemini: geminiAdapter,
  anthropic: anthropicAdapter,
  // OpenAI Responses API (/v1/responses)
  'openai-responses': openaiResponsesAdapter,
  // OpenAI Codex — /v1/responses with Codex-required envelope + headers
  'openai-codex': openaiCodexAdapter,
};

/**
 * Get the adapter module for a given apiFormat.
 * Falls back to the openai adapter for unknown or missing formats.
 */
export function getAdapter(apiFormat: any) {
  if (!apiFormat) return openaiAdapter;

  const adapter = ADAPTERS[apiFormat as keyof typeof ADAPTERS];
  if (!adapter) {
    console.warn(
      `Unknown apiFormat '${apiFormat}' — falling back to openai adapter`,
    );
    return openaiAdapter;
  }

  return adapter;
}

/**
 * Get extra headers that the adapter needs (e.g. anthropic-version, or the
 * Codex marker/ID headers). The optional `ctx` carries per-request data such
 * as { requestId, isStreaming }; adapters that ignore extra arguments keep
 * working unchanged.
 * Returns an empty object if the adapter has no getExtraHeaders export.
 */
export function getExtraHeaders(apiFormat: any, ctx: any) {
  const adapter = getAdapter(apiFormat) as {
    getExtraHeaders?: (context: any) => Record<string, string>;
  };
  return typeof adapter.getExtraHeaders === "function"
    ? adapter.getExtraHeaders(ctx)
    : {};
}

export { ADAPTERS };
export default { getAdapter, getExtraHeaders, ADAPTERS };
