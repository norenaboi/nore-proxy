/**
 * OpenAI Codex Adapter — a thin specialization of the generic OpenAI Responses
 * adapter for talking to a Codex-style `/v1/responses` endpoint.
 *
 * It reuses the generic Responses request transform (so all caller semantics —
 * system/developer instructions, conversation messages, images, tools, tool
 * results, tool_choice, reasoning effort, generation settings — are preserved)
 * and layers on the fields the Codex wire contract requires:
 *
 *   - include: ["reasoning.encrypted_content"]   (must be present & non-empty)
 *   - prompt_cache_key: <non-empty per-request/session id>
 *   - store: false                               (privacy; inherited from base)
 *   - stream: true                               (streaming path; from base)
 *
 * Response parsing and SSE stream conversion are delegated verbatim to the
 * generic Responses adapter — Codex responses come back in the same shape.
 *
 * "Minimal" here means no injected Codex CLI system prompt, tool catalog, or
 * environment context. It does NOT mean stripping legitimate caller content.
 */

import crypto from "crypto";
import * as responses from "./openai-responses.js";

// The Codex router requires a populated `include`; encrypted reasoning content
// is what the CLI itself requests and what was verified against the endpoint.
const CODEX_INCLUDE = ["reasoning.encrypted_content"];

// Static markers observed/verified on the Codex CLI request.
const CODEX_ORIGINATOR = "codex_exec";
const CODEX_USER_AGENT = "codex_exec/0.144.4 (nore-proxy)";
const CODEX_BETA_FEATURES = "remote_compaction_v2";

/**
 * Resolve the per-request identifier used for the cache key and the ID-style
 * headers so they stay internally consistent.
 *
 * An explicit non-empty `ctx.requestId` always wins. When a caller shares one
 * mutable ctx object across the body transform and getExtraHeaders but supplies
 * no requestId, the first generated UUID is cached back onto that ctx so every
 * subsequent call on the same object reuses it — keeping prompt_cache_key and
 * the ID headers identical. Calls that omit ctx entirely (e.g. a direct
 * transformRequest with no context) each get their own fresh UUID; no
 * cross-call consistency is promised in that case.
 */
function resolveRequestId(ctx) {
  const explicit = ctx && typeof ctx.requestId === "string" ? ctx.requestId.trim() : "";
  if (explicit) return explicit;

  // No explicit id. If we can memoize on the shared ctx object, do so.
  if (ctx && typeof ctx === "object") {
    if (typeof ctx.requestId !== "string" || ctx.requestId.trim() === "") {
      ctx.requestId = crypto.randomUUID();
    }
    return ctx.requestId;
  }

  return crypto.randomUUID();
}

/**
 * Pick the prompt_cache_key: an explicitly supplied, non-empty caller value
 * wins; otherwise fall back to the per-request/session identifier. Never a
 * single global constant shared across users.
 */
function resolveCacheKey(openaiReq, requestId) {
  const supplied =
    typeof openaiReq?.prompt_cache_key === "string"
      ? openaiReq.prompt_cache_key.trim()
      : "";
  return supplied || requestId;
}

/** Layer Codex-required fields on top of a generic Responses body. */
function decorate(body, openaiReq, ctx) {
  const requestId = resolveRequestId(ctx);
  body.include = [...CODEX_INCLUDE];
  body.prompt_cache_key = resolveCacheKey(openaiReq, requestId);
  // store:false is already set by the generic transform; keep it explicit for
  // privacy in case the base ever changes.
  body.store = false;
  return body;
}

/**
 * Transform an OpenAI Chat Completions request into a Codex Responses body
 * (non-streaming).
 */
export function transformRequest(openaiReq, actualModel, ctx) {
  const body = responses.transformRequest(openaiReq, actualModel);
  return decorate(body, openaiReq, ctx);
}

/**
 * Transform for streaming — keeps stream:true (from the base) plus SSE-required
 * Codex fields.
 */
export function transformStreamRequest(openaiReq, actualModel, ctx) {
  const body = responses.transformStreamRequest(openaiReq, actualModel);
  return decorate(body, openaiReq, ctx);
}

/**
 * Build the Codex-specific request headers from per-request context.
 * All ID-style headers derive from the same request identifier so they stay
 * internally consistent; a random UUID is used as a safe fallback.
 *
 * @param {{ requestId?: string, isStreaming?: boolean }} [ctx]
 */
export function getExtraHeaders(ctx = {}) {
  const requestId = resolveRequestId(ctx);
  const headers = {
    originator: CODEX_ORIGINATOR,
    "User-Agent": CODEX_USER_AGENT,
    "session-id": requestId,
    "thread-id": requestId,
    "x-client-request-id": requestId,
    "x-codex-window-id": `${requestId}:0`,
    "x-codex-beta-features": CODEX_BETA_FEATURES,
  };

  // The streaming path must negotiate SSE; the non-streaming path may use JSON.
  headers["Accept"] = ctx && ctx.isStreaming ? "text/event-stream" : "application/json";

  return headers;
}

// Response + stream handling is identical to the generic Responses API.
export const parseResponseData = responses.parseResponseData;
export const parseStreamChunk = responses.parseStreamChunk;
export const buildStreamChunk = responses.buildStreamChunk;
export const isStreamEnd = responses.isStreamEnd;
