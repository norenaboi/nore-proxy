/**
 * Embedding adapters — wire-protocol transformation for /v1/embeddings.
 *
 * Embeddings are an explicit endpoint category: an endpoint declares
 * `openai-embeddings` or `gemini-embeddings` and serves vectors, or it declares
 * a format in another category and does not. The endpoint's format decides;
 * models carry no modality of their own.
 *
 * The proxy's client-facing embeddings route always speaks the OpenAI
 * embeddings shape, which is the de-facto general syntax: OpenRouter, DashScope
 * compatible-mode, Voyage, Jina, Together, Mistral, and Ollama all accept
 * `{ model, input, ... }` at `/v1/embeddings` and answer with
 * `{ object: "list", data: [{ object: "embedding", index, embedding }], usage }`.
 *
 * Because those providers diverge only in the *extra* params they accept
 * (`dimensions`, `encoding_format`, `input_type`, `task_type`, `truncate`,
 * `output_type`, …), the `openai-embeddings` adapter deliberately passes unknown
 * top-level params straight through instead of allow-listing them. That is what
 * makes an arbitrary OpenAI-compatible embeddings provider work without new
 * code, and the endpoint's body-param policy still gets the final say on the
 * wire body afterwards.
 *
 * `gemini-embeddings` is the one format that needs real translation: Google has
 * no OpenAI embeddings compatibility on the native surface, so requests become
 * `embedContent` and responses are normalized back to OpenAI shape. That surface
 * embeds one input per call, so a multi-item `input` is refused rather than
 * silently truncated.
 *
 * Adapter contract:
 *   transformEmbeddingRequest(clientReq, actualModel) -> upstream body
 *   parseEmbeddingResponse(rawData, ctx) -> { response, embeddingCount, usage }
 *
 * `ctx` carries { modelName } — the proxy-facing model name that the response
 * must report, never the upstream's own name.
 */

export interface EmbeddingContext {
  modelName: string;
}

export interface ParsedEmbeddingResponse {
  /** The OpenAI-shaped body handed back to the client. */
  response: Record<string, any>;
  embeddingCount: number;
  usage: { prompt_tokens: number; total_tokens: number };
}

export interface EmbeddingAdapter {
  transformEmbeddingRequest(clientReq: any, actualModel: string): Record<string, any>;
  parseEmbeddingResponse(rawData: any, ctx: EmbeddingContext): ParsedEmbeddingResponse;
}

/**
 * Params the proxy owns and never forwards. `model` is replaced with the
 * resolved upstream name, and `stream` has no meaning for embeddings — an
 * upstream that does not know the param would reject the request over it.
 * `cache_depth` is the proxy's own prompt-caching control.
 */
const PROXY_OWNED_PARAMS = ["model", "stream", "cache_depth"];

export class EmbeddingInputError extends Error {
  statusCode = 400;
  constructor(message: string) {
    super(message);
    this.name = "EmbeddingInputError";
  }
}

/**
 * Normalizes the OpenAI `input` union to an array of strings.
 *
 * OpenAI accepts a string, an array of strings, an array of token ids, or an
 * array of token-id arrays. Token-id inputs cannot be expressed as Gemini
 * content, so only the text forms are accepted where that matters; the
 * OpenAI-format path never calls this and forwards `input` untouched.
 */
export function embeddingInputToTexts(input: unknown): string[] {
  if (typeof input === "string") return [input];
  if (Array.isArray(input)) {
    if (input.length === 0) return [];
    if (input.every((entry) => typeof entry === "string")) return input as string[];
    throw new EmbeddingInputError(
      "This endpoint only accepts string or string-array embedding input; token-id input is not supported.",
    );
  }
  throw new EmbeddingInputError("Embedding request requires an 'input' string or array of strings.");
}

/** Number of items the client asked to embed, for logging and validation. */
export function embeddingInputCount(input: unknown): number {
  if (typeof input === "string") return 1;
  return Array.isArray(input) ? input.length : 0;
}

