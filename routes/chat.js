import express from "express";
import axios from "axios";
import { v4 as uuidv4 } from "uuid";
import { verifyApiKey } from "../middleware/auth.js";
import apiKeyManager from "../services/apiKeyManager.js";
import settingsManager from "../services/settingsManager.js";
import rateLimiter from "../middleware/rateLimiter.js";
import { logRequestStart, logRequestEnd, logError, normalizeBillingTokens } from "../utils/logging.js";
import { MODEL_REGISTRY, getEndpointForConcreteModel, getFullUrl, estimateTokens, isClaudeModel, applyClaudePromptCaching, applyGenerationPolicy, resolveKeyHealth } from "../utils/helpers.js";
import keyStateManager, { ACTIONABLE_CODES } from "../services/keyStateManager.js";
import { getAdapter, getExtraHeaders } from "../utils/adapters/index.js";
import { buildUpstreamErrorContext, getUpstreamErrorMessage, readUpstreamErrorBody } from "../utils/upstreamErrors.js";
import { attemptedKeyHashes, classifyUpstreamFailure, createRoutingState, markStreamOutputStarted, nextTarget, recordRoutingAttempt, routingMetadata, summarizeRoutingAttempts } from "../utils/autoRouting.js";

const router = express.Router();
const clone = (value) => structuredClone(value);
const statusOf = (error) => error?.response?.status ?? error?.statusCode ?? null;

function persistUpstreamError({ requestId, modelName, endpointInfo, requestHeaders, upstreamUrl, error, statusCode, responseBody, autoModel, targetModel, routingAttempts }) {
  return logError(requestId, error?.name || "Error", error?.message || "Unknown error", error?.stack || "", buildUpstreamErrorContext({ modelName, endpointInfo, requestHeaders, upstreamUrl, error, statusCode, responseBody, autoModel, targetModel, routingAttempts }));
}

function sendStreamError(res, requestId, modelName, error, statusCode = 500) {
  if (res.writableEnded) return;
  res.write(`data: ${JSON.stringify({ id: `chatcmpl-${requestId}`, object: "chat.completion.chunk", created: Math.floor(Date.now() / 1000), model: modelName, choices: [{ index: 0, delta: {}, finish_reason: "error" }], error: { message: error?.message || "Unknown error", type: "server_error", code: error?.code || statusCode } })}\n\n`);
  res.write("data: [DONE]\n\n");
  res.end();
}

function httpError(status, body) {
  const error = new Error(`Error ${status}: ${getUpstreamErrorMessage(body)}`);
  error.name = "UpstreamHttpError";
  error.statusCode = status;
  error.responseBody = body;
  return error;
}

function withContext(error, endpointInfo, prepared = {}, responseBody) {
  Object.defineProperty(error, "attemptContext", {
    value: {
      endpointInfo,
      requestHeaders: prepared.headers,
      upstreamUrl: prepared.fullUrl,
      responseBody: error.responseBody ?? responseBody ?? null,
    },
    configurable: true,
  });
  return error;
}

function autoExhausted(lastError, state) {
  const error = new Error(lastError?.message || "All automatic routing targets failed.");
  error.name = "AutoTargetsExhaustedError";
  error.code = "auto_targets_exhausted";
  error.statusCode = statusOf(lastError) || 502;
  error.responseBody = lastError?.responseBody;
  error.attemptContext = lastError?.attemptContext;
  error.routingState = state;
  return error;
}

function prepareAttempt(baseRequest, endpoint, requestId, isStreaming) {
  const request = clone(baseRequest);
  let cacheDepth = -1;
  if (request.cache_depth !== undefined) {
    const parsed = parseInt(request.cache_depth, 10);
    cacheDepth = Number.isNaN(parsed) ? -1 : parsed;
  } else if (endpoint.promptCaching?.enabled === true && isClaudeModel(endpoint.actualModel)) {
    cacheDepth = endpoint.promptCaching.depth;
  }
  delete request.cache_depth;
  delete request.frequency_penalty;
  delete request.presence_penalty;
  request.model = endpoint.targetModel;
  if (endpoint.generationDefaults) applyGenerationPolicy(request, endpoint.generationDefaults);
  if (isClaudeModel(endpoint.actualModel) && cacheDepth !== -1) request.messages = applyClaudePromptCaching(request.messages || [], cacheDepth);

  const ctx = { requestId, isStreaming };
  const adapter = getAdapter(endpoint.apiFormat);
  const data = isStreaming ? adapter.transformStreamRequest(request, endpoint.actualModel, ctx) : adapter.transformRequest(request, endpoint.actualModel, ctx);
  const headers = { ...endpoint.customHeaders, ...getExtraHeaders(endpoint.apiFormat, ctx), "Content-Type": "application/json" };
  if (endpoint.apiFormat === "anthropic") headers["x-api-key"] = endpoint.token;
  else if (endpoint.apiFormat !== "gemini") headers.Authorization = `Bearer ${endpoint.token}`;
  const fullUrl = getFullUrl(endpoint.url, endpoint.apiFormat, endpoint.actualModel, isStreaming, endpoint.appendApiSuffix);
  const requestUrl = endpoint.apiFormat === "gemini" ? `${fullUrl}?${isStreaming ? "alt=sse&" : ""}key=${endpoint.token}` : fullUrl;
  return { adapter, data, headers, fullUrl, requestUrl };
}

