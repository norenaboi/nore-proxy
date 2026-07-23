/**
 * OpenAI Adapter — passthrough adapter.
 *
 * The proxy's incoming route is always /v1/chat/completions (OpenAI format).
 * For endpoints whose apiFormat is 'openai', the outbound request body and
 * inbound response are already in OpenAI format, so every function is an
 * identity transform.
 *
 * Adapter contract (every adapter exports these):
 *   transformRequest(openaiReq, actualModel, { cacheDepth }) -> backendBody
 *   transformStreamRequest(openaiReq, actualModel, { cacheDepth, messages }) -> backendBody
 *   parseStreamChunk(rawChunk, ctx) -> { deltaContent, finishReason, usage } | null
 *   parseResponseData(rawData, ctx) -> { content, usage }
 *   isStreamEnd(payload) -> bool
 *
 * ctx is an object the caller populates with { requestId, modelName, streamId, streamCreated }
 * so the adapter has what it needs to build OpenAI-shaped structures.
 */

/**
 * Build the outbound request body for a non-streaming request.
 * Returns the exact object to send as the axios `data` field.
 */
export function transformRequest(openaiReq: any, actualModel: any) {
  return buildOpenAIBody(openaiReq, actualModel, false);
}

/**
 * Build the outbound request body for a streaming request.
 */
export function transformStreamRequest(openaiReq: any, actualModel: any) {
  return buildOpenAIBody(openaiReq, actualModel, true);
}

function buildOpenAIBody(openaiReq: any, actualModel: any, stream: any) {
  const body: Record<string, any> = {
    model: actualModel,
    stream,
    messages: openaiReq.messages || [],
    max_tokens: openaiReq.max_tokens,
    temperature: openaiReq.temperature,
    top_p: openaiReq.top_p,
    reasoning_effort: openaiReq.reasoning_effort,
    tools: openaiReq.tools,
    tool_choice: openaiReq.tool_choice,
  };

  // Strip undefined / null values — upstream APIs reject unknown nulls.
  Object.keys(body).forEach((key) => {
    if (body[key] === undefined || body[key] === null) {
      delete body[key];
    }
  });

  return body;
}

/**
 * Parse a single SSE data chunk from the backend.
 * Returns { deltaContent, finishReason, usage } or null if nothing useful.
 */
export function parseStreamChunk(rawChunk: any, ctx: any) {
  const choices = rawChunk.choices || [];
  if (choices.length === 0) return null;

  const choice = choices[0];
  const delta = choice.delta || {};

  const deltaReasoning =
    (typeof delta.reasoning_content === "string" && delta.reasoning_content) ||
    (typeof delta.reasoning === "string" && delta.reasoning) ||
    (typeof delta.thinking === "string" && delta.thinking) ||
    null;

  return {
    deltaContent: delta.content || null,
    deltaReasoning,
    toolCalls: delta.tool_calls || null,
    finishReason: choice.finish_reason || null,
    usage: rawChunk.usage || null,
  };
}

/**
 * Build the OpenAI-compatible chunk to forward to the client.
 * For OpenAI format this is essentially passthrough with structure enforcement.
 */
export function buildStreamChunk(rawChunk: any, ctx: any) {
  return {
    id: rawChunk.id || ctx.streamId,
    object: "chat.completion.chunk",
    created: rawChunk.created || ctx.streamCreated,
    model: ctx.modelName,
    choices: (rawChunk.choices || []).map((choice: any, index: number) => {
      const delta = { ...(choice.delta || {}) };
      if (!delta.reasoning_content) {
        const reasoning =
          (typeof delta.reasoning === "string" && delta.reasoning) ||
          (typeof delta.thinking === "string" && delta.thinking) ||
          null;
        if (reasoning) delta.reasoning_content = reasoning;
      }

      return {
        index: choice.index !== undefined ? choice.index : index,
        delta,
        finish_reason: choice.finish_reason || null,
      };
    }),
    ...(rawChunk.usage ? { usage: rawChunk.usage } : {}),
  };
}

/**
 * Parse a non-streaming response from the backend into OpenAI shape.
 * Returns { content, usage } where usage has prompt_tokens, completion_tokens,
 * and optional cache token fields.
 */
export function parseResponseData(rawData: any) {
  const content = rawData.choices?.[0]?.message?.content || "";
  const usage = rawData.usage || {};

  return {
    content,
    usage: {
      prompt_tokens: usage.prompt_tokens ?? 0,
      completion_tokens: usage.completion_tokens ?? 0,
      prompt_tokens_details: {
        cache_creation_input_tokens:
          usage.prompt_tokens_details?.cache_creation_input_tokens ?? 0,
        cached_tokens:
          usage.prompt_tokens_details?.cached_tokens ?? 0,
      },
    },
    // Return the raw response as-is — it's already OpenAI compatible.
    response: rawData,
  };
}

/**
 * Returns true if the raw SSE payload string signals stream end.
 */
export function isStreamEnd(payload: any) {
  return payload === "[DONE]";
}


