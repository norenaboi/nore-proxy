/**
 * Gemini Adapter — transforms OpenAI Chat Completions requests to Google
 * Gemini's generateContent / streamGenerateContent format and normalizes
 * the responses back to OpenAI shape.
 *
 * Gemini API reference:
 *   POST /v1beta/models/{model}:generateContent?key=API_KEY
 *   POST /v1beta/models/{model}:streamGenerateContent?key=API_KEY&alt=sse
 *
 * Key differences from OpenAI:
 *   - Body has { contents: [...], systemInstruction, generationConfig, tools }
 *   - Messages use role "user" / "model" (not "assistant")
 *   - Content is an array of { text: "..." } parts, not a string
 *   - Generation params go in generationConfig: { temperature, topP, maxOutputTokens }
 *   - Auth is via ?key= query parameter, not Bearer token (handled in chat.js)
 *   - Streaming uses SSE with data: lines containing Gemini-format chunks
 */

// ---------------------------------------------------------------------------
// Request transformation
// ---------------------------------------------------------------------------

/**
 * Convert an OpenAI role to a Gemini role.
 * Gemini only accepts "user", "model", and "function".
 */
function mapRole(role) {
  switch (role) {
    case "assistant":
      return "model";
    case "system":
      return null; // system messages are extracted separately, not in contents
    case "tool":
      return "function";
    default:
      return role || "user";
  }
}

/**
 * Convert an OpenAI message content (string or array of content blocks)
 * into Gemini's parts array format.
 */
function contentToParts(content) {
  if (typeof content === "string") {
    return [{ text: content }];
  }

  if (Array.isArray(content)) {
    return content.map((block) => {
      if (block.type === "text") {
        return { text: block.text };
      }
      if (block.type === "image_url") {
        // Gemini expects inline_data: { mime_type, data }
        const url = block.image_url?.url || "";
        const match = url.match(/^data:(image\/\w+);base64,(.*)$/);
        if (match) {
          return {
            inline_data: {
              mime_type: match[1],
              data: match[2],
            },
          };
        }
        return null;
      }
      return null;
    }).filter(Boolean);
  }

  return [];
}

/**
 * Transform an OpenAI Chat Completions request into a Gemini generateContent body.
 */
export function transformRequest(openaiReq, actualModel) {
  return buildGeminiBody(openaiReq, false);
}

/**
 * Transform for streaming — same body, streaming is controlled by the URL
 * (streamGenerateContent endpoint) not a body flag, but we keep the same interface.
 */
export function transformStreamRequest(openaiReq, actualModel) {
  return buildGeminiBody(openaiReq, true);
}