function recordKeyFailure(endpoint, status) {
  if (!endpoint?.token || !ACTIONABLE_CODES.has(Number(status))) return;
  keyStateManager.recordFailure(endpoint.endpointKey, endpoint.token, Number(status), { sideline: resolveKeyHealth(endpoint.keyHealth) });
}

function noteAttempt(state, endpoint, keyAttempt, outcome, decision, statusCode) {
  recordRoutingAttempt(state, { targetModel: endpoint?.targetModel, endpointKey: endpoint?.endpointKey, endpointName: endpoint?.endpointName, tokenHash: endpoint?.tokenHash, keyAttempt, outcome, retryReason: decision?.reason, statusCode });
}

function mergeUsage(current, incoming) {
  if (!incoming) return current;
  const mergedDetails = {
    ...(current?.prompt_tokens_details || {}),
    ...(incoming.prompt_tokens_details || {}),
  };
  return {
    ...(current || {}),
    ...incoming,
    ...(Object.keys(mergedDetails).length ? { prompt_tokens_details: mergedDetails } : {}),
  };
}

function inBandStreamError(raw) {
  if (raw?.type !== "error") return null;
  const detail = raw.error || {};
  const error = new Error(detail.message || "Upstream stream failed");
  error.name = "UpstreamStreamError";
  error.code = detail.type || detail.code || null;
  const statuses = {
    authentication_error: 401,
    permission_error: 403,
    permission_denied: 403,
    billing_error: 402,
    rate_limit_error: 429,
    rate_limit_exceeded: 429,
    overloaded_error: 529,
    api_error: 500,
  };
  error.statusCode = statuses[error.code] || 500;
  error.responseBody = raw;
  return error;
}

async function executeRouting(requestId, requestedModel, runAttempt) {
  const state = createRoutingState({ requestId, requestedModel, registry: MODEL_REGISTRY, globalCeiling: settingsManager.get("autoModelMaxTargetAttempts") });
  const maxKeyAttempts = 1 + Math.max(0, parseInt(settingsManager.get("keyHopAttempts"), 10) || 0);
  let lastError = null;
  let autoFallbackOccurred = false;

  for (let target = nextTarget(state); target; target = nextTarget(state)) {
    let fallback = false;
    let endpointKey = null;
    for (let keyAttempt = 1; keyAttempt <= maxKeyAttempts; keyAttempt++) {
      const excluded = endpointKey ? attemptedKeyHashes(state, endpointKey) : new Set();
      const endpoint = getEndpointForConcreteModel(target, { excludeHashes: excluded });
      if (!endpoint) {
        const error = new Error("Can't find the model you're looking for.");
        error.name = "EndpointResolutionError";
        error.statusCode = 404;
        throw error;
      }
      endpointKey = endpoint.endpointKey;
      const tried = attemptedKeyHashes(state, endpointKey);
      if (endpoint.tokenExhausted || !endpoint.token) {
        lastError = withContext(keyStateManager.buildExhaustionError(endpointKey), endpoint);
        const decision = classifyUpstreamFailure({ keyExhausted: true });
        noteAttempt(state, endpoint, keyAttempt, "key_exhausted", decision, 404);
        fallback = true;
        break;
      }
      try {
        const result = await runAttempt(state, endpoint);
        noteAttempt(state, endpoint, keyAttempt, "success", null, null);
        if (result && typeof result === "object") {
          Object.defineProperty(result, "routingState", {
            value: state,
            enumerable: false,
          });
        }
        return result;
      } catch (error) {
        if (error.clientAbort) throw error;
        lastError = error;
        const status = statusOf(error);
        const decision = classifyUpstreamFailure({ statusCode: status, error, streamOutputStarted: state.streamOutputStarted });
        noteAttempt(state, endpoint, keyAttempt, "failure", decision, status);
        recordKeyFailure(endpoint, status);
        if (endpoint.tokenHash) tried.add(endpoint.tokenHash);
        if (decision.retryKey && keyAttempt < maxKeyAttempts) continue;
        fallback = decision.fallbackTarget;
        break;
      }
    }
    if (!fallback) throw lastError;
    if (state.autoModel) autoFallbackOccurred = true;
  }
  if (autoFallbackOccurred) throw autoExhausted(lastError, state);
  if (lastError) {
    lastError.routingState = state;
    throw lastError;
  }
  const error = new Error(`Model '${requestedModel}' not found.`);
  error.statusCode = 404;
  throw error;
}

