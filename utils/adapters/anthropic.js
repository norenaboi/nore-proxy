/**
 * Anthropic Adapter — transforms OpenAI Chat Completions requests to
 * Anthropic's /v1/messages format and normalizes responses back to OpenAI shape.
 *
 * Anthropic API reference:
 *   POST /v1/messages
 *   Auth: x-api-key header (not Bearer)
 *   Body: { model, messages, max_tokens, system, temperature, top_p, tools, tool_choice }
 *   Streaming: SSE with event types: message_start, content_block_delta, message_delta, message_stop
 *
 * Key differences from OpenAI:
 *   - System prompt is a top-level `system` field, not a message in messages[]
 *   - Messages only contain "user" and "assistant" roles (no "system")
 *   - max_tokens is REQUIRED (not optional)
 *   - Content can be string or array of content blocks
 *   - Auth uses x-api-key header + anthropic-version header
 *   - Streaming uses typed SSE events, not generic data: lines
 *   - Usage shape: { input_tokens, output_tokens, cache_creation_input_tokens, cache_read_input_tokens }
 */

// ---------------------------------------------------------------------------
// Request transformation
// ---------------------------------------------------------------------------

/**
 * Transform an OpenAI Chat Completions request into an Anthropic messages body.
 */
export function transformRequest(openaiReq, actualModel) {
  return buildAnthropicBody(openaiReq, actualModel, false);
}

/**
 * Transform for streaming.
 */
export function transformStreamRequest(openaiReq, actualModel) {
  return buildAnthropicBody(openaiReq, actualModel, true);
}

function buildAnthropicBody(openaiReq, actualModel, isStream) {
  const messages = openaiReq.messages || [];
  const anthropicMessages = [];
  let systemPrompt = null;

  for (const msg of messages) {
    if (msg.role === "system") {
      // System prompt is hoisted to the top-level system field
      const text = typeof msg.content === "string"
        ? msg.content
        : (Array.isArray(msg.content)
          ? msg.content.map(b => b.text || "").join("\n")
          : "");
      systemPrompt = systemPrompt ? systemPrompt + "\n" + text : text;
      continue;
    }

    // OpenAI tool result message → Anthropic tool_result block in a user
    // message. Results from parallel tool calls arrive as consecutive tool
    // messages; Anthropic expects them as blocks in a single user message.
    if (msg.role === "tool") {
      const block = {
        type: "tool_result",
        tool_use_id: msg.tool_call_id,
        content: toToolResultContent(msg.content),
      };
      const prev = anthropicMessages[anthropicMessages.length - 1];
      if (
        prev?.role === "user" &&
        Array.isArray(prev.content) &&
        prev.content.some(b => b.type === "tool_result")
      ) {
        prev.content.push(block);
      } else {
        anthropicMessages.push({ role: "user", content: [block] });
      }
      continue;
    }

    const role = msg.role === "assistant" ? "assistant" : "user";

    // Content can be a string or an array of content blocks
    let content = msg.content;
    if (typeof content === "string") {
      content = content; // Anthropic accepts string content directly
    } else if (Array.isArray(content)) {
      // OpenAI content blocks → Anthropic content blocks
      // OpenAI: { type: "text", text: "..." }
      // Anthropic: { type: "text", text: "..." }
      // Image: OpenAI { type: "image_url", image_url: { url } } → Anthropic { type: "image", source: {...} }
      content = content.map(block => {
        if (block.type === "text") {
          return { type: "text", text: block.text };
        }
        if (block.type === "image_url") {
          const url = block.image_url?.url || "";
          const match = url.match(/^data:(image\/\w+);base64,(.*)$/);
          if (match) {
            return {
              type: "image",
              source: {
                type: "base64",
                media_type: match[1],
                data: match[2],
              },
            };
          }
          return null;
        }
        // Pass through already-Anthropic-shaped blocks (e.g. cache_control blocks)
        return block;
      }).filter(Boolean);
    }

    // Assistant tool calls → tool_use blocks, appended after any text content
    if (role === "assistant" && Array.isArray(msg.tool_calls) && msg.tool_calls.length > 0) {
      const blocks = typeof content === "string"
        ? (content ? [{ type: "text", text: content }] : [])
        : (Array.isArray(content) ? content : []);
      for (const tc of msg.tool_calls) {
        if (tc.type !== "function" || !tc.function) continue;
        blocks.push({
          type: "tool_use",
          id: tc.id,
          name: tc.function.name,
          input: parseToolArguments(tc.function.arguments),
        });
      }
      content = blocks;
    } else if (content == null) {
      // Anthropic rejects null content; a message with no content and no
      // tool calls carries nothing — drop it
      continue;
    }

    anthropicMessages.push({ role, content });
  }

  const body = {
    model: actualModel,
    messages: anthropicMessages,
  };

  if (openaiReq.max_tokens !== undefined) {
    body.max_tokens = openaiReq.max_tokens;
  }

  if (isStream) {
    body.stream = true;
  }

  if (systemPrompt) {
    body.system = systemPrompt;
  }

  if (openaiReq.temperature !== undefined) {
    body.temperature = openaiReq.temperature;
  }
  if (openaiReq.top_p !== undefined) {
    body.top_p = openaiReq.top_p;
  }

  // Tool support
  if (openaiReq.tools && openaiReq.tools.length > 0) {
    body.tools = openaiReq.tools
      .filter(t => t.type === "function" && t.function)
      .map(t => ({
        name: t.function.name,
        description: t.function.description,
        input_schema: t.function.parameters,
      }));
  }

  if (openaiReq.tool_choice) {
    if (typeof openaiReq.tool_choice === "string") {
      // OpenAI: "auto" / "none" / "required" → Anthropic: auto / none / any
      const choiceMap = { auto: "auto", none: "none", required: "any", any: "any" };
      body.tool_choice = { type: choiceMap[openaiReq.tool_choice] || "auto" };
    } else if (openaiReq.tool_choice?.function?.name) {
      body.tool_choice = {
        type: "tool",
        name: openaiReq.tool_choice.function.name,
      };
    }
  }

  return body;
}

