/**
 * Gemini Interactions Adapter — POST {base}/v1beta/interactions.
 *
 *   x-goog-api-key: <key>
 *   { "model": "...", "input": [{ "type": "text", "text": "..." }] }
 *
 * Response (an Interaction resource):
 *   { "id", "object": "interaction", "model", "status", "created", "updated",
 *     "steps": [{ "type": "model_output",
 *                 "content": [{ "type": "text", "text": "..." },
 *                             { "type": "image", "data": "<base64>",
 *                               "mime_type": "image/png" }] }],
 *     "usage": { "total_input_tokens", "total_output_tokens",
 *                "total_thought_tokens", "total_cached_tokens", "total_tokens" } }
 *
 * Unlike generateContent, this surface takes the API key in a header rather
 * than the query string — see `upstreamAuthHeaders`. It is Google's native
 * image surface, so it is not subject to the JPEG limitation of the
 * OpenAI-compat shim.
 *
 * The proxy sends the documented minimum body. Output-format controls
 * (`response_format`, `generation_config`) are not synthesized here; an
 * endpoint that needs `{"type":"image","image_size":"2K"}` sets it through its
 * custom body params, which run last on the wire body.
 */

import { imagePromptOf, type ImageContext } from "./images.js";

type JsonObject = Record<string, any>;

const DATA_URL = /^data:([^;,]+);base64,(.*)$/;

/**
 * An `input_references` entry, as OpenRouter's images API spells it, mapped to
 * an Interactions ImageContent block. ImageContent carries either inline `data`
 * with `mime_type`, or a `uri`.
 */
function referenceToBlock(entry: any): JsonObject | null {
  const url = typeof entry === "string" ? entry : entry?.image_url?.url ?? entry?.url;
  if (typeof url !== "string" || !url) return null;
  const match = url.match(DATA_URL);
  return match
    ? { type: "image", mime_type: match[1], data: match[2] }
    : { type: "image", uri: url };
}

/** The prompt, then any reference images the request carried, as input blocks. */
export function buildInteractionInput(clientReq: any): JsonObject[] {
  const blocks: JsonObject[] = [{ type: "text", text: imagePromptOf(clientReq) }];
  const references = Array.isArray(clientReq?.input_references) ? clientReq.input_references : [];
  for (const entry of references) {
    const block = referenceToBlock(entry);
    if (block) blocks.push(block);
  }
  return blocks;
}

export function transformImageRequest(clientReq: any, actualModel: string): JsonObject {
  return {
    model: actualModel,
    input: buildInteractionInput(clientReq),
  };
}

/** One Interactions ImageContent block as an OpenAI Images `data` entry. */
function imageBlockToEntry(block: any): JsonObject | null {
  if (block?.type !== "image") return null;
  if (typeof block.uri === "string" && block.uri) return { url: block.uri };
  if (typeof block.data !== "string" || !block.data) return null;
  const mediaType = typeof block.mime_type === "string" && block.mime_type
    ? block.mime_type
    : "image/png";
  return { b64_json: block.data, media_type: mediaType };
}

/**
 * Collects images and text from the interaction's `model_output` steps.
 * Tool-call and tool-result steps are skipped.
 */
export function extractInteractionOutput(rawData: any): { text: string; entries: JsonObject[] } {
  const steps = Array.isArray(rawData?.steps) ? rawData.steps : [];
  const texts: string[] = [];
  const entries: JsonObject[] = [];

  for (const step of steps) {
    if (step?.type !== "model_output") continue;
    const blocks = Array.isArray(step.content) ? step.content : [];
    for (const block of blocks) {
      if (block?.type === "text" && typeof block.text === "string" && block.text) {
        texts.push(block.text);
        continue;
      }
      const entry = imageBlockToEntry(block);
      if (entry) entries.push(entry);
    }
  }

  return { text: texts.join(""), entries };
}

/**
 * Interactions usage to OpenAI usage.
 *
 * Thought tokens are billed output but reported separately, so they are folded
 * into completion_tokens. `total_tokens` is taken as reported rather than
 * recomputed: the upstream total also covers internal tokens the breakdown does
 * not name.
 */
export function interactionUsageToOpenAI(usage: any) {
  const promptTokens = Number(usage?.total_input_tokens ?? 0) || 0;
  const outputTokens = Number(usage?.total_output_tokens ?? 0) || 0;
  const thoughtTokens = Number(usage?.total_thought_tokens ?? 0) || 0;
  const completionTokens = outputTokens + thoughtTokens;
  return {
    prompt_tokens: promptTokens,
    completion_tokens: completionTokens,
    total_tokens: Number(usage?.total_tokens ?? promptTokens + completionTokens) || 0,
  };
}

/**
 * A failed, cancelled, or budget-exceeded interaction answers with HTTP 200 and
 * a terminal `status`, so the status is checked here rather than by the route's
 * HTTP-level classification.
 */
function interactionFailure(rawData: any): Error | null {
  const status = rawData?.status;
  if (status !== "failed" && status !== "cancelled" && status !== "budget_exceeded") return null;
  const first = Array.isArray(rawData?.errors) ? rawData.errors[0] : null;
  const error = new Error(
    first?.message ? String(first.message) : `Interaction ${String(status)}`,
  ) as Error & { name: string; code?: string; statusCode?: number; responseBody?: unknown };
  error.name = "InteractionFailedError";
  if (first?.code) error.code = String(first.code);
  error.statusCode = status === "budget_exceeded" ? 402 : 502;
  error.responseBody = rawData;
  return error;
}

export function parseImageResponse(rawData: any, ctx: ImageContext) {
  const failure = interactionFailure(rawData);
  if (failure) throw failure;

  const { text, entries } = extractInteractionOutput(rawData);
  const usage = interactionUsageToOpenAI(rawData?.usage);

  return {
    response: {
      created: Math.floor(Date.now() / 1000),
      model: ctx.modelName,
      // Any prose the model returned alongside the image is reported as the
      // revised prompt, the only text field the Images shape carries.
      data: entries.map((entry) => (text ? { ...entry, revised_prompt: text } : entry)),
      usage,
    },
    imageCount: entries.length,
    usage,
  };
}