const openaiEmbeddings: EmbeddingAdapter = {
  transformEmbeddingRequest(clientReq: any, actualModel: string) {
    const body: Record<string, any> = { ...(clientReq || {}) };
    for (const param of PROXY_OWNED_PARAMS) delete body[param];
    // Undefined and null values are dropped for the same reason the chat
    // adapter drops them: upstreams reject params they know with a null value.
    for (const key of Object.keys(body)) {
      if (body[key] === undefined || body[key] === null) delete body[key];
    }
    body.model = actualModel;
    return body;
  },

  parseEmbeddingResponse(rawData: any, ctx: EmbeddingContext) {
    const data = Array.isArray(rawData?.data) ? rawData.data : [];
    const usage = rawData?.usage || {};
    // Providers disagree on which usage field they populate: OpenAI sends both
    // prompt_tokens and total_tokens, DashScope sends only total_tokens, and
    // several send neither. Each falls back to the other so accounting sees a
    // number whenever the upstream reported one at all.
    const promptTokens = Number(usage.prompt_tokens ?? usage.total_tokens ?? 0) || 0;
    const totalTokens = Number(usage.total_tokens ?? usage.prompt_tokens ?? 0) || 0;
    return {
      response: rawData,
      embeddingCount: data.length,
      usage: { prompt_tokens: promptTokens, total_tokens: totalTokens },
    };
  },
};

/**
 * Gemini's task types are an enum. The OpenAI-compatible spelling providers use
 * is `input_type: "query" | "document"`, so both are accepted and mapped.
 */
function geminiTaskType(clientReq: any): string | undefined {
  const raw = clientReq?.task_type ?? clientReq?.taskType ?? clientReq?.input_type;
  if (typeof raw !== "string" || !raw.trim()) return undefined;
  const normalized = raw.trim().toUpperCase().replace(/[\s-]+/g, "_");
  if (normalized === "QUERY") return "RETRIEVAL_QUERY";
  if (normalized === "DOCUMENT" || normalized === "PASSAGE") return "RETRIEVAL_DOCUMENT";
  return normalized;
}

/**
 * POST {base}/v1beta/models/{model}:embedContent
 *   { "content": { "parts": [{ "text": "..." }] },
 *     "embedContentConfig": { "taskType": "...", "outputDimensionality": N } }
 *
 * Response:
 *   { "embedding": { "values": [ … ] },
 *     "usageMetadata": { "promptTokenCount": N } }
 *
 * The model is named by the URL path, not the body. `taskType` and
 * `outputDimensionality` also exist as top-level body fields but are deprecated
 * in favour of `embedContentConfig`; an endpoint that needs the old spelling can
 * set it through its custom body params.
 */
const geminiEmbeddings: EmbeddingAdapter = {
  transformEmbeddingRequest(clientReq: any, actualModel: string) {
    const texts = embeddingInputToTexts(clientReq?.input);
    if (texts.length === 0) {
      throw new EmbeddingInputError("Embedding request requires at least one input.");
    }
    if (texts.length > 1) {
      throw new EmbeddingInputError(
        `This endpoint embeds one input per request; ${texts.length} were sent. ` +
        "Send a single string, or a one-element array.",
      );
    }
    const dimensions = Number(clientReq?.dimensions);
    const taskType = geminiTaskType(clientReq);
    const config: Record<string, any> = {
      ...(taskType ? { taskType } : {}),
      ...(Number.isFinite(dimensions) && dimensions > 0
        ? { outputDimensionality: Math.floor(dimensions) }
        : {}),
    };
    return {
      content: { parts: [{ text: texts[0] }] },
      ...(Object.keys(config).length > 0 ? { embedContentConfig: config } : {}),
    };
  },

  parseEmbeddingResponse(rawData: any, ctx: EmbeddingContext) {
    const embedding = rawData?.embedding;
    const values = Array.isArray(embedding?.values) ? embedding.values : [];
    // embedContent reports prompt tokens; there is no completion side to bill.
    const promptTokens = Number(rawData?.usageMetadata?.promptTokenCount ?? 0) || 0;
    const usage = { prompt_tokens: promptTokens, total_tokens: promptTokens };
    return {
      response: {
        object: "list",
        data: embedding ? [{ object: "embedding", index: 0, embedding: values }] : [],
        model: ctx.modelName,
        usage,
      },
      embeddingCount: embedding ? 1 : 0,
      usage,
    };
  },
};

const EMBEDDING_ADAPTERS: Record<string, EmbeddingAdapter> = {
  "openai-embeddings": openaiEmbeddings,
  "gemini-embeddings": geminiEmbeddings,
};

/**
 * The embedding adapter for an upstream format, or null for every format
 * outside the embedding category, an absent format included.
 *
 * Unlike getAdapter() this does not fall back to OpenAI: posting an embeddings
 * body at an endpoint configured for completions would turn a configuration
 * mistake into an unexplained upstream failure.
 */
export function getEmbeddingAdapter(apiFormat: string | null | undefined): EmbeddingAdapter | null {
  return apiFormat ? EMBEDDING_ADAPTERS[apiFormat] ?? null : null;
}

export { openaiEmbeddings, geminiEmbeddings };
