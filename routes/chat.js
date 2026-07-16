import express from "express";
import axios from "axios";
import { v4 as uuidv4 } from "uuid";
import { verifyApiKey } from "../middleware/auth.js";
import apiKeyManager from "../services/apiKeyManager.js";
import settingsManager from "../services/settingsManager.js";
import rateLimiter from "../middleware/rateLimiter.js";
import { logRequestStart, logRequestEnd, logError } from "../utils/logging.js";
import {
  MODEL_REGISTRY,
  getEndpointForModel,
  getEndpointMeta,
  getFullUrl,
  estimateTokens,
  isClaudeModel,
  applyClaudePromptCaching,
  resolveKeyHealth,
} from "../utils/helpers.js";
import keyStateManager, {
  ACTIONABLE_CODES,
} from "../services/keyStateManager.js";
import { getAdapter, getExtraHeaders } from "../utils/adapters/index.js";
import {
  buildUpstreamErrorContext,
  getUpstreamErrorMessage,
  readUpstreamErrorBody,
} from "../utils/upstreamErrors.js";

const router = express.Router();

function persistUpstreamError({
  requestId,
  modelName,
  endpointInfo,
  requestHeaders,
  upstreamUrl,
  error,
  statusCode,
  responseBody,
}) {
  const context = buildUpstreamErrorContext({
    modelName,
    endpointInfo,
    requestHeaders,
    upstreamUrl,
    error,
    statusCode,
    responseBody,
  });

  return logError(
    requestId,
    error?.name || "Error",
    error?.message || "Unknown error",
    error?.stack || "",
    context,
  );
}

// Records a mid-stream failure against the active key. The upstream already
// returned 200 and then failed partway (e.g. Responses API `response.failed`),
// so this is the only place the failure's status is seen. Sidelines the key for
// actionable codes when key health is on, mirroring the HTTP-status path.
function recordMidStreamFailure(endpointInfo, error) {
  const status = Number(error?.statusCode);
  if (!endpointInfo?.token || !ACTIONABLE_CODES.has(status)) return;
  const sideline = resolveKeyHealth(endpointInfo.keyHealth);
  keyStateManager.recordFailure(endpointInfo.endpointKey, endpointInfo.token, status, { sideline });
}

function sendStreamError(res, requestId, modelName, error, statusCode = 500) {
  if (res.writableEnded) return;

  const errorChunk = {
    id: `chatcmpl-${requestId}`,
    object: "chat.completion.chunk",
    created: Math.floor(Date.now() / 1000),
    model: modelName,
    choices: [
      {
        index: 0,
        delta: {},
        finish_reason: "error",
      },
    ],
    error: {
      message: error?.message || "Unknown error",
      type: "server_error",
      code: statusCode,
    },
  };

  res.write(`data: ${JSON.stringify(errorChunk)}\n\n`);
  res.write("data: [DONE]\n\n");
  res.end();
}

router.post("/v1/chat/completions", verifyApiKey, async (req, res) => {
  const apiKey = req.apiKey;

  const contextTokens = estimateTokens(req.body.messages || []);

  try {
    apiKeyManager.checkForGeneration(apiKey, rateLimiter, contextTokens);
  } catch (error) {
    return res
      .status(error.statusCode || 500)
      .json({ error: { message: error.message } });
  }

  const openaiReq = req.body;
  const requestId = uuidv4();
  const isStreaming = openaiReq.stream === true;
  const modelName = openaiReq.model;

  // Extract and remove cache_depth before forwarding.
  // Per-request override takes priority; falls back to per-endpoint setting.
  let cacheDepth = -1;
  if (openaiReq.cache_depth !== undefined) {
    cacheDepth = parseInt(openaiReq.cache_depth, 10);
  } else {
    // Metadata read only — must NOT select a key or advance rotation.
    const endpointMeta = getEndpointMeta(modelName);
    if (endpointMeta?.promptCaching?.enabled === true && isClaudeModel(endpointMeta.actualModel)) {
      cacheDepth = endpointMeta.promptCaching.depth;
    }
  }
  delete openaiReq.cache_depth;

  // Validate model
  const modelInfo = MODEL_REGISTRY[modelName];
  if (!modelInfo) {
    return res.status(404).json({ error: `Model '${modelName}' not found.` });
  }

  // Remove unwanted parameters
  const paramsToExclude = ["frequency_penalty", "presence_penalty"];
  for (const param of paramsToExclude) {
    delete openaiReq[param];
  }

  // Apply per-endpoint generation defaults before adapter transformation.
  // Client-provided values always win; defaults only fill missing fields.
  // Metadata read only — must NOT select a key or advance rotation.
  const endpointMeta = getEndpointMeta(modelName);
  if (endpointMeta?.generationDefaults) {
    const defaults = endpointMeta.generationDefaults;
    for (const [param, config] of Object.entries(defaults)) {
      if (config.enabled && config.value !== undefined && config.value !== null) {
        if (openaiReq[param] === undefined || openaiReq[param] === null) {
          openaiReq[param] = config.value;
        }
      }
    }
  }

  // Log request start
  const requestParams = {
    temperature: openaiReq.temperature,
    max_tokens: openaiReq.max_tokens,
    streaming: isStreaming,
  };
  const messages = openaiReq.messages || [];
  logRequestStart(requestId, modelName, requestParams, messages, apiKey);

  try {
    if (isStreaming) {
      await streamFromBackend(
        req,
        res,
        requestId,
        openaiReq,
        modelName,
        apiKey,
        cacheDepth,
      );
    } else {
      const responseData = await makeBackendRequest(
        requestId,
        openaiReq,
        modelName,
        apiKey,
        cacheDepth,
      );
      res.json(responseData);
    }
  } catch (error) {
    logRequestEnd(requestId, false, 0, 0, error.message);
    console.error(`API [ID: ${requestId}]: Exception:`, error);

    if (!res.headersSent) {
      res.status(error.statusCode || error.response?.status || 500).json({
        error: { message: error.message || String(error) },
      });
    } else if (!res.writableEnded) {
      res.end();
    }
  }
});