router.post("/v1/chat/completions", verifyApiKey, async (req, res) => {
  const apiKey = req.apiKey;
  const baseRequest = clone(req.body);
  try { apiKeyManager.checkForGeneration(apiKey, rateLimiter, estimateTokens(baseRequest.messages || [])); }
  catch (error) { return res.status(error.statusCode || 500).json({ error: { message: error.message } }); }

  const requestId = uuidv4();
  const modelName = baseRequest.model;
  const streaming = baseRequest.stream === true;
  if (!MODEL_REGISTRY[modelName]) return res.status(404).json({ error: `Model '${modelName}' not found.` });
  logRequestStart(requestId, modelName, { temperature: baseRequest.temperature, max_tokens: baseRequest.max_tokens, streaming }, baseRequest.messages || [], apiKey);
  try {
    if (streaming) await streamFromBackend(req, res, requestId, baseRequest, modelName, apiKey);
    else res.json(await makeBackendRequest(requestId, baseRequest, modelName, apiKey));
  } catch (error) {
    const state = error.routingState || null;
    const c = error.attemptContext || {};
    logRequestEnd(requestId, false, 0, 0, error.message, "", null, 0, 0, null, routingMetadata(state, c.endpointInfo));
    if (!error.clientAbort) {
      persistUpstreamError({ requestId, modelName, endpointInfo: c.endpointInfo, requestHeaders: c.requestHeaders, upstreamUrl: c.upstreamUrl, error, statusCode: statusOf(error), responseBody: c.responseBody, autoModel: state?.autoModel, targetModel: state?.currentTargetModel, routingAttempts: summarizeRoutingAttempts(state) });
      console.error(
        `API [ID: ${requestId}]: ${error?.name || "Error"}: ${error?.message || String(error)}`,
      );
    }
    if (error.clientAbort) { if (!res.writableEnded) try { res.end(); } catch (_) {} }
    else if (streaming) sendStreamError(res, requestId, modelName, error, statusOf(error) || 500);
    else if (!res.headersSent) res.status(statusOf(error) || 500).json({ error: { message: error.message || String(error), ...(error.code ? { code: error.code } : {}) } });
    else if (!res.writableEnded) res.end();
  }
});

async function streamFromBackend(req, res, requestId, baseRequest, modelName, apiKey) {
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");
  const streamCtx = { requestId, modelName, streamId: `chatcmpl-${requestId}`, streamCreated: Math.floor(Date.now() / 1000) };
  const abortController = new AbortController();
  let activeStream = null;
  let clientAborted = false;
  const abortClient = () => {
    if (clientAborted || res.writableEnded) return;
    clientAborted = true;
    abortController.abort();
    activeStream?.destroy?.();
  };
  req.once("aborted", abortClient);
  res.once("close", abortClient);
  try {
    const routed = await executeRouting(requestId, modelName, async (state, endpoint) => {
    if (clientAborted) {
      const error = new Error("Client aborted stream");
      error.clientAbort = true;
      throw error;
    }
    const prepared = prepareAttempt(baseRequest, endpoint, requestId, true);
    let response;
    try {
      response = await axios({ method: "post", url: prepared.requestUrl, headers: prepared.headers, data: prepared.data, responseType: "stream", timeout: 180000, validateStatus: () => true, signal: abortController.signal });
      activeStream = response.data;
    } catch (error) {
      if (clientAborted) error.clientAbort = true;
      throw withContext(error, endpoint, prepared);
    }
    if (response.status < 200 || response.status >= 300) {
      const body = await readUpstreamErrorBody(response.data);
      response.data?.destroy?.();
      throw withContext(httpError(response.status, body), endpoint, prepared, body);
    }
    try {
      const result = await consumeStream(response.data, res, state, prepared.adapter, streamCtx, requestId, () => clientAborted);
      activeStream = null;
      keyStateManager.recordSuccess(endpoint.endpointKey, endpoint.token);
      return { ...result, endpoint };
    } catch (error) {
      response.data?.destroy?.();
      activeStream = null;
      if (clientAborted) error.clientAbort = true;
      throw withContext(error, endpoint, prepared, error.responseBody);
    }
    });
    logStreamSuccess(requestId, routed, baseRequest, routed.endpoint, apiKey, routed.routingState);
    return routed;
  } finally {
    req.off("aborted", abortClient);
    res.off("close", abortClient);
  }
}

