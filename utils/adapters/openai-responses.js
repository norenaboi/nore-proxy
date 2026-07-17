/**
 * OpenAI Responses Adapter — transforms OpenAI Chat Completions requests to
 * OpenAI's /v1/responses format and normalizes responses back to Chat
 * Completions shape.
 *
 * Responses API reference:
 *   POST /v1/responses
 *   Auth: Authorization: Bearer (same as Chat Completions)
 *   Body: { model, input, instructions, max_output_tokens, temperature, top_p, tools, tool_choice, stream, store }
 *   Streaming: SSE with typed events: response.output_text.delta,
 *     response.output_item.added, response.function_call_arguments.delta,
 *     response.completed, response.incomplete, response.failed
 *
 * Key differences from Chat Completions:
 *   - messages[] becomes input[] items; system prompts hoist to `instructions`
 *   - max_tokens is called max_output_tokens
 *   - Content parts use input_text / output_text / input_image types
 *   - Tools are flat: { type: "function", name, description, parameters }
 *   - Tool calls / results are input items: function_call / function_call_output
 *   - Usage shape: { input_tokens, output_tokens, input_tokens_details: { cached_tokens },
 *     output_tokens_details: { reasoning_tokens } }
 *   - Streaming has no "[DONE]" sentinel; response.completed carries final usage
 */

// ---------------------------------------------------------------------------
// Request transformation
// ---------------------------------------------------------------------------

/**
 * Transform an OpenAI Chat Completions request into a Responses API body.
 */
export function transformRequest(openaiReq, actualModel) {
  return buildResponsesBody(openaiReq, actualModel, false);
}

/**
 * Transform for streaming.
 */
export function transformStreamRequest(openaiReq, actualModel) {
  return buildResponsesBody(openaiReq, actualModel, true);
}

function buildResponsesBody(openaiReq, actualModel, isStream) {
  const { instructions, input } = convertMessages(openaiReq.messages || []);

  const body = {
    model: actualModel,
    input,
    // The proxy is stateless — never persist responses upstream.
    store: false,
  };

  if (isStream) {
    body.stream = true;
  }

  if (instructions) {
    body.instructions = instructions;
  }

  // max_completion_tokens (newer Chat Completions name) wins over max_tokens
  const maxTokens = openaiReq.max_completion_tokens ?? openaiReq.max_tokens;
  if (maxTokens !== undefined && maxTokens !== null) {
    body.max_output_tokens = maxTokens;
  }

  if (openaiReq.temperature !== undefined && openaiReq.temperature !== null) {
    body.temperature = openaiReq.temperature;
  }
  if (openaiReq.top_p !== undefined && openaiReq.top_p !== null) {
    body.top_p = openaiReq.top_p;
  }

  // Reasoning effort (o-series / gpt-5 style) maps to reasoning.effort
  if (openaiReq.reasoning_effort) {
    body.reasoning = { effort: openaiReq.reasoning_effort };
  }

  // Tool support: Chat Completions nests under `function`, Responses is flat
  if (openaiReq.tools && openaiReq.tools.length > 0) {
    body.tools = openaiReq.tools
      .filter((t) => t.type === "function" && t.function)
      .map((t) => ({
        type: "function",
        name: t.function.name,
        description: t.function.description,
        parameters: t.function.parameters,
      }));
  }

  if (openaiReq.tool_choice) {
    if (typeof openaiReq.tool_choice === "string") {
      // "auto" | "none" | "required" are shared between both APIs
      body.tool_choice = openaiReq.tool_choice;
    } else if (openaiReq.tool_choice?.function?.name) {
      body.tool_choice = {
        type: "function",
        name: openaiReq.tool_choice.function.name,
      };
    }
  }

  return body;
}

/**
 * Convert Chat Completions messages[] into { instructions, input }.
 * System/developer messages hoist into `instructions`; everything else
 * becomes typed input items.
 */
function convertMessages(messages) {
  let instructions = null;
  const input = [];

  for (const msg of messages) {
    if (msg.role === "system" || msg.role === "developer") {
      const text = contentToText(msg.content);
      instructions = instructions ? instructions + "\n" + text : text;
      continue;
    }

    // Tool results become function_call_output items
    if (msg.role === "tool") {
      input.push({
        type: "function_call_output",
        call_id: msg.tool_call_id,
        output: contentToText(msg.content),
      });
      continue;
    }

    if (msg.role === "assistant") {
      // Assistant text (if any) becomes an output message item
      const text = contentToText(msg.content);
      if (text) {
        input.push({
          type: "message",
          role: "assistant",
          content: [{ type: "output_text", text }],
        });
      }
      // Prior tool calls become function_call items
      for (const tc of msg.tool_calls || []) {
        if (tc.type !== "function" || !tc.function) continue;
        input.push({
          type: "function_call",
          call_id: tc.id,
          name: tc.function.name,
          arguments: tc.function.arguments || "{}",
        });
      }
      continue;
    }

    // User message — content can be a string or an array of content parts
    input.push({
      type: "message",
      role: "user",
      content: convertUserContent(msg.content),
    });
  }

  return { instructions, input };
}

