import express from "express";
import axios from "axios";
import { v4 as uuidv4 } from "uuid";
import { verifyApiKey } from "../middleware/auth.js";
import apiKeyManager from "../services/apiKeyManager.js";
import settingsManager from "../services/settingsManager.js";
import keyStateManager, { ACTIONABLE_CODES } from "../services/keyStateManager.js";
import rateLimiter from "../middleware/rateLimiter.js";
import { logRequestStart, logRequestEnd, logError } from "../utils/logging.js";
import {
  MODEL_REGISTRY,
  getEndpointForModel,
  getFullUrl,
  estimateTokens,
  isClaudeModel,
  resolveKeyHealth,
} from "../utils/helpers.js";
import { getAdapter, getExtraHeaders } from "../utils/adapters/index.js";
import {
  buildUpstreamErrorContext,
  getUpstreamErrorMessage,
  readUpstreamErrorBody,
} from "../utils/upstreamErrors.js";

const router = express.Router();

// --- Anthropic ↔ OpenAI conversion helpers ---

function anthropicToOpenAIMessages(anthropicReq) {
  const messages = [];

  if (anthropicReq.system) {
    if (typeof anthropicReq.system === "string") {
      messages.push({ role: "system", content: anthropicReq.system });
    } else if (Array.isArray(anthropicReq.system)) {
      const text = anthropicReq.system
        .map((b) => b.text || "")
        .filter(Boolean)
        .join("\n");
      if (text) messages.push({ role: "system", content: text });
    }
  }

  for (const msg of anthropicReq.messages || []) {
    const role = msg.role === "assistant" ? "assistant" : "user";
    let content = msg.content;

    if (typeof content === "string") {
      messages.push({ role, content });
      continue;
    }

    if (Array.isArray(content)) {
      const openaiBlocks = [];
      const toolCalls = [];
      const toolResultMessages = [];

      for (const block of content) {
        if (block.type === "text") {
          openaiBlocks.push({ type: "text", text: block.text });
        } else if (block.type === "image") {
          const src = block.source;
          if (src?.type === "base64") {
            openaiBlocks.push({
              type: "image_url",
              image_url: { url: `data:${src.media_type};base64,${src.data}` },
            });
          }
        } else if (block.type === "tool_use") {
          toolCalls.push({
            id: block.id,
            type: "function",
            function: {
              name: block.name,
              arguments: JSON.stringify(block.input ?? {}),
            },
          });
        } else if (block.type === "tool_result") {
          toolResultMessages.push({
            role: "tool",
            tool_call_id: block.tool_use_id,
            content: toolResultText(block.content),
          });
        } else {
          openaiBlocks.push(block);
        }
      }

      // Emit the assistant/user message, attaching any tool_calls it produced.
      // Skip it entirely when the turn carried only tool_result blocks —
      // those become their own role:"tool" messages below.
      if (toolCalls.length > 0) {
        messages.push({
          role,
          content: openaiBlocks.length > 0 ? openaiBlocks : null,
          tool_calls: toolCalls,
        });
      } else if (openaiBlocks.length > 0 || toolResultMessages.length === 0) {
        messages.push({ role, content: openaiBlocks });
      }

      // tool_result blocks become their own role:"tool" messages.
      for (const trm of toolResultMessages) {
        messages.push(trm);
      }
      continue;
    }

    messages.push({ role, content: content || "" });
  }

  return messages;
}

function anthropicToolsToOpenAI(tools) {
  if (!tools || !Array.isArray(tools)) return undefined;
  return tools.map((t) => ({
    type: "function",
    function: {
      name: t.name,
      description: t.description || "",
      parameters: t.input_schema || {},
    },
  }));
}