function buildGeminiBody(openaiReq, isStream) {
  const messages = openaiReq.messages || [];
  const contents = [];
  let systemInstruction = null;

  for (const msg of messages) {
    if (msg.role === "system") {
      // Gemini handles system prompts via systemInstruction, not in contents.
      // If multiple system messages, concatenate them.
      const text = typeof msg.content === "string"
        ? msg.content
        : (Array.isArray(msg.content) ? msg.content.map(b => b.text || "").join("\n") : "");
      systemInstruction = systemInstruction
        ? { parts: [...systemInstruction.parts, { text }] }
        : { parts: [{ text }] };
      continue;
    }

    const role = mapRole(msg.role);
    if (!role) continue;

    const parts = contentToParts(msg.content);
    if (parts.length === 0) continue;

    contents.push({ role, parts });
  }

  // Build generationConfig — only include fields that are set
  const generationConfig = {};
  if (openaiReq.max_tokens !== undefined && openaiReq.max_tokens > 0)
    generationConfig.maxOutputTokens = openaiReq.max_tokens;
  if (openaiReq.temperature !== undefined) generationConfig.temperature = openaiReq.temperature;
  if (openaiReq.top_p !== undefined) generationConfig.topP = openaiReq.top_p;

  // Request thought summaries from Gemini thinking models.
  // The API silently ignores this for non-thinking models, so it's safe
  // to always include. Without it, thinking models think internally but
  // never surface the thoughts — so reasoning_content never reaches the
  // client (SillyTavern / OpenAI-compatible consumers).
  generationConfig.thinkingConfig = { includeThoughts: true };

  const body = {
    contents,
    generationConfig,
  };

  if (systemInstruction) {
    body.systemInstruction = systemInstruction;
  }

  // Tool support — OpenAI function calling → Gemini function declarations
  if (openaiReq.tools && openaiReq.tools.length > 0) {
    body.tools = [{
      functionDeclarations: openaiReq.tools
        .filter(t => t.type === "function" && t.function)
        .map(t => ({
          name: t.function.name,
          description: t.function.description,
          parameters: t.function.parameters,
        })),
    }];
  }

  if (openaiReq.tool_choice) {
    // OpenAI "auto" / "none" / specific function
    if (typeof openaiReq.tool_choice === "string") {
      body.toolConfig = {
        functionCallingConfig: {
          mode: openaiReq.tool_choice === "none" ? "NONE" : "AUTO",
        },
      };
    } else if (openaiReq.tool_choice?.function?.name) {
      body.toolConfig = {
        functionCallingConfig: {
          mode: "ANY",
          allowedFunctionNames: [openaiReq.tool_choice.function.name],
        },
      };
    }
  }

  return body;
}

// ---------------------------------------------------------------------------
// Response / chunk parsing
// ---------------------------------------------------------------------------

/**
 * Extract text from a Gemini candidates response structure.
 * Gemini puts text in candidates[0].content.parts[].text
 * Parts with `thought: true` are reasoning and are returned separately.
 * Returns { content, reasoning }.
 */
function extractGeminiContent(data) {
  const candidate = data?.candidates?.[0];
  if (!candidate) return { content: "", reasoning: "" };

  const parts = candidate.content?.parts || [];
  let content = "";
  let reasoning = "";
  for (const p of parts) {
    const text = p.text || "";
    if (!text) continue;
    if (p.thought === true) {
      reasoning += text;
    } else {
      content += text;
    }
  }
  return { content, reasoning };
}

/**
 * Extract function call parts from a Gemini response.
 */
function extractGeminiToolCalls(data) {
  const candidate = data?.candidates?.[0];
  if (!candidate) return null;

  const parts = candidate.content?.parts || [];
  const toolCalls = parts
    .filter(p => p.functionCall)
    .map((p, i) => ({
      id: `call_${i}`,
      type: "function",
      function: {
        name: p.functionCall.name,
        arguments: JSON.stringify(p.functionCall.args || {}),
      },
    }));

  return toolCalls.length > 0 ? toolCalls : null;
}

/**
 * Map Gemini finishReason to OpenAI finish_reason.
 */
function mapFinishReason(reason) {
  switch (reason) {
    case "STOP":
      return "stop";
    case "MAX_TOKENS":
      return "length";
    case "SAFETY":
    case "RECITATION":
      return "content_filter";
    default:
      return reason || null;
  }
}

/**
 * Parse a single Gemini SSE chunk into OpenAI delta content.
 * Returns { deltaContent, deltaReasoning, finishReason, usage, toolCalls } or null.
 *
 * Gemini thinking models tag reasoning parts with `thought: true`.
 * We separate those from regular content so downstream clients that
 * recognise `reasoning_content` (OpenAI o1/o3-style) can display thinking.
 */