function consumeStream(stream, res, state, adapter, streamCtx, requestId, isClientAborted) {
  return new Promise((resolve, reject) => {
    let settled = false, buffer = "", content = "", reasoning = "", usage = null;
    const fail = (error) => { if (!settled) { settled = true; reject(error); } };
    stream.on("data", (chunk) => {
      if (settled) return;
      buffer += chunk.toString();
      const lines = buffer.split("\n"); buffer = lines.pop() || "";
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed.startsWith("data: ")) continue;
        const payload = trimmed.slice(6).trim();
        if (adapter.isStreamEnd(payload)) continue;
        let raw;
        try { raw = JSON.parse(payload); } catch { console.warn(`BACKEND [ID: ${requestId}]: Invalid JSON in stream.`); continue; }
        try {
          const eventError = inBandStreamError(raw);
          if (eventError) throw eventError;
          // buildStreamChunk is the adapter's authoritative parse path and may
          // throw typed in-band failures (for example response.failed).
          const chunkOut = adapter.buildStreamChunk(raw, streamCtx);
          const parsed = adapter.parseStreamChunk(raw, streamCtx);
          if (parsed?.deltaContent) content += parsed.deltaContent;
          if (parsed?.deltaReasoning) reasoning += parsed.deltaReasoning;
          usage = mergeUsage(usage, parsed?.usage);
          if (chunkOut && !res.writableEnded) { markStreamOutputStarted(state); res.write(`data: ${JSON.stringify(chunkOut)}\n\n`); }
        } catch (error) { fail(error); return; }
      }
    });
    stream.on("end", () => {
      if (settled) return; settled = true;
      if (!res.writableEnded) { markStreamOutputStarted(state); res.write("data: [DONE]\n\n"); res.end(); }
      resolve({ content, reasoning, usage });
    });
    stream.on("error", (error) => {
      if (isClientAborted()) error.clientAbort = true;
      fail(error);
    });
  });
}

function billing(usage, input, output, endpoint) {
  return normalizeBillingTokens({ inputTokens: usage?.prompt_tokens ?? input, outputTokens: usage?.completion_tokens ?? output, cacheWriteTokens: usage?.prompt_tokens_details?.cache_creation_input_tokens ?? usage?.prompt_tokens_details?.cache_write_tokens ?? 0, cacheReadTokens: usage?.prompt_tokens_details?.cached_tokens ?? usage?.prompt_tokens_details?.cache_read_tokens ?? 0, inputIncludesCache: endpoint.apiFormat !== "anthropic" });
}

function logStreamSuccess(requestId, result, request, endpoint, apiKey, state) {
  const b = billing(result.usage, estimateTokens(request), estimateTokens(result.content) + estimateTokens(result.reasoning), endpoint);
  logRequestEnd(requestId, true, b.inputTokens, b.outputTokens, null, result.content, apiKey, b.cacheWriteTokens, b.cacheReadTokens, b.tokenAccountingVersion, routingMetadata(state, endpoint));
}

async function makeBackendRequest(requestId, baseRequest, modelName, apiKey) {
  const result = await executeRouting(requestId, modelName, async (_state, endpoint) => {
    const prepared = prepareAttempt(baseRequest, endpoint, requestId, false);
    let response;
    try { response = await axios({ method: "post", url: prepared.requestUrl, headers: prepared.headers, data: prepared.data, timeout: 180000, validateStatus: () => true }); }
    catch (error) { throw withContext(error, endpoint, prepared); }
    if (response.status < 200 || response.status >= 300) throw withContext(httpError(response.status, response.data), endpoint, prepared, response.data);
    keyStateManager.recordSuccess(endpoint.endpointKey, endpoint.token);
    return { parsed: prepared.adapter.parseResponseData(response.data), endpoint };
  });
  const b = billing(result.parsed.usage || {}, estimateTokens(baseRequest), estimateTokens(result.parsed.content), result.endpoint);
  logRequestEnd(requestId, true, b.inputTokens, b.outputTokens, null, result.parsed.content, apiKey, b.cacheWriteTokens, b.cacheReadTokens, b.tokenAccountingVersion, routingMetadata(result.routingState, result.endpoint));
  const response = result.parsed.response;
  if (response && typeof response === "object") response.model = modelName;
  return response;
}

export default router;