function openAIResponseToAnthropic(openaiData, modelName, requestId) {
  const choice = openaiData.choices?.[0];
  const message = choice?.message || {};
  const contentBlocks = [];

  if (message.content) {
    contentBlocks.push({ type: "text", text: message.content });
  }

  if (message.tool_calls) {
    for (const tc of message.tool_calls) {
      contentBlocks.push({
        type: "tool_use",
        id: tc.id || `toolu_${uuidv4().replace(/-/g, "").slice(0, 20)}`,
        name: tc.function?.name || "",
        input: safeParseJSON(tc.function?.arguments || "{}"),
      });
    }
  }

  if (contentBlocks.length === 0) {
    contentBlocks.push({ type: "text", text: "" });
  }

  const usage = openaiData.usage || {};
  let stopReason = "end_turn";
  if (choice?.finish_reason === "length") stopReason = "max_tokens";
  else if (choice?.finish_reason === "tool_calls") stopReason = "tool_use";
  else if (choice?.finish_reason === "stop") stopReason = "end_turn";

  return {
    id: openaiData.id || `msg_${requestId}`,
    type: "message",
    role: "assistant",
    model: modelName,
    content: contentBlocks,
    stop_reason: stopReason,
    stop_sequence: null,
    usage: {
      input_tokens: usage.prompt_tokens || 0,
      output_tokens: usage.completion_tokens || 0,
    },
  };
}

function safeParseJSON(str) {
  try { return JSON.parse(str); } catch { return {}; }
}

// Anthropic tool_result content may be a string or an array of blocks.
// OpenAI's role:"tool" message expects a plain string.
function toolResultText(content) {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((b) => {
        if (typeof b === "string") return b;
        if (b?.type === "text") return b.text || "";
        return JSON.stringify(b);
      })
      .filter(Boolean)
      .join("\n");
  }
  if (content == null) return "";
  return JSON.stringify(content);
}

// --- Anthropic SSE stream writer ---