/**
 * OpenAI tool call arguments are a JSON string; Anthropic wants the object.
 */
function parseToolArguments(args) {
  if (args == null) return {};
  if (typeof args === "object") return args;
  try {
    return JSON.parse(args);
  } catch {
    return {};
  }
}

/**
 * OpenAI tool message content (string or content blocks) → tool_result content.
 */
function toToolResultContent(content) {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map(b => (b.type === "text" ? { type: "text", text: b.text } : b))
      .filter(Boolean);
  }
  return content == null ? "" : String(content);
}

/**
 * Return extra headers that Anthropic requires.
 * The caller merges these with customHeaders before sending.
 */
export function getExtraHeaders() {
  return {
    "anthropic-version": "2023-06-01",
  };
}

// ---------------------------------------------------------------------------
// Response / chunk parsing (non-streaming)
// ---------------------------------------------------------------------------

/**
 * Parse a non-streaming Anthropic response into OpenAI shape.
 * Anthropic response:
 *   { id, type: "message", role: "assistant", content: [{type:"text",text:"..."}], model, stop_reason, usage }
 */
export function parseResponseData(rawData) {
  const contentBlocks = rawData.content || [];
  const text = contentBlocks
    .filter(b => b.type === "text")
    .map(b => b.text)
    .join("");
  const reasoning = contentBlocks
    .filter(b => b.type === "thinking")
    .map(b => b.thinking || "")
    .join("");

  // Extract tool calls
  const toolUseBlocks = contentBlocks.filter(b => b.type === "tool_use");
  const toolCalls = toolUseBlocks.length > 0
    ? toolUseBlocks.map((b, i) => ({
        id: b.id,
        type: "function",
        function: {
          name: b.name,
          arguments: JSON.stringify(b.input || {}),
        },
      }))
    : null;

  const usage = anthropicUsageToOpenAI(rawData.usage);
  const finishReason = mapFinishReason(rawData.stop_reason);

  const message = { role: "assistant", content: text };
  if (reasoning) message.reasoning_content = reasoning;
  if (toolCalls) message.tool_calls = toolCalls;

  const openaiResponse = {
    id: rawData.id || `chatcmpl-${Date.now()}`,
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model: rawData.model || "",
    choices: [{
      index: 0,
      message,
      finish_reason: finishReason,
    }],
    usage,
  };

  return { content: text, usage, response: openaiResponse };
}

// ---------------------------------------------------------------------------
// Streaming — Anthropic uses typed SSE events
// ---------------------------------------------------------------------------

/**
 * Anthropic streaming sends events like:
 *   event: message_start
 *   data: { type: "message_start", message: {...} }
 *
 *   event: content_block_start
 *   data: { type: "content_block_start", index: 0, content_block: {...} }
 *
 *   event: content_block_delta
 *   data: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "..." } }
 *
 *   event: content_block_stop
 *   data: { type: "content_block_stop", index: 0 }
 *
 *   event: message_delta
 *   data: { type: "message_delta", delta: {...}, usage: {...} }
 *
 *   event: message_stop
 *   data: { type: "message_stop" }
 *
 * The caller passes us the parsed JSON data object (without the event: line).
 * We return an OpenAI-compatible delta or null.
 */

// State for tracking tool use blocks across deltas
// Each content_block_start for a tool_use sets up the block; we emit
// the tool call delta when we see it.