async function streamFromBackend(
  req,
  res,
  requestId,
  openaiReq,
  modelName,
  apiKey,
  cacheDepth = -1,
) {
  let accumulatedContent = "";
  let accumulatedReasoning = "";

  // Set streaming headers
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");

  // Build adapter context for building OpenAI-shaped chunks
  const streamCtx = {
    requestId,
    modelName,
    streamId: `chatcmpl-${requestId}`,
    streamCreated: Math.floor(Date.now() / 1000),
  };

  let endpointInfo = null;
  let adapter = null;
  let fullUrl = null;
  let data = null;
  let headers = {};
  let streamSettled = false;

  try {
    let streamUsage = null;
    let response = null;

    // Smart key selection with single-request retry across usable keys.
    // Only 400/401/402/429 trigger a hop; any other status/error is terminal.
    const triedHashes = new Set();
    const maxAttempts =
      1 + Math.max(0, parseInt(settingsManager.get("keyHopAttempts"), 10) || 0);

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      endpointInfo = getEndpointForModel(modelName, { excludeHashes: triedHashes });
      if (!endpointInfo) {
        const error = new Error("Can't find the model you're looking for.");
        error.name = "EndpointResolutionError";
        error.statusCode = 404;
        throw error;
      }
      if (endpointInfo.tokenExhausted || !endpointInfo.token) {
        throw keyStateManager.buildExhaustionError(endpointInfo.endpointKey);
      }

      const {
        url: backendUrl,
        token: backendToken,
        actualModel,
        customHeaders,
        apiFormat,
        endpointKey,
        tokenHash,
      } = endpointInfo;
      adapter = getAdapter(apiFormat);
      fullUrl = getFullUrl(backendUrl, apiFormat, actualModel, true);
      let messages = openaiReq.messages || [];

      // Apply Claude prompt caching if the target model is Claude and caching is enabled
      // (only meaningful for OpenAI-compat and Anthropic formats)
      if (isClaudeModel(actualModel) && cacheDepth !== -1) {
        messages = applyClaudePromptCaching(messages, cacheDepth);
        console.log(
          `Prompt caching applied (depth=${cacheDepth}): ${
            messages.filter((m) => {
              const content = m.content;
              if (Array.isArray(content))
                return content.some((b) => b.cache_control);
              return false;
            }).length
          } message(s) marked for caching`,
        );
      }

      // Build the request body using the adapter
      const reqForAdapter = { ...openaiReq, messages };
      data = adapter.transformStreamRequest(reqForAdapter, actualModel);

      // Build headers: custom + adapter-specific (e.g. anthropic-version) + auth
      const extraHeaders = getExtraHeaders(apiFormat);
      headers = {
        ...customHeaders,
        ...extraHeaders,
        "Content-Type": "application/json",
      };

      // Auth depends on format: gemini uses ?key=, anthropic uses x-api-key, openai uses Bearer
      if (apiFormat === "gemini") {
        // Auth is in the URL query param, no auth header needed
      } else if (apiFormat === "anthropic") {
        headers["x-api-key"] = backendToken;
      } else {
        headers["Authorization"] = `Bearer ${backendToken}`;
      }

      const requestUrl = apiFormat === "gemini"
        ? `${fullUrl}?alt=sse&key=${backendToken}`
        : fullUrl;

      const resp = await axios({
        method: "post",
        url: requestUrl,
        headers,
        data,
        responseType: "stream",
        timeout: 180000,
        validateStatus: () => true,
      });

      if (resp.status >= 200 && resp.status < 300) {
        keyStateManager.recordSuccess(endpointKey, backendToken);
        response = resp;
        break;
      }

      // Non-2xx. Only actionable codes update key state and may trigger a hop.
      // sideline benches the key (invalid/timeout) only when key health is on
      // for this endpoint; when off, the failure is counted but the key stays
      // usable and the request just hops to the next one.
      const canRetry = attempt < maxAttempts - 1;
      if (ACTIONABLE_CODES.has(resp.status)) {
        const sideline = resolveKeyHealth(endpointInfo.keyHealth);
        keyStateManager.recordFailure(endpointKey, backendToken, resp.status, { sideline });
        triedHashes.add(tokenHash);
        if (canRetry) {
          resp.data?.destroy?.();
          continue;
        }
      }

      // Terminal failure: non-actionable status, or actionable but out of hops.
      const responseBody = await readUpstreamErrorBody(resp.data);
      const upstreamMessage = getUpstreamErrorMessage(responseBody);
      const error = new Error(`Error ${resp.status}: ${upstreamMessage}`);
      error.name = "UpstreamHttpError";
      error.statusCode = resp.status;

      persistUpstreamError({
        requestId,
        modelName,
        endpointInfo,
        requestHeaders: headers,
        upstreamUrl: fullUrl,
        error,
        statusCode: resp.status,
        responseBody,
      });
      logRequestEnd(requestId, false, 0, 0, error.message);
      sendStreamError(res, requestId, modelName, error, resp.status);
      return;
    }

    if (!response) {
      throw keyStateManager.buildExhaustionError(endpointInfo?.endpointKey);
    }

    let buffer = "";
    let currentEvent = null; // track event: type for typed-event streams (anthropic, responses)

    response.data.on("data", (chunk) => {
      buffer += chunk.toString();
      const lines = buffer.split("\n");
      buffer = lines.pop() || "";

      for (const line of lines) {
        const trimmed = line.trim();

        // Track event type for typed-event streams (Anthropic, Responses API)
        if (trimmed.startsWith("event: ")) {
          currentEvent = trimmed.slice(7).trim();
          continue;
        }

        if (trimmed.startsWith("data: ")) {
          const payload = trimmed.slice(6).trim();

          // Check for [DONE] sentinel (OpenAI / OpenAI-compat streams)
          if (adapter.isStreamEnd(payload)) {
            res.write("data: [DONE]\n\n");
            return;
          }

          let chunkData;
          try {
            chunkData = JSON.parse(payload);
          } catch {
            console.warn(`BACKEND [ID: ${requestId}]: Invalid JSON in stream.`);
            continue;
          }

          try {
            if (chunkData && typeof chunkData === "object") {
              // Build OpenAI-compatible chunk via adapter
              const openaiChunk = adapter.buildStreamChunk(chunkData, streamCtx);
              if (openaiChunk) {
                // Track accumulated content for usage estimation
                const parsed = adapter.parseStreamChunk(chunkData, streamCtx);
                if (parsed?.deltaContent) {
                  accumulatedContent += parsed.deltaContent;
                }
                if (parsed?.deltaReasoning) {
                  accumulatedReasoning += parsed.deltaReasoning;
                }
                if (parsed?.usage) {
                  streamUsage = parsed.usage;
                }
                if (!res.writableEnded) {
                  res.write(`data: ${JSON.stringify(openaiChunk)}\n\n`);
                }
              }
            }
          } catch (error) {
            if (streamSettled) return;
            streamSettled = true;
            error.name = error.name || "StreamAdapterError";

            // A mid-stream failure carries its own statusCode; record it so an
            // actionable code still sidelines the key even though the upstream
            // returned 200 before failing.
            recordMidStreamFailure(endpointInfo, error);
            const statusCode = error.statusCode ?? 500;
            persistUpstreamError({
              requestId,
              modelName,
              endpointInfo,
              requestHeaders: headers,
              upstreamUrl: fullUrl,
              error,
              statusCode,
              responseBody: chunkData,
            });
            logRequestEnd(requestId, false, 0, 0, error.message);
            sendStreamError(res, requestId, modelName, error, statusCode);
            response.data.destroy();
            return;
          }
          // Reset event tracker after processing data line
          currentEvent = null;
        }
      }
    });

    response.data.on("end", () => {
      if (streamSettled) return;
      streamSettled = true;

      // Use real usage from the final chunk if available, otherwise estimate
      const inputTokens =
        streamUsage?.prompt_tokens ?? estimateTokens(openaiReq);
      // Include reasoning text in the estimate — thinking models can spend
      // many tokens on reasoning that isn't in accumulatedContent. If the
      // upstream reported a non-zero completion_tokens we trust that;
      // otherwise estimate from content + reasoning combined.
      const estimatedOutput =
        estimateTokens(accumulatedContent) +
        estimateTokens(accumulatedReasoning);
      const outputTokens =
        streamUsage?.completion_tokens ?? estimatedOutput;
      const cacheWriteTokens =
        streamUsage?.prompt_tokens_details?.cache_creation_input_tokens
        ?? streamUsage?.prompt_tokens_details?.cache_write_tokens
        ?? 0;
      const cacheReadTokens =
        streamUsage?.prompt_tokens_details?.cached_tokens
        ?? streamUsage?.prompt_tokens_details?.cache_read_tokens
        ?? 0;
      logRequestEnd(
        requestId,
        true,
        inputTokens,
        outputTokens,
        null,
        accumulatedContent,
        apiKey,
        cacheWriteTokens,
        cacheReadTokens,
      );
      // Always send [DONE] to close the stream for the client
      if (!res.writableEnded) {
        res.write("data: [DONE]\n\n");
        res.end();
      }
    });

    response.data.on("error", (error) => {
      if (streamSettled) return;
      streamSettled = true;
      // Skip logging client-side stream aborts (user disconnected) — not an upstream failure.
      if (error && typeof error.message === "string" && /abort/i.test(error.message)) {
        console.error(`BACKEND [ID: ${requestId}]: Client aborted stream, skipping error log.`);
        logRequestEnd(requestId, false, 0, 0, error.message);
        if (!res.writableEnded) {
          try { res.end(); } catch (_) {}
        }
        response.data.destroy();
        return;
      }
      console.error(`BACKEND [ID: ${requestId}]: Stream error:`, error);

      persistUpstreamError({
        requestId,
        modelName,
        endpointInfo,
        requestHeaders: headers,
        upstreamUrl: fullUrl,
        error,
      });
      logRequestEnd(requestId, false, 0, 0, error.message);
      sendStreamError(res, requestId, modelName, error, 500);
    });
  } catch (error) {
    console.error(`BACKEND [ID: ${requestId}]: Stream error:`, error);
    const responseBody = await readUpstreamErrorBody(
      error.responseBody ?? error.response?.data,
    );
    const statusCode = error.response?.status ?? error.statusCode ?? 500;

    persistUpstreamError({
      requestId,
      modelName,
      endpointInfo,
      requestHeaders: headers,
      upstreamUrl: fullUrl,
      error,
      statusCode,
      responseBody,
    });
    logRequestEnd(requestId, false, 0, 0, error.message);
    sendStreamError(res, requestId, modelName, error, statusCode);
  }
}