function writeAnthropicEvent(res, event, data) {
  if (res.writableEnded) return;
  res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

function sendAnthropicStreamError(res, error, statusCode = 500) {
  if (res.writableEnded) return;
  writeAnthropicEvent(res, "error", {
    type: "error",
    error: {
      type: "api_error",
      message: error?.message || "Internal server error",
    },
  });
  res.end();
}

// --- Error persistence (shared with chat.js pattern) ---

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

// --- Route: POST /v1/messages ---

router.post("/v1/messages", verifyApiKey, async (req, res) => {
  const apiKey = req.apiKey;
  const anthropicReq = req.body;
  const modelName = anthropicReq.model;
  const isStreaming = anthropicReq.stream === true;
  const requestId = uuidv4();

  // Convert Anthropic messages to OpenAI format for token estimation
  const openaiMessages = anthropicToOpenAIMessages(anthropicReq);
  const contextTokens = estimateTokens(openaiMessages);

  try {
    apiKeyManager.checkForGeneration(apiKey, rateLimiter, contextTokens);
  } catch (error) {
    return res.status(error.statusCode || 500).json({
      type: "error",
      error: { type: "invalid_request_error", message: error.message },
    });
  }

  // Validate model
  const modelInfo = MODEL_REGISTRY[modelName];
  if (!modelInfo) {
    return res.status(404).json({
      type: "error",
      error: { type: "not_found_error", message: `Model '${modelName}' not found.` },
    });
  }

  // Log request start
  const requestParams = {
    temperature: anthropicReq.temperature,
    max_tokens: anthropicReq.max_tokens,
    streaming: isStreaming,
  };
  logRequestStart(requestId, modelName, requestParams, openaiMessages, apiKey);

  try {
    if (isStreaming) {
      await streamMessages(req, res, requestId, anthropicReq, modelName, apiKey, openaiMessages);
    } else {
      const responseData = await makeMessagesRequest(requestId, anthropicReq, modelName, apiKey, openaiMessages);
      res.json(responseData);
    }
  } catch (error) {
    logRequestEnd(requestId, false, 0, 0, error.message);
    console.error(`MESSAGES [ID: ${requestId}]: Exception:`, error);

    if (!res.headersSent) {
      res.status(error.statusCode || error.response?.status || 500).json({
        type: "error",
        error: { type: "api_error", message: error.message || String(error) },
      });
    } else if (!res.writableEnded) {
      res.end();
    }
  }
});

// --- Non-streaming request ---

async function makeMessagesRequest(requestId, anthropicReq, modelName, apiKey, openaiMessages) {
  let endpointInfo = null;
  let fullUrl = null;
  let data = null;
  let headers = {};
  let upstreamResponseBody = null;

  try {
    let response = null;
    let apiFormat = null;

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
        endpointKey,
        tokenHash,
      } = endpointInfo;
      apiFormat = endpointInfo.apiFormat;

      if (apiFormat === "anthropic") {
        // Backend is native Anthropic — forward the request mostly as-is
        fullUrl = getFullUrl(backendUrl, apiFormat, actualModel);
        data = {
          ...anthropicReq,
          model: actualModel,
          stream: false,
        };
        delete data.stream;

        const extraHeaders = getExtraHeaders(apiFormat);
        headers = {
          ...customHeaders,
          ...extraHeaders,
          "Content-Type": "application/json",
          "x-api-key": backendToken,
        };
      } else {
        // Backend is OpenAI/Gemini — convert Anthropic → OpenAI, then use adapters
        const adapter = getAdapter(apiFormat);
        fullUrl = getFullUrl(backendUrl, apiFormat, actualModel);

        const openaiReq = {
          model: actualModel,
          messages: openaiMessages,
          max_tokens: anthropicReq.max_tokens,
          temperature: anthropicReq.temperature,
          top_p: anthropicReq.top_p,
          tools: anthropicToolsToOpenAI(anthropicReq.tools),
          stream: false,
        };
        Object.keys(openaiReq).forEach((k) => {
          if (openaiReq[k] === undefined || openaiReq[k] === null) delete openaiReq[k];
        });

        data = adapter.transformRequest(openaiReq, actualModel);

        const extraHeaders = getExtraHeaders(apiFormat);
        headers = {
          ...customHeaders,
          ...extraHeaders,
          "Content-Type": "application/json",
        };

        if (apiFormat === "gemini") {
          // handled in URL
        } else {
          headers["Authorization"] = `Bearer ${backendToken}`;
        }
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

      upstreamResponseBody = resp.data;
      const error = new Error(`Error ${resp.status}: ${getUpstreamErrorMessage(resp.data)}`);
      error.name = "UpstreamHttpError";
      error.statusCode = resp.status;
      error.responseBody = resp.data;
      throw error;
    }

    if (!response) {
      throw keyStateManager.buildExhaustionError(endpointInfo?.endpointKey);
    }

    const rawData = response.data;
    let anthropicResponse;
    let contentText = "";
    let usage = {};

    if (apiFormat === "anthropic") {
      // Already in Anthropic format
      anthropicResponse = rawData;
      contentText = (rawData.content || [])
        .filter((b) => b.type === "text")
        .map((b) => b.text)
        .join("");
      usage = {
        prompt_tokens: rawData.usage?.input_tokens || 0,
        completion_tokens: rawData.usage?.output_tokens || 0,
      };
    } else {
      // Convert OpenAI response → Anthropic format
      const adapter = getAdapter(apiFormat);
      const parsed = adapter.parseResponseData(rawData);
      contentText = parsed.content || "";
      usage = parsed.usage || {};
      anthropicResponse = openAIResponseToAnthropic(parsed.response || rawData, modelName, requestId);
    }

    const inputTokens = usage.prompt_tokens ?? estimateTokens(openaiMessages);
    const outputTokens = usage.completion_tokens ?? estimateTokens(contentText);
    const cacheWriteTokens = usage.prompt_tokens_details?.cache_creation_input_tokens
      ?? usage.prompt_tokens_details?.cache_write_tokens ?? 0;
    const cacheReadTokens = usage.prompt_tokens_details?.cached_tokens
      ?? usage.prompt_tokens_details?.cache_read_tokens ?? 0;

    logRequestEnd(requestId, true, inputTokens, outputTokens, null, contentText, apiKey, cacheWriteTokens, cacheReadTokens);

    return anthropicResponse;
  } catch (error) {
    const responseBody = await readUpstreamErrorBody(
      error.responseBody ?? error.response?.data ?? upstreamResponseBody,
    );
    const statusCode = error.response?.status ?? error.statusCode ?? null;

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

// --- Streaming request ---

async function streamMessages(req, res, requestId, anthropicReq, modelName, apiKey, openaiMessages) {
  let accumulatedContent = "";
  let endpointInfo = null;
  let fullUrl = null;
  let headers = {};
  let streamSettled = false;

  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");

  try {
    let response = null;
    let apiFormat = null;

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
        endpointKey,
        tokenHash,
      } = endpointInfo;
      apiFormat = endpointInfo.apiFormat;

      let data;

      if (apiFormat === "anthropic") {
        // Native Anthropic backend — forward as-is with stream: true
        fullUrl = getFullUrl(backendUrl, apiFormat, actualModel);
        data = {
          ...anthropicReq,
          model: actualModel,
          stream: true,
        };

        const extraHeaders = getExtraHeaders(apiFormat);
        headers = {
          ...customHeaders,
          ...extraHeaders,
          "Content-Type": "application/json",
          "x-api-key": backendToken,
        };
      } else {
        // Non-Anthropic backend — convert to OpenAI format, stream, then re-wrap as Anthropic SSE
        const adapter = getAdapter(apiFormat);
        fullUrl = getFullUrl(backendUrl, apiFormat, actualModel, true);

        const openaiReq = {
          model: actualModel,
          messages: openaiMessages,
          max_tokens: anthropicReq.max_tokens,
          temperature: anthropicReq.temperature,
          top_p: anthropicReq.top_p,
          tools: anthropicToolsToOpenAI(anthropicReq.tools),
          stream: true,
        };
        Object.keys(openaiReq).forEach((k) => {
          if (openaiReq[k] === undefined || openaiReq[k] === null) delete openaiReq[k];
        });

        data = adapter.transformStreamRequest(openaiReq, actualModel);

        const extraHeaders = getExtraHeaders(apiFormat);
        headers = {
          ...customHeaders,
          ...extraHeaders,
          "Content-Type": "application/json",
        };

        if (apiFormat === "gemini") {
          // handled in URL
        } else {
          headers["Authorization"] = `Bearer ${backendToken}`;
        }
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
      // sideline benches the key only when key health is on for this endpoint.
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

      const responseBody = await readUpstreamErrorBody(resp.data);
      const error = new Error(`Error ${resp.status}: ${getUpstreamErrorMessage(responseBody)}`);
      error.name = "UpstreamHttpError";
      error.statusCode = resp.status;

      persistUpstreamError({ requestId, modelName, endpointInfo, requestHeaders: headers, upstreamUrl: fullUrl, error, statusCode: resp.status, responseBody });
      logRequestEnd(requestId, false, 0, 0, error.message);
      sendAnthropicStreamError(res, error, resp.status);
      return;
    }

    if (!response) {
      throw keyStateManager.buildExhaustionError(endpointInfo?.endpointKey);
    }

    if (apiFormat === "anthropic") {
      // Pass through Anthropic SSE events as-is (they're already in the right format)
      streamAnthropicPassthrough(res, response.data, requestId, modelName, apiKey, openaiMessages, endpointInfo, headers, fullUrl, () => streamSettled, (v) => { streamSettled = v; });
    } else {
      // Convert OpenAI-style stream to Anthropic SSE events
      streamOpenAIToAnthropic(res, response.data, requestId, modelName, apiKey, openaiMessages, endpointInfo, headers, fullUrl, apiFormat, () => streamSettled, (v) => { streamSettled = v; });
    }
  } catch (error) {
    console.error(`MESSAGES [ID: ${requestId}]: Stream error:`, error);
    const responseBody = await readUpstreamErrorBody(error.responseBody ?? error.response?.data);
    const statusCode = error.response?.status ?? error.statusCode ?? 500;

    persistUpstreamError({ requestId, modelName, endpointInfo, requestHeaders: headers, upstreamUrl: fullUrl, error, statusCode, responseBody });
    logRequestEnd(requestId, false, 0, 0, error.message);
    sendAnthropicStreamError(res, error, statusCode);
  }
}

// Pass through Anthropic SSE events, tracking content for logging
function streamAnthropicPassthrough(res, stream, requestId, modelName, apiKey, openaiMessages, endpointInfo, headers, fullUrl, getSettled, setSettled) {
  let buffer = "";
  let accumulatedContent = "";
  let usage = null;

  stream.on("data", (chunk) => {
    const text = chunk.toString();
    if (!res.writableEnded) {
      res.write(text);
    }

    // Parse for logging
    buffer += text;
    const lines = buffer.split("\n");
    buffer = lines.pop() || "";

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed.startsWith("data: ")) continue;
      try {
        const data = JSON.parse(trimmed.slice(6));
        if (data.type === "content_block_delta" && data.delta?.type === "text_delta") {
          accumulatedContent += data.delta.text || "";
        }
        if (data.type === "message_delta" && data.usage) {
          usage = data.usage;
        }
        if (data.type === "message_start" && data.message?.usage) {
          usage = { ...usage, ...data.message.usage };
        }
      } catch {}
    }
  });

  stream.on("end", () => {
    if (getSettled()) return;
    setSettled(true);

    const inputTokens = usage?.input_tokens ?? estimateTokens(openaiMessages);
    const outputTokens = usage?.output_tokens ?? estimateTokens(accumulatedContent);
    const cacheWriteTokens = usage?.cache_creation_input_tokens ?? 0;
    const cacheReadTokens = usage?.cache_read_input_tokens ?? 0;

    logRequestEnd(requestId, true, inputTokens, outputTokens, null, accumulatedContent, apiKey, cacheWriteTokens, cacheReadTokens);

    if (!res.writableEnded) {
      res.end();
    }
  });

  stream.on("error", (error) => {
    if (getSettled()) return;
    setSettled(true);

    if (error && typeof error.message === "string" && /abort/i.test(error.message)) {
      logRequestEnd(requestId, false, 0, 0, error.message);
      if (!res.writableEnded) { try { res.end(); } catch {} }
      return;
    }

    persistUpstreamError({ requestId, modelName, endpointInfo, requestHeaders: headers, upstreamUrl: fullUrl, error });
    logRequestEnd(requestId, false, 0, 0, error.message);
    sendAnthropicStreamError(res, error, 500);
  });
}

