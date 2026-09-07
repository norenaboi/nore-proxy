/**
 * OpenAI Images Generations Adapter — POST {base}/v1/images/generations.
 *
 * The path OpenAI's own API and the OpenAI SDK use. Same body and response as
 * `openai-images`; the URL is the only difference, so this module re-exports
 * that adapter.
 */

export { transformImageRequest, parseImageResponse } from "./openai-images.js";
