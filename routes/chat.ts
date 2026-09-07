import express, { type Request, type Response } from "express";
import axios from "axios";
import { randomUUID } from "node:crypto";
import { verifyApiKey } from "../middleware/auth.js";
import apiKeyManager from "../services/apiKeyManager.js";
import rateLimiter from "../middleware/rateLimiter.js";
import { logRequestStart, logRequestEnd, logError, markFirstToken, normalizeBillingTokens } from "../utils/logging.js";
import { MODEL_REGISTRY, getFullUrl, estimateTokens, estimateTokensFromLength, isClaudeModel, applyClaudePromptCaching, applyGenerationPolicy, applyBodyParamPolicy, getClientIp } from "../utils/helpers.js";
import { createBoundedText, guardCarryBuffer, type BoundedText } from "../utils/streamLimits.js";
import keyStateManager from "../services/keyStateManager.js";
import { getAdapter, getExtraHeaders } from "../utils/adapters/index.js";
import { buildUpstreamErrorContext, readUpstreamErrorBody } from "../utils/upstreamErrors.js";
import { executeRouting, httpError, statusOf, withContext } from "../utils/requestRouting.js";
import { markStreamOutputStarted, routingMetadata, summarizeRoutingAttempts } from "../utils/autoRouting.js";
import { proxyAgentsFor } from "../utils/proxyAgents.js";
import { applyQueryKeyAuth, upstreamAuthHeaders } from "../utils/endpointPolicies.js";


type DynamicRecord = Record<string, any>;
type StreamWithDestroy = NodeJS.ReadableStream & { destroy?: (error?: Error) => void };
type StreamResult = { content: BoundedText; reasoning: BoundedText; usage: any };


const router = express.Router();
const clone = (value: any): any => structuredClone(value);

function persistUpstreamError({ requestId, modelName, endpointInfo, requestHeaders, upstreamUrl, error, statusCode, responseBody, autoModel, targetModel, routingAttempts }: any) {
  return logError(requestId, error?.name || "Error", error?.message || "Unknown error", error?.stack || "", (buildUpstreamErrorContext as any)({ modelName, endpointInfo, requestHeaders, upstreamUrl, error, statusCode, responseBody, autoModel, targetModel, routingAttempts }));
}

function sendStreamError(res: any, requestId: any, modelName: any, error: any, statusCode: any = 500) {
  if (res.writableEnded) return;
  if (!res.headersSent) res.status(statusCode);
  res.write(`data: ${JSON.stringify({ id: `chatcmpl-${requestId}`, object: "chat.completion.chunk", created: Math.floor(Date.now() / 1000), model: modelName, choices: [{ index: 0, delta: {}, finish_reason: "error" }], error: { message: error?.message || "Unknown error", type: "server_error", code: error?.code || statusCode } })}\n\n`);
  res.write("data: [DONE]\n\n");
  res.end();
}

function prepareAttempt(baseRequest: any, endpoint: any, requestId: any, isStreaming: any) {
  const request = clone(baseRequest);
  let cacheDepth = -1;
  let cacheTtl: "1h" | undefined;
  if (request.cache_depth !== undefined) {
    const parsed = parseInt(request.cache_depth, 10);
    cacheDepth = Number.isNaN(parsed) ? -1 : parsed;
  } else if (endpoint.promptCaching?.enabled === true && isClaudeModel(endpoint.actualModel)) {
    cacheDepth = endpoint.promptCaching.depth;
    cacheTtl = endpoint.promptCaching.ttl;
  }
  delete request.cache_depth;
  delete request.frequency_penalty;
  delete request.presence_penalty;
  request.model = endpoint.targetModel;
  if (endpoint.generationDefaults) applyGenerationPolicy(request, endpoint.generationDefaults);
  if (isClaudeModel(endpoint.actualModel) && cacheDepth !== -1) request.messages = applyClaudePromptCaching(request.messages || [], cacheDepth, cacheTtl);

  const ctx = { requestId, isStreaming };
  const adapter = getAdapter(endpoint.apiFormat);
  const data = isStreaming ? adapter.transformStreamRequest(request, endpoint.actualModel, ctx) : adapter.transformRequest(request, endpoint.actualModel, ctx);
  applyBodyParamPolicy(data, endpoint.bodyParams);
  const headers = {
    ...endpoint.customHeaders,
    ...getExtraHeaders(endpoint.apiFormat, ctx),
    ...upstreamAuthHeaders(endpoint.apiFormat, endpoint.token),
    "Content-Type": "application/json",
  };
  const fullUrl = getFullUrl(endpoint.url, endpoint.apiFormat, endpoint.actualModel, isStreaming, endpoint.appendApiSuffix);
  const requestUrl = applyQueryKeyAuth(fullUrl, endpoint.apiFormat, endpoint.token, isStreaming ? "alt=sse&" : "");
  return { adapter, data, headers, fullUrl, requestUrl };
}