// Convert an OpenAI-style SSE stream into Anthropic SSE events
function streamOpenAIToAnthropic(res, stream, requestId, modelName, apiKey, openaiMessages, endpointInfo, headers, fullUrl, apiFormat, getSettled, setSettled) {
  const adapter = getAdapter(apiFormat);
  let buffer = "";
  let accumulatedContent = "";
  let streamUsage = null;
  let sentMessageStart = false;
  let terminated = false;
  let nextBlockIndex = 0;
  let textBlockOpen = false;
  let textBlockIndex = -1;
  const toolBlocks = new Map(); // OpenAI tool_call index -> { index, id, name }
  let lastToolIndex = null;
  const msgId = `msg_${requestId.replace(/-/g, "").slice(0, 20)}`;

  const streamCtx = {
    requestId,
    modelName,
    streamId: `chatcmpl-${requestId}`,
    streamCreated: Math.floor(Date.now() / 1000),
  };

  function ensureMessageStart() {
    if (sentMessageStart) return;
    sentMessageStart = true;
    writeAnthropicEvent(res, "message_start", {
      type: "message_start",
      message: {
        id: msgId,
        type: "message",
        role: "assistant",
        model: modelName,
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: 0, output_tokens: 0 },
      },
    });
  }

  // Open a text content block on demand. Only used for text deltas so a
  // tool_use block is never masked by an empty text block (issue 6).
  function ensureTextBlockStart() {
    if (textBlockOpen) return;
    textBlockIndex = nextBlockIndex++;
    textBlockOpen = true;
    writeAnthropicEvent(res, "content_block_start", {
      type: "content_block_start",
      index: textBlockIndex,
      content_block: { type: "text", text: "" },
    });
  }

  // Close any currently-open content block (text or tool_use).
  function closeOpenBlocks() {
    if (textBlockOpen) {
      writeAnthropicEvent(res, "content_block_stop", {
        type: "content_block_stop",
        index: textBlockIndex,
      });
      textBlockOpen = false;
      textBlockIndex = -1;
    }
    for (const block of toolBlocks.values()) {
      writeAnthropicEvent(res, "content_block_stop", {
        type: "content_block_stop",
        index: block.index,
      });
    }
    toolBlocks.clear();
    lastToolIndex = null;
  }

  // Emit the terminal message_delta + message_stop exactly once (issue 5).
  function emitTerminal(finishReason) {
    if (terminated) return;
    terminated = true;
    closeOpenBlocks();
    const stopReason = finishReason === "length" ? "max_tokens"
      : finishReason === "tool_calls" ? "tool_use"
      : "end_turn";
    writeAnthropicEvent(res, "message_delta", {
      type: "message_delta",
      delta: { stop_reason: stopReason, stop_sequence: null },
      usage: { output_tokens: streamUsage?.completion_tokens ?? estimateTokens(accumulatedContent) },
    });
    writeAnthropicEvent(res, "message_stop", { type: "message_stop" });
  }

  stream.on("data", (chunk) => {
    buffer += chunk.toString();
    const lines = buffer.split("\n");
    buffer = lines.pop() || "";

    for (const line of lines) {
      const trimmed = line.trim();

      if (trimmed.startsWith("event: ")) continue;

      if (!trimmed.startsWith("data: ")) continue;
      const payload = trimmed.slice(6).trim();

      if (adapter.isStreamEnd(payload)) {
        // [DONE] — terminal events are guarded so they fire only once
        // even if a finish_reason chunk already emitted them (issue 5).
        emitTerminal("stop");
        return;
      }

      let chunkData;
      try { chunkData = JSON.parse(payload); } catch { continue; }

      try {
        const parsed = adapter.parseStreamChunk(chunkData, streamCtx);
        if (!parsed) continue;

        ensureMessageStart();

        if (parsed.deltaContent) {
          ensureTextBlockStart();
          accumulatedContent += parsed.deltaContent;
          writeAnthropicEvent(res, "content_block_delta", {
            type: "content_block_delta",
            index: textBlockIndex,
            delta: { type: "text_delta", text: parsed.deltaContent },
          });
        }

        if (parsed.toolCalls) {
          for (const tc of parsed.toolCalls) {
            // Route by OpenAI's tool_call index so parallel tool calls land
            // in distinct content blocks (issue 3). Fall back to the last
            // seen index for argument-only deltas that omit it.
            const tcIndex = tc.index ?? lastToolIndex ?? 0;

            let block = toolBlocks.get(tcIndex);

            // Open a new tool_use block the first time we see this index, or
            // when an id arrives for it. Close any open text block first.
            if (!block && tc.id) {
              if (textBlockOpen) {
                writeAnthropicEvent(res, "content_block_stop", {
                  type: "content_block_stop",
                  index: textBlockIndex,
                });
                textBlockOpen = false;
                textBlockIndex = -1;
              }
              block = { index: nextBlockIndex++, id: tc.id, name: tc.function?.name || "" };
              toolBlocks.set(tcIndex, block);
              writeAnthropicEvent(res, "content_block_start", {
                type: "content_block_start",
                index: block.index,
                content_block: { type: "tool_use", id: block.id, name: block.name, input: {} },
              });
            }

            lastToolIndex = tcIndex;

            // Emit any arguments present in this same chunk — including the
            // first chunk that also carried the id (issue 4).
            if (block && tc.function?.arguments) {
              writeAnthropicEvent(res, "content_block_delta", {
                type: "content_block_delta",
                index: block.index,
                delta: { type: "input_json_delta", partial_json: tc.function.arguments },
              });
            }
          }
        }

        if (parsed.usage) {
          streamUsage = parsed.usage;
        }

        if (parsed.finishReason && parsed.finishReason !== "error") {
          emitTerminal(parsed.finishReason);
        }
      } catch (error) {
        if (getSettled()) return;
        setSettled(true);
        persistUpstreamError({ requestId, modelName, endpointInfo, requestHeaders: headers, upstreamUrl: fullUrl, error, responseBody: chunkData });
        logRequestEnd(requestId, false, 0, 0, error.message);
        sendAnthropicStreamError(res, error, 500);
        stream.destroy();
        return;
      }
    }
  });

  stream.on("end", () => {
    if (getSettled()) return;
    setSettled(true);

    const inputTokens = streamUsage?.prompt_tokens ?? estimateTokens(openaiMessages);
    const outputTokens = streamUsage?.completion_tokens ?? estimateTokens(accumulatedContent);
    const cacheWriteTokens = streamUsage?.prompt_tokens_details?.cache_creation_input_tokens
      ?? streamUsage?.prompt_tokens_details?.cache_write_tokens ?? 0;
    const cacheReadTokens = streamUsage?.prompt_tokens_details?.cached_tokens
      ?? streamUsage?.prompt_tokens_details?.cache_read_tokens ?? 0;

    logRequestEnd(requestId, true, inputTokens, outputTokens, null, accumulatedContent, apiKey, cacheWriteTokens, cacheReadTokens);

    if (!res.writableEnded) {
      res.end();
    }
  });

  stream.on("error", (error) => {
    if (getSettled()) return;
    setSettled(true);

    if (error && typeof error.message === "string" && /abort/i.test(error.message)) {
      logRequestEnd(requestId, false, 0, 0, error.message);
      if (!res.writableEnded) { try { res.end(); } catch {} }
      stream.destroy();
      return;
    }

    persistUpstreamError({ requestId, modelName, endpointInfo, requestHeaders: headers, upstreamUrl: fullUrl, error });
    logRequestEnd(requestId, false, 0, 0, error.message);
    sendAnthropicStreamError(res, error, 500);
  });
}

export default router;
