/**
 * One-shot image generation against POST /v1/images. Unlike chat, the images
 * route never streams: the request returns a single finished OpenAI Images
 * body — `{ created, data: [{ b64_json | url }], usage }`.
 */

import type { ImageApiFormat } from "$contracts/apiFormats";
import { extractApiErrorMessage } from "./request.js";
import { readImages, type StreamImage } from "./stream.js";

export class ImageGenerationError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "ImageGenerationError";
  }
}

export interface ImageSettings {
  aspectRatio: string;
  imageSize: string;
  size?: string;
  quality?: string;
}

export function buildImageRequest(
  model: string,
  prompt: string,
  settings?: ImageSettings,
  format?: ImageApiFormat,
) {
  const body: Record<string, string> = { model, prompt };
  if (format === "gemini-interactions") {
    if (settings?.aspectRatio) body.aspect_ratio = settings.aspectRatio;
    if (settings?.imageSize) body.image_size = settings.imageSize;
  } else if (format === "openai-images" || format === "openai-images-generations") {
    if (settings?.size) body.size = settings.size;
    if (settings?.quality) body.quality = settings.quality;
  }
  return body;
}

export async function generateImages(
  apiKey: string,
  modelId: string,
  prompt: string,
  signal: AbortSignal,
  settings?: ImageSettings,
  format?: ImageApiFormat,
): Promise<StreamImage[]> {
  let response: Response;
  try {
    response = await fetch("/v1/images", {
      method: "POST",
      credentials: "same-origin",
      signal,
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify(buildImageRequest(modelId, prompt, settings, format)),
    });
  } catch (error) {
    // An abort must stay an abort so the caller can tell it from a failure.
    if (signal.aborted) throw error;
    throw new ImageGenerationError("Could not reach the proxy. Check your connection.", 0);
  }

  const text = await response.text();
  let body: unknown = null;
  try {
    body = JSON.parse(text);
  } catch {
    // A non-JSON body falls through to the status-based message below.
  }

  if (!response.ok) {
    throw new ImageGenerationError(extractApiErrorMessage(body, response.status), response.status);
  }
  if (body === null || typeof body !== "object") {
    throw new ImageGenerationError("The proxy returned a response that could not be read.", response.status);
  }

  // readImages accepts every documented result shape and drops anything that is
  // not a displayable image reference, exactly as the chat stream reader does.
  return readImages((body as { data?: unknown }).data);
}