function convertUserContent(content) {
  if (typeof content === "string") {
    return [{ type: "input_text", text: content }];
  }
  if (Array.isArray(content)) {
    return content
      .map((block) => {
        if (block.type === "text") {
          return { type: "input_text", text: block.text };
        }
        if (block.type === "image_url") {
          return {
            type: "input_image",
            image_url: block.image_url?.url || "",
          };
        }
        // Drop unknown block types (e.g. anthropic cache_control blocks)
        return null;
      })
      .filter(Boolean);
  }
  return [{ type: "input_text", text: "" }];
}

/** Flatten string-or-blocks content into plain text. */
function contentToText(content) {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((b) => (typeof b === "string" ? b : b.text || ""))
      .join("");
  }
  return "";
}

// ---------------------------------------------------------------------------
// Response parsing (non-streaming)
// ---------------------------------------------------------------------------

/**
 * Parse a non-streaming Responses API response into OpenAI Chat shape.
 * Responses shape:
 *   { id, object: "response", status, output: [ { type: "message"|"function_call"|"reasoning", ... } ],
 *     usage, incomplete_details }
 */
export function parseResponseData(rawData) {
  const output = rawData.output || [];

  let text = "";
  let reasoning = "";
  const toolCalls = [];

  for (const item of output) {
    if (item.type === "message") {
      for (const part of item.content || []) {
        if (part.type === "output_text") text += part.text || "";
      }
    } else if (item.type === "function_call") {
      toolCalls.push({
        id: item.call_id || item.id,
        type: "function",
        function: {
          name: item.name,
          arguments: item.arguments || "{}",
        },
      });
    } else if (item.type === "reasoning") {
      for (const part of item.summary || []) {
        if (part.text) reasoning += part.text;
      }
    }
  }

  const usage = responsesUsageToOpenAI(rawData.usage);
  const finishReason = mapFinishReason(rawData, toolCalls.length > 0);

  const message = { role: "assistant", content: text };
  if (reasoning) message.reasoning_content = reasoning;
  if (toolCalls.length > 0) message.tool_calls = toolCalls;

  const openaiResponse = {
    id: rawData.id || `chatcmpl-${Date.now()}`,
    object: "chat.completion",
    created: rawData.created_at || Math.floor(Date.now() / 1000),
    model: rawData.model || "",
    choices: [{
      index: 0,
      message,
      finish_reason: finishReason,
    }],
    ...(usage ? { usage } : {}),
  };

  return { content: text, usage, response: openaiResponse };
}

// ---------------------------------------------------------------------------
// Streaming — Responses API uses typed SSE events
// ---------------------------------------------------------------------------

/**
 * Responses streaming sends events like:
 *   event: response.output_text.delta
 *   data: { type: "response.output_text.delta", output_index, delta: "..." }
 *
 *   event: response.output_item.added
 *   data: { type: "response.output_item.added", output_index, item: { type: "function_call", ... } }
 *
 *   event: response.function_call_arguments.delta
 *   data: { type: "response.function_call_arguments.delta", output_index, delta: "..." }
 *
 *   event: response.completed
 *   data: { type: "response.completed", response: { status, usage, output } }
 *
 * The caller passes us the parsed JSON data object; the `type` field is the
 * source of truth. Returns { deltaContent, deltaReasoning, finishReason,
 * usage, toolCalls } or null.
 */
export function parseStreamChunk(rawChunk, ctx) {
  if (!rawChunk || typeof rawChunk !== "object") return null;

  switch (rawChunk.type) {
    case "response.output_text.delta": {
      return {
        deltaContent: rawChunk.delta || null,
        deltaReasoning: null,
        finishReason: null,
        usage: null,
        toolCalls: null,
      };
    }

    case "response.reasoning_summary_text.delta":
    case "response.reasoning_text.delta": {
      return {
        deltaContent: null,
        deltaReasoning: rawChunk.delta || null,
        finishReason: null,
        usage: null,
        toolCalls: null,
      };
    }

    case "response.output_item.added": {
      const item = rawChunk.item;
      if (item?.type === "function_call") {
        return {
          deltaContent: null,
          deltaReasoning: null,
          finishReason: null,
          usage: null,
          toolCalls: [{
            index: toolCallIndex(ctx, rawChunk.output_index),
            id: item.call_id || item.id,
            type: "function",
            function: { name: item.name, arguments: "" },
          }],
        };
      }
      return null;
    }

    case "response.function_call_arguments.delta": {
      return {
        deltaContent: null,
        deltaReasoning: null,
        finishReason: null,
        usage: null,
        toolCalls: [{
          index: toolCallIndex(ctx, rawChunk.output_index),
          function: { arguments: rawChunk.delta || "" },
        }],
      };
    }

    case "response.completed":
    case "response.incomplete": {
      const response = rawChunk.response || {};
      const hasToolCalls =
        (response.output || []).some((item) => item.type === "function_call");
      return {
        deltaContent: null,
        deltaReasoning: null,
        finishReason: mapFinishReason(response, hasToolCalls),
        usage: responsesUsageToOpenAI(response.usage),
        toolCalls: null,
      };
    }

    case "response.failed": {
      const upstreamError = rawChunk.response?.error || {};
      const message = upstreamError.message || "Responses API stream failed";
      const error = new Error(message);
      error.name = "UpstreamStreamError";
      // The Responses API surfaces failures mid-stream (after a 200) as a typed
      // event whose reason lives in error.code as a string (e.g.
      // "rate_limit_exceeded"). Recover an HTTP status so callers can log it and
      // sideline the key just like an HTTP-level failure.
      error.code = upstreamError.code ?? null;
      error.statusCode = responsesErrorStatus(upstreamError.code);
      throw error;
    }

    default:
      // Lifecycle noise (response.created, content_part events, done markers)
      return null;
  }
}

