/**
 * OpenAI Images Adapter — POST {base}/v1/images.
 *
 *   Authorization: Bearer <key>
 *   { "model": "...", "prompt": "...", "n", "size", "quality", "response_format", ... }
 *
 * Response:
 *   { "created": 1748372400,
 *     "data": [{ "b64_json": "..." | "url": "...", "revised_prompt"?: "..." }],
 *     "usage"?: { "input_tokens", "output_tokens", "total_tokens", "input_tokens_details" } }
 *
 * The request and response shapes match the proxy's own images route. Unknown
 * top-level params are forwarded untouched; any OpenAI Images-compatible
 * provider works through this adapter without an allow-list. Provider extras
 * (OpenRouter's `media_type` per image, `cost` in usage, `aspect_ratio`,
 * `input_references`, …) pass through the same way. The endpoint's body-param
 * policy runs last on the wire body.
 *
 * `usage` is optional. `gpt-image-*` reports `input_tokens`/`output_tokens`,
 * DALL·E reports no usage, and compatible gateways may use
 * `prompt_tokens`/`completion_tokens`. Both spellings are read; absent usage
 * parses as zero and the route bills its prompt-length estimate instead.
 *
 * `openai-images-generations` posts the same body to `/v1/images/generations`
 * and re-exports this module.
 */

import { imagePromptOf, PROXY_OWNED_IMAGE_PARAMS, type ImageContext } from "./images.js";

export function transformImageRequest(clientReq: any, actualModel: string): Record<string, any> {
  imagePromptOf(clientReq);
  const body: Record<string, any> = { ...(clientReq || {}) };
  for (const param of PROXY_OWNED_IMAGE_PARAMS) delete body[param];
  // Undefined and null values are dropped for the same reason the chat and
  // embedding adapters drop them: upstreams reject params they know with a
  // null value.
  for (const key of Object.keys(body)) {
    if (body[key] === undefined || body[key] === null) delete body[key];
  }
  body.model = actualModel;
  return body;
}

export function parseImageResponse(rawData: any, ctx: ImageContext) {
  const data = Array.isArray(rawData?.data) ? rawData.data : [];
  const usage = rawData?.usage || {};
  const promptTokens = Number(usage.prompt_tokens ?? usage.input_tokens ?? 0) || 0;
  const completionTokens = Number(usage.completion_tokens ?? usage.output_tokens ?? 0) || 0;

  return {
    // Already OpenAI Images-shaped; the model name is overwritten by the route
    // so the upstream's own name never leaks back.
    response: { ...rawData, model: ctx.modelName },
    imageCount: data.length,
    usage: {
      prompt_tokens: promptTokens,
      completion_tokens: completionTokens,
      total_tokens: Number(usage.total_tokens ?? promptTokens + completionTokens) || 0,
    },
  };
}