function mergeUsage(current: any, incoming: any) {
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

function inBandStreamError(raw: any) {
  if (raw?.type !== "error") return null;
  const detail = raw.error || {};
  const error = new Error(detail.message || "Upstream stream failed");
  error.name = "UpstreamStreamError";
  error.code = detail.type || detail.code || null;
  const statuses: Record<string, number> = {
    authentication_error: 401,
    permission_error: 403,
    permission_denied: 403,
    billing_error: 402,
    rate_limit_error: 429,
    rate_limit_exceeded: 429,
    overloaded_error: 529,
    api_error: 500,
  };
  error.statusCode = statuses[String(error.code ?? "")] || 500;
  error.responseBody = raw;
  return error;
}

router.post("/v1/chat/completions", verifyApiKey, async (req: any, res: any) => {
  const apiKey = req.apiKey;
  const baseRequest = clone(req.body);
  try { await apiKeyManager.checkForGeneration(apiKey, rateLimiter, estimateTokens(baseRequest.messages || [])); }
  catch (error: any) { return res.status(error.statusCode || 500).json({ error: { message: error.message } }); }

  const requestId = randomUUID();
  const modelName = baseRequest.model;
  const streaming = baseRequest.stream === true;
  const registered = MODEL_REGISTRY[modelName];
  if (!registered) return res.status(404).json({ error: `Model '${modelName}' not found.` });
  // Embedding and image models answer on their own routes: their endpoints
  // expose no completions surface, so serving one here would post a chat body
  // at a URL that cannot answer it.
  if (registered.modality === "embedding") {
    return res.status(400).json({ error: { message: `Model '${modelName}' is an embedding model. Use POST /v1/embeddings instead.`, code: "embedding_model_not_chat" } });
  }
  // Image models answer on the images surface, which takes a prompt rather than
  // a message list and returns image bytes rather than a completion.
  if (registered.modality === "image") {
    return res.status(400).json({ error: { message: `Model '${modelName}' is an image model. Use POST /v1/images instead.`, code: "image_model_not_chat" } });
  }
  await logRequestStart(
    requestId,
    modelName,
    { temperature: baseRequest.temperature, max_tokens: baseRequest.max_tokens, streaming },
    baseRequest.messages || [],
    apiKey,
    {
      client_ip: getClientIp(req),
      protocol: "openai-chat-completions",
      method: req.method,
      path: req.path,
      streaming,
    },
  );
  try {
    if (streaming) await streamFromBackend(req, res, requestId, baseRequest, modelName, apiKey);
    else res.json(await makeBackendRequest(requestId, baseRequest, modelName, apiKey));
  } catch (error: any) {
    const state = error.routingState || null;
    const c = error.attemptContext || {};
    await logRequestEnd(
      requestId,
      false,
      0,
      0,
      error.message,
      "",
      null,
      0,
      0,
      null,
      routingMetadata(state, c.endpointInfo, {
        upstreamUrl: c.upstreamUrl,
        upstreamStatus: c.upstreamStatus ?? statusOf(error),
        proxyStatus: error.clientAbort ? null : statusOf(error) || 500,
      }),
    );
    if (!error.clientAbort) {
      await persistUpstreamError({ requestId, modelName, endpointInfo: c.endpointInfo, requestHeaders: c.requestHeaders, upstreamUrl: c.upstreamUrl, error, statusCode: statusOf(error), responseBody: c.responseBody, autoModel: state?.autoModel, targetModel: state?.currentTargetModel, routingAttempts: summarizeRoutingAttempts(state) });
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

async function streamFromBackend(req: Request, res: Response, requestId: string, baseRequest: DynamicRecord, modelName: string, apiKey: string): Promise<any> {
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");
  const streamCtx = { requestId, modelName, streamId: `chatcmpl-${requestId}`, streamCreated: Math.floor(Date.now() / 1000) };
  const abortController = new AbortController();
  let activeStream: StreamWithDestroy | null = null;
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
    const routed = await executeRouting(requestId, modelName, async (state: any, endpoint: any) => {
    if (clientAborted) {
      const error = new Error("Client aborted stream");
      error.clientAbort = true;
      throw error;
    }
    const prepared = prepareAttempt(baseRequest, endpoint, requestId, true);
    let response;
    const proxy = proxyAgentsFor(endpoint.proxyId);
    try {
      response = await axios({ method: "post", url: prepared.requestUrl, headers: prepared.headers, data: prepared.data, responseType: "stream", timeout: 180000, validateStatus: () => true, signal: abortController.signal, ...(proxy ? { httpAgent: proxy.httpAgent, httpsAgent: proxy.httpsAgent } : {}) });
      activeStream = response.data;
    } catch (error: any) {
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
      await keyStateManager.recordSuccess(endpoint.endpointKey, endpoint.token);
      return {
        ...result,
        endpoint,
        upstreamUrl: prepared.requestUrl,
        upstreamStatus: response.status,
      };
    } catch (error: any) {
      response.data?.destroy?.();
      activeStream = null;
      if (clientAborted) error.clientAbort = true;
      throw withContext(error, endpoint, prepared, error.responseBody);
    }
    });
    await logStreamSuccess(requestId, routed, baseRequest, routed.endpoint, apiKey, routed.routingState);
    return routed;
  } finally {
    req.off("aborted", abortClient);
    res.off("close", abortClient);
  }
}

function consumeStream(stream: StreamWithDestroy, res: Response, state: any, adapter: any, streamCtx: import("../types/adapter.js").AdapterStreamContext, requestId: string, isClientAborted: () => boolean): Promise<StreamResult> {
  return new Promise((resolve: any, reject: any) => {
    let settled = false, buffer = "";
    const content = createBoundedText();
    const reasoning = createBoundedText();
    let usage: any = null;
    const fail = (error: any) => { if (!settled) { settled = true; reject(error); } };
    stream.on("data", (chunk: any) => {
      if (settled) return;
      buffer += chunk.toString();
      // A hostile or broken upstream can withhold newlines indefinitely.
      // Settle before destroying so the close event cannot reclassify this.
      try { guardCarryBuffer(buffer); }
      catch (error: any) { buffer = ""; fail(error); stream.destroy?.(); return; }
      const lines = buffer.split("\n"); buffer = lines.pop() || "";
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed.startsWith("data: ")) continue;
        const payload = trimmed.slice(6).trim();
        if (adapter.isStreamEnd(payload)) continue;
        let raw;
        try { raw = JSON.parse(payload); } catch { console.warn(`BACKEND [ID: ${requestId}]: Invalid JSON in stream.`); continue; }
        // `data: null` and other valid-JSON non-objects carry no event; they
        // must not reach the adapters as if they were chunks.
        if (!raw || typeof raw !== "object") continue;
        try {
          const eventError = inBandStreamError(raw);
          if (eventError) throw eventError;
          // buildStreamChunk is the adapter's authoritative parse path and may
          // throw typed in-band failures (for example response.failed).
          const chunkOut = adapter.buildStreamChunk(raw, streamCtx);
          const parsed = adapter.parseStreamChunk(raw, streamCtx);
          if (parsed?.deltaContent) content.append(parsed.deltaContent);
          if (parsed?.deltaReasoning) reasoning.append(parsed.deltaReasoning);
          usage = mergeUsage(usage, parsed?.usage);
          if (chunkOut && !res.writableEnded) { markStreamOutputStarted(state); markFirstToken(requestId); res.write(`data: ${JSON.stringify(chunkOut)}\n\n`); }
        } catch (error: any) { fail(error); return; }
      }
    });
    stream.on("end", () => {
      if (settled) return; settled = true;
      if (!res.writableEnded) { markStreamOutputStarted(state); res.write("data: [DONE]\n\n"); res.end(); }
      resolve({ content, reasoning, usage });
    });
    stream.on("error", (error: any) => {
      if (isClientAborted()) error.clientAbort = true;
      fail(error);
    });
  });
}

function billing(usage: any, input: any, output: any, endpoint: any) {
  return normalizeBillingTokens({ inputTokens: usage?.prompt_tokens ?? input, outputTokens: usage?.completion_tokens ?? output, cacheWriteTokens: usage?.prompt_tokens_details?.cache_creation_input_tokens ?? usage?.prompt_tokens_details?.cache_write_tokens ?? 0, cacheReadTokens: usage?.prompt_tokens_details?.cached_tokens ?? usage?.prompt_tokens_details?.cache_read_tokens ?? 0, inputIncludesCache: endpoint.apiFormat !== "anthropic" });
}

async function logStreamSuccess(requestId: any, result: any, request: any, endpoint: any, apiKey: any, state: any) {
  // Token estimation uses the full observed output length; only the retained
  // prefix is persisted as response content.
  const b = billing(result.usage, estimateTokens(request), estimateTokensFromLength(result.content.totalLength) + estimateTokensFromLength(result.reasoning.totalLength), endpoint);
  await logRequestEnd(
    requestId,
    true,
    b.inputTokens,
    b.outputTokens,
    null,
    result.content.text,
    apiKey,
    b.cacheWriteTokens,
    b.cacheReadTokens,
    String(b.tokenAccountingVersion),
    routingMetadata(state, endpoint, {
      upstreamUrl: result.upstreamUrl,
      upstreamStatus: result.upstreamStatus,
      proxyStatus: 200,
    }),
  );
}

async function makeBackendRequest(requestId: string, baseRequest: DynamicRecord, modelName: string, apiKey: string): Promise<any> {
  const result = await executeRouting(requestId, modelName, async (_state: any, endpoint: any) => {
    const prepared = prepareAttempt(baseRequest, endpoint, requestId, false);
    const proxy = proxyAgentsFor(endpoint.proxyId);
    let response;
    try { response = await axios({ method: "post", url: prepared.requestUrl, headers: prepared.headers, data: prepared.data, timeout: 180000, validateStatus: () => true, ...(proxy ? { httpAgent: proxy.httpAgent, httpsAgent: proxy.httpsAgent } : {}) }); }
    catch (error: any) { throw withContext(error, endpoint, prepared); }
    if (response.status < 200 || response.status >= 300) throw withContext(httpError(response.status, response.data), endpoint, prepared, response.data);
    await keyStateManager.recordSuccess(endpoint.endpointKey, endpoint.token);
    return {
      parsed: prepared.adapter.parseResponseData(response.data),
      endpoint,
      upstreamUrl: prepared.requestUrl,
      upstreamStatus: response.status,
    };
  });
  const b = billing(result.parsed.usage || {}, estimateTokens(baseRequest), estimateTokens(result.parsed.content), result.endpoint);
  await logRequestEnd(
    requestId,
    true,
    b.inputTokens,
    b.outputTokens,
    null,
    result.parsed.content,
    apiKey,
    b.cacheWriteTokens,
    b.cacheReadTokens,
    String(b.tokenAccountingVersion),
    routingMetadata(result.routingState, result.endpoint, {
      upstreamUrl: result.upstreamUrl,
      upstreamStatus: result.upstreamStatus,
      proxyStatus: 200,
    }),
  );
  const response = result.parsed.response;
  if (response && typeof response === "object") response.model = modelName;
  return response;
}

export default router;