export function parseStreamChunk(rawChunk, ctx) {
  if (!rawChunk || !rawChunk.candidates || rawChunk.candidates.length === 0) {
    // Could be a usage-only chunk at the end
    if (rawChunk?.usageMetadata) {
      return {
        deltaContent: null,
        deltaReasoning: null,
        finishReason: null,
        usage: geminiUsageToOpenAI(rawChunk.usageMetadata),
        toolCalls: null,
      };
    }
    return null;
  }

  const candidate = rawChunk.candidates[0];
  const parts = candidate.content?.parts || [];

  // Separate thinking parts from regular content / tool-call parts
  let text = "";
  let reasoning = "";
  let toolCalls = [];
  for (const part of parts) {
    if (part.thought === true) {
      if (part.text) reasoning += part.text;
      continue; // don't mix thinking into regular content
    }
    if (part.text) text += part.text;
    if (part.functionCall) {
      toolCalls.push({
        index: toolCalls.length,
        id: `call_${toolCalls.length}`,
        type: "function",
        function: {
          name: part.functionCall.name,
          arguments: JSON.stringify(part.functionCall.args || {}),
        },
      });
    }
  }

  const usage = rawChunk.usageMetadata
    ? geminiUsageToOpenAI(rawChunk.usageMetadata)
    : null;

  return {
    deltaContent: text || null,
    deltaReasoning: reasoning || null,
    finishReason: mapFinishReason(candidate.finishReason),
    usage,
    toolCalls: toolCalls.length > 0 ? toolCalls : null,
  };
}

/**
 * Build an OpenAI-compatible SSE chunk from a Gemini chunk.
 */
export function buildStreamChunk(rawChunk, ctx) {
  const parsed = parseStreamChunk(rawChunk, ctx);
  if (!parsed) return null;

  const delta = {};
  if (parsed.deltaContent) delta.content = parsed.deltaContent;
  if (parsed.deltaReasoning) delta.reasoning_content = parsed.deltaReasoning;
  if (parsed.toolCalls) delta.tool_calls = parsed.toolCalls;

  return {
    id: ctx.streamId,
    object: "chat.completion.chunk",
    created: ctx.streamCreated,
    model: ctx.modelName,
    choices: [{
      index: 0,
      delta,
      finish_reason: parsed.finishReason,
    }],
    ...(parsed.usage ? { usage: parsed.usage } : {}),
  };
}

/**
 * Parse a non-streaming Gemini response into OpenAI shape.
 * Returns { content, usage, response } where response is the full
 * OpenAI-compatible response object.
 */
export function parseResponseData(rawData) {
  const { content, reasoning } = extractGeminiContent(rawData);
  const toolCalls = extractGeminiToolCalls(rawData);
  const finishReason = mapFinishReason(
    rawData?.candidates?.[0]?.finishReason,
  );
  const usage = geminiUsageToOpenAI(rawData?.usageMetadata);

  const message = { role: "assistant", content };
  if (reasoning) message.reasoning_content = reasoning;
  if (toolCalls) message.tool_calls = toolCalls;

  const openaiResponse = {
    id: `chatcmpl-${Date.now()}`,
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model: rawData?.modelVersion || "",
    choices: [{
      index: 0,
      message,
      finish_reason: finishReason || "stop",
    }],
    usage,
  };

  return { content, usage, response: openaiResponse };
}

/**
 * Convert Gemini usageMetadata to OpenAI usage shape.
 * Gemini fields: promptTokenCount, candidatesTokenCount, cachedContentTokenCount
 * OpenAI fields: prompt_tokens, completion_tokens, cached_tokens
 */
function geminiUsageToOpenAI(meta) {
  if (!meta) return null;

  return {
    prompt_tokens: meta.promptTokenCount ?? 0,
    completion_tokens: meta.candidatesTokenCount ?? 0,
    total_tokens:
      (meta.promptTokenCount ?? 0) + (meta.candidatesTokenCount ?? 0),
    prompt_tokens_details: {
      cached_tokens: meta.cachedContentTokenCount ?? 0,
    },
  };
}

// ---------------------------------------------------------------------------
// Stream lifecycle
// ---------------------------------------------------------------------------

/**
 * Gemini's SSE stream doesn't send a "[DONE]" marker — the stream just ends.
 * So this always returns false; the caller relies on the "end" event.
 */
export function isStreamEnd(payload) {
  return false;
}


