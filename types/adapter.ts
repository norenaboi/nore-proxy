import type { ApiFormat } from "./endpoint.js";

export type JsonObject = Record<string, unknown>;
export type OpenAIMessageRole = "system" | "developer" | "user" | "assistant" | "tool";

export interface OpenAITextContentPart {
  type: "text";
  text: string;
  [key: string]: unknown;
}

export interface OpenAIImageContentPart {
  type: "image_url";
  image_url: { url: string; [key: string]: unknown };
  [key: string]: unknown;
}

export type OpenAIMessageContent = string | Array<OpenAITextContentPart | OpenAIImageContentPart | JsonObject> | null;

export interface OpenAIToolCall {
  id?: string;
  type: "function";
  function: {
    name?: string;
    arguments?: string;
    [key: string]: unknown;
  };
  [key: string]: unknown;
}

export interface OpenAIChatMessage {
  role: OpenAIMessageRole;
  content?: OpenAIMessageContent;
  tool_call_id?: string;
  tool_calls?: OpenAIToolCall[];
  [key: string]: unknown;
}

/** Incoming OpenAI-compatible chat request shared by all outbound adapters. */
export interface OpenAIChatRequest extends JsonObject {
  model?: string;
  messages?: OpenAIChatMessage[];
  stream?: boolean;
  max_tokens?: number;
  max_completion_tokens?: number;
  temperature?: number;
  top_p?: number;
  reasoning_effort?: string;
  tools?: Array<JsonObject & { type?: string; function?: JsonObject }>;
  tool_choice?: string | JsonObject;
  cache_depth?: number | string;
  prompt_cache_key?: string;
}

export interface OpenAIUsage {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens?: number;
  prompt_tokens_details?: {
    cache_creation_input_tokens?: number;
    cache_write_tokens?: number;
    cached_tokens?: number;
    cache_read_input_tokens?: number;
    cache_read_tokens?: number;
    [key: string]: unknown;
  };
  completion_tokens_details?: {
    reasoning_tokens?: number;
    [key: string]: unknown;
  };
  [key: string]: unknown;
}

export interface AdapterToolCallDelta {
  index: number;
  id?: string;
  type?: "function";
  function: {
    name?: string;
    arguments?: string;
  };
}

export interface ParsedStreamChunk {
  deltaContent: string | null;
  deltaReasoning?: string | null;
  finishReason: string | null;
  usage: OpenAIUsage | null;
  toolCalls: AdapterToolCallDelta[] | null;
}

export interface AdapterStreamContext {
  requestId?: string;
  isStreaming?: boolean;
  modelName?: string;
  streamId?: string;
  streamCreated?: number;
  /** Mutable adapter-local state for typed stream formats. */
  [key: string]: unknown;
}

export interface OpenAIChatCompletionChunk extends JsonObject {
  id: string;
  object: "chat.completion.chunk";
  created: number;
  model: string;
  choices: Array<{
    index: number;
    delta: JsonObject;
    finish_reason: string | null;
  }>;
  usage?: OpenAIUsage;
}

export interface ParsedResponse {
  content: string;
  usage: OpenAIUsage | null;
  /** Fully normalized OpenAI-compatible completion response. */
  response: JsonObject;
}

/**
 * Adapter modules translate the shared incoming OpenAI request to one upstream
 * API format and normalize responses back to OpenAI-compatible shapes.
 */
export interface Adapter {
  transformRequest(
    request: OpenAIChatRequest,
    actualModel: string,
    context?: AdapterStreamContext,
  ): JsonObject;
  transformStreamRequest(
    request: OpenAIChatRequest,
    actualModel: string,
    context?: AdapterStreamContext,
  ): JsonObject;
  parseStreamChunk(
    rawChunk: unknown,
    context: AdapterStreamContext,
  ): ParsedStreamChunk | null;
  buildStreamChunk(
    rawChunk: unknown,
    context: AdapterStreamContext,
  ): OpenAIChatCompletionChunk | null;
  parseResponseData(rawData: unknown): ParsedResponse;
  isStreamEnd(payload: string): boolean;
  getExtraHeaders?(context?: AdapterStreamContext): Record<string, string>;
}

export type AdapterRegistry = Record<ApiFormat, Adapter>;