/**
 * Parse an Anthropic SSE data payload into OpenAI delta content.
 * The caller must handle the "event:" line to know what type of event it is,
 * but we also inspect the data payload's `type` field as the source of truth.
 *
 * Returns { deltaContent, finishReason, usage, toolCalls } or null.
 */
export function parseStreamChunk(rawChunk, ctx) {
  if (!rawChunk || typeof rawChunk !== "object") return null;
  const state = getStreamState(ctx);

  switch (rawChunk.type) {
    case "message_start": {
      // Initial message — may carry input usage
      const usage = rawChunk.message?.usage
        ? anthropicUsageToOpenAI(rawChunk.message.usage)
        : null;
      return { deltaContent: null, finishReason: null, usage, toolCalls: null };
    }

    case "content_block_delta": {
      const delta = rawChunk.delta;
      if (delta?.type === "text_delta") {
        return {
          deltaContent: delta.text || null,
          deltaReasoning: null,
          finishReason: null,
          usage: null,
          toolCalls: null,
        };
      }
      if (delta?.type === "thinking_delta") {
        return {
          deltaContent: null,
          deltaReasoning: delta.thinking || null,
          finishReason: null,
          usage: null,
          toolCalls: null,
        };
      }
      if (delta?.type === "input_json_delta") {
        // Partial tool call arguments — forward as tool_calls delta, using
        // the sequential tool index assigned at content_block_start
        return {
          deltaContent: null,
          finishReason: null,
          usage: null,
          toolCalls: [{
            index: state.toolIndexMap[rawChunk.index] ?? 0,
            function: { arguments: delta.partial_json || "" },
          }],
        };
      }
      return null;
    }

    case "content_block_start": {
      const block = rawChunk.content_block;
      if (block?.type === "tool_use") {
        // Anthropic's index counts all content blocks (text/thinking too);
        // OpenAI clients expect tool call indices to be sequential from 0.
        // Idempotent: parseStreamChunk may run twice on the same chunk.
        let toolIndex = state.toolIndexMap[rawChunk.index];
        if (toolIndex === undefined) {
          toolIndex = state.nextToolIndex++;
          state.toolIndexMap[rawChunk.index] = toolIndex;
        }
        return {
          deltaContent: null,
          finishReason: null,
          usage: null,
          toolCalls: [{
            index: toolIndex,
            id: block.id,
            type: "function",
            function: {
              name: block.name,
              arguments: "",
            },
          }],
        };
      }
      return null;
    }

    case "message_delta": {
      const finishReason = mapFinishReason(rawChunk.delta?.stop_reason);
      if (finishReason) state.finishSent = true;
      const usage = rawChunk.usage
        ? anthropicUsageToOpenAI(rawChunk.usage)
        : null;
      return {
        deltaContent: null,
        finishReason,
        usage,
        toolCalls: null,
      };
    }

    case "message_stop": {
      // message_delta already carried the real finish reason (e.g.
      // "tool_calls"); emitting a second "stop" here would make clients
      // treat a tool-call turn as a normal completion.
      return {
        deltaContent: null,
        finishReason: state.finishSent ? null : "stop",
        usage: null,
        toolCalls: null,
      };
    }

    default:
      return null;
  }
}

/**
 * Build an OpenAI-compatible SSE chunk from Anthropic event data.
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
 * Per-stream adapter state, kept on the caller's streamCtx (one per request).
 * Tracks the Anthropic block index → sequential tool call index mapping and
 * whether a finish reason has already been emitted.
 */
function getStreamState(ctx) {
  if (!ctx) return { toolIndexMap: {}, nextToolIndex: 0, finishSent: false };
  if (!ctx._anthropicState) {
    ctx._anthropicState = { toolIndexMap: {}, nextToolIndex: 0, finishSent: false };
  }
  return ctx._anthropicState;
}

function mapFinishReason(reason) {
  switch (reason) {
    case "end_turn":
      return "stop";
    case "max_tokens":
      return "length";
    case "tool_use":
      return "tool_calls";
    case "stop_sequence":
      return "stop";
    default:
      return reason || null;
  }
}

function anthropicUsageToOpenAI(usage) {
  if (!usage) return null;

  return {
    prompt_tokens: usage.input_tokens ?? 0,
    completion_tokens: usage.output_tokens ?? 0,
    total_tokens: (usage.input_tokens ?? 0) + (usage.output_tokens ?? 0),
    prompt_tokens_details: {
      cache_creation_input_tokens: usage.cache_creation_input_tokens ?? 0,
      cached_tokens: usage.cache_read_input_tokens ?? 0,
    },
  };
}

// ---------------------------------------------------------------------------
// Stream lifecycle
// ---------------------------------------------------------------------------

/**
 * Anthropic sends a "message_stop" event, not a "[DONE]" string.
 * We rely on the event type, so this is false for the payload check.
 */
export function isStreamEnd(payload) {
  return false;
}



