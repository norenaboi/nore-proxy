/**
 * OpenRouter Images Adapter — POST {base}/v1/images.
 *
 *   Authorization: Bearer <key>
 *   { "model": "...", "prompt": "..." }
 *
 * Response:
 *   { "created": 1748372400,
 *     "data": [{ "b64_json": "...", "media_type": "image/png" }],
 *     "usage": { "prompt_tokens", "completion_tokens", "total_tokens", "cost" } }
 *
 * OpenRouter's images API already speaks the OpenAI Images shape the proxy's
 * own route exposes, so the request is forwarded with unknown top-level params
 * intact. That passthrough is what makes provider-specific extras
 * (`aspect_ratio`, `output_compression`, `provider`, `input_references`, …)
 * reach the upstream without new code here; do not replace it with an
 * allow-list. The endpoint's body-param policy still runs last on the wire body.
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