/**
 * Map a Responses API error `code` string to the HTTP status the proxy uses for
 * key health. Only the actionable codes (401/402/403/429) need exact mapping;
 * anything else falls back to 500 so it is logged but never sidelines a key.
 */
function responsesErrorStatus(code) {
  switch (code) {
    case "rate_limit_exceeded":
    case "tokens_exceeded":
    case "requests_exceeded":
    case "insufficient_quota":
      return 429;
    case "billing_hard_limit_reached":
    case "billing_not_active":
      return 402;
    case "invalid_api_key":
    case "authentication_error":
      return 401;
    case "permission_denied":
    case "access_terminated":
      return 403;
    default:
      return 500;
  }
}

/**
 * Build an OpenAI-compatible SSE chunk from Responses event data.
 */
export function buildStreamChunk(rawChunk, ctx) {
  const parsed = parseStreamChunk(rawChunk, ctx);
  if (!parsed) return null;

  // Skip chunks with no useful content
  if (
    !parsed.deltaContent &&
    !parsed.deltaReasoning &&
    !parsed.finishReason &&
    !parsed.usage &&
    !parsed.toolCalls
  ) {
    return null;
  }

  const delta = {};
  if (parsed.deltaContent) delta.content = parsed.deltaContent;
  if (parsed.deltaReasoning) delta.reasoning_content = parsed.deltaReasoning;
  if (parsed.toolCalls) delta.tool_calls = parsed.toolCalls;

  const choice = {
    index: 0,
    delta,
    finish_reason: parsed.finishReason || null,
  };

  return {
    id: ctx.streamId,
    object: "chat.completion.chunk",
    created: ctx.streamCreated,
    model: ctx.modelName,
    choices: [choice],
    ...(parsed.usage ? { usage: parsed.usage } : {}),
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Map a Responses output_index to a sequential Chat Completions tool_calls
 * index. Text/reasoning items share the output array with function calls, so
 * output_index alone would leave gaps. State lives on the per-request ctx and
 * the mapping is idempotent (the caller may parse the same chunk twice).
 */
function toolCallIndex(ctx, outputIndex) {
  if (!ctx._respToolIndexMap) ctx._respToolIndexMap = new Map();
  const map = ctx._respToolIndexMap;
  const key = outputIndex ?? 0;
  if (!map.has(key)) map.set(key, map.size);
  return map.get(key);
}

function mapFinishReason(response, hasToolCalls) {
  if (
    response?.status === "incomplete" &&
    response?.incomplete_details?.reason === "max_output_tokens"
  ) {
    return "length";
  }
  return hasToolCalls ? "tool_calls" : "stop";
}

function responsesUsageToOpenAI(usage) {
  if (!usage) return null;

  return {
    prompt_tokens: usage.input_tokens ?? 0,
    completion_tokens: usage.output_tokens ?? 0,
    total_tokens:
      usage.total_tokens ??
      (usage.input_tokens ?? 0) + (usage.output_tokens ?? 0),
    prompt_tokens_details: {
      // The Responses API has no cache-write concept — reads only.
      cache_creation_input_tokens: 0,
      cached_tokens: usage.input_tokens_details?.cached_tokens ?? 0,
    },
    completion_tokens_details: {
      reasoning_tokens: usage.output_tokens_details?.reasoning_tokens ?? 0,
    },
  };
}

// ---------------------------------------------------------------------------
// Stream lifecycle
// ---------------------------------------------------------------------------

/**
 * The Responses API has no "[DONE]" sentinel — the stream ends after
 * response.completed. Check defensively anyway for OpenAI-compatible
 * gateways that append one.
 */
export function isStreamEnd(payload) {
  return payload === "[DONE]";
}