async function makeBackendRequest(
  requestId,
  openaiReq,
  modelName,
  apiKey,
  cacheDepth = -1,
) {
  let endpointInfo = null;
  let fullUrl = null;
  let data = null;
  let headers = {};
  let upstreamResponseBody = null;

  try {
    let adapter = null;
    let response = null;

    // Smart key selection with single-request retry across usable keys.
    // Only 400/401/402/429 trigger a hop; any other status/error is terminal.
    const triedHashes = new Set();
    const maxAttempts =
      1 + Math.max(0, parseInt(settingsManager.get("keyHopAttempts"), 10) || 0);

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      endpointInfo = getEndpointForModel(modelName, { excludeHashes: triedHashes });
      if (!endpointInfo) {
        const error = new Error("Can't find the model you're looking for.");
        error.name = "EndpointResolutionError";
        error.statusCode = 404;
        throw error;
      }
      if (endpointInfo.tokenExhausted || !endpointInfo.token) {
        throw keyStateManager.buildExhaustionError(endpointInfo.endpointKey);
      }

      const {
        url: backendUrl,
        token: backendToken,
        actualModel,
        customHeaders,
        apiFormat,
        endpointKey,
        tokenHash,
      } = endpointInfo;
      adapter = getAdapter(apiFormat);
      fullUrl = getFullUrl(backendUrl, apiFormat, actualModel);
      let messages = openaiReq.messages || [];

      // Apply Claude prompt caching if the target model is Claude and caching is enabled
      if (isClaudeModel(actualModel) && cacheDepth !== -1) {
        messages = applyClaudePromptCaching(messages, cacheDepth);
        console.log(
          `Prompt caching applied (depth=${cacheDepth}): ${
            messages.filter((m) => {
              const content = m.content;
              if (Array.isArray(content))
                return content.some((b) => b.cache_control);
              return false;
            }).length
          } message(s) marked for caching`,
        );
      }

      // Build the request body using the adapter
      const reqForAdapter = { ...openaiReq, messages };
      data = adapter.transformRequest(reqForAdapter, actualModel);

      // Build headers: custom + adapter-specific + auth
      const extraHeaders = getExtraHeaders(apiFormat);
      headers = {
        ...customHeaders,
        ...extraHeaders,
        "Content-Type": "application/json",
      };

      if (apiFormat === "gemini") {
        // Auth is in the URL query param
      } else if (apiFormat === "anthropic") {
        headers["x-api-key"] = backendToken;
      } else {
        headers["Authorization"] = `Bearer ${backendToken}`;
      }

      const requestUrl = apiFormat === "gemini" ? `${fullUrl}?key=${backendToken}` : fullUrl;

      const resp = await axios({
        method: "post",
        url: requestUrl,
        headers,
        data,
        timeout: 180000,
        validateStatus: () => true,
      });

      if (resp.status >= 200 && resp.status < 300) {
        keyStateManager.recordSuccess(endpointKey, backendToken);
        response = resp;
        upstreamResponseBody = resp.data;
        break;
      }

      // Non-2xx. Only actionable codes update key state and may trigger a hop.
      // sideline benches the key only when key health is on for this endpoint.
      const canRetry = attempt < maxAttempts - 1;
      const sideline = resolveKeyHealth(endpointInfo.keyHealth);
      if (ACTIONABLE_CODES.has(resp.status) && canRetry) {
        keyStateManager.recordFailure(endpointKey, backendToken, resp.status, { sideline });
        triedHashes.add(tokenHash);
        continue;
      }
      if (ACTIONABLE_CODES.has(resp.status)) {
        keyStateManager.recordFailure(endpointKey, backendToken, resp.status, { sideline });
      }

      // Terminal failure: non-actionable status, or actionable but out of hops.
      upstreamResponseBody = resp.data;
      console.error(`BACKEND [ID: ${requestId}]:`, resp.data);
      const error = new Error(
        `Error ${resp.status}: ${getUpstreamErrorMessage(resp.data)}`,
      );
      error.name = "UpstreamHttpError";
      error.statusCode = resp.status;
      error.responseBody = resp.data;
      throw error;
    }

    if (!response) {
      throw keyStateManager.buildExhaustionError(endpointInfo?.endpointKey);
    }

    const rawData = response.data;

    // Parse the response using the adapter
    const parsed = adapter.parseResponseData(rawData);

    const content = parsed.content;
    const usage = parsed.usage || {};
    const inputTokens =
      usage.prompt_tokens ?? estimateTokens(openaiReq);
    const outputTokens = usage.completion_tokens ?? estimateTokens(content);
    const cacheWriteTokens =
      usage.prompt_tokens_details?.cache_creation_input_tokens
      ?? usage.prompt_tokens_details?.cache_write_tokens
      ?? 0;
    const cacheReadTokens =
      usage.prompt_tokens_details?.cached_tokens
      ?? usage.prompt_tokens_details?.cache_read_tokens
      ?? 0;

    logRequestEnd(
      requestId,
      true,
      inputTokens,
      outputTokens,
      null,
      content,
      apiKey,
      cacheWriteTokens,
      cacheReadTokens,
    );

    // Return the OpenAI-compatible response object
    return parsed.response ?? rawData;
  } catch (error) {
    const responseBody = await readUpstreamErrorBody(
      error.responseBody ?? error.response?.data ?? upstreamResponseBody,
    );
    const statusCode = error.response?.status ?? error.statusCode ?? null;

    console.error(`BACKEND [ID: ${requestId}]: Error:`, error.message);
    if (statusCode) {
      console.error(`BACKEND [ID: ${requestId}]: Status:`, statusCode);
    }
    if (responseBody !== null) {
      console.error(`BACKEND [ID: ${requestId}]: Response:`, responseBody);
    }

    persistUpstreamError({
      requestId,
      modelName,
      endpointInfo,
      requestHeaders: headers,
      upstreamUrl: fullUrl,
      error,
      statusCode,
      responseBody,
    });
    logRequestEnd(requestId, false, 0, 0, error.message);
    throw error;
  }
}

export default router;
