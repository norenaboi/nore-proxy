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
  /** How many images to generate, "1" through "4"; blank means one. */
  count?: string;
}

/** The requested image count clamped to the 1–4 range the picker offers. */
export function imageCountOf(settings?: ImageSettings): number {
  const parsed = Number.parseInt(settings?.count ?? "", 10);
  if (!Number.isFinite(parsed)) return 1;
  return Math.min(4, Math.max(1, parsed));
}

export function buildImageRequest(
  model: string,
  prompt: string,
  settings?: ImageSettings,
  format?: ImageApiFormat,
) {
  const body: Record<string, string | number> = { model, prompt };
  if (format === "gemini-interactions") {
    if (settings?.aspectRatio) body.aspect_ratio = settings.aspectRatio;
    if (settings?.imageSize) body.image_size = settings.imageSize;
  } else if (format === "openai-images" || format === "openai-images-generations") {
    if (settings?.size) body.size = settings.size;
    if (settings?.quality) body.quality = settings.quality;
    // OpenAI-shaped providers take the count natively and the adapters forward
    // it untouched. The Interactions request never carries a count: its batch
    // is generateImageBatch's parallel fan-out.
    const count = imageCountOf(settings);
    if (count > 1) body.n = count;
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

export interface ImageBatchResult {
  images: StreamImage[];
  /** Requests that failed while at least one other request succeeded. */
  failed: number;
}

/**
 * Runs one generation turn for the requested image count.
 *
 * OpenAI-shaped providers accept the count as `n` on a single request, so it
 * rides along in buildImageRequest. The Interactions API returns one image per
 * request, so the count fans out into parallel single-image requests instead.
 * When only some of those fail, the finished images are returned together with
 * the failure count; when every request fails, the first error is thrown so
 * status-based handling (401, 404) sees the same shape as a single request.
 */
export async function generateImageBatch(
  apiKey: string,
  modelId: string,
  prompt: string,
  signal: AbortSignal,
  settings?: ImageSettings,
  format?: ImageApiFormat,
): Promise<ImageBatchResult> {
  const count = imageCountOf(settings);
  if (format !== "gemini-interactions" || count <= 1) {
    return { images: await generateImages(apiKey, modelId, prompt, signal, settings, format), failed: 0 };
  }

  const outcomes = await Promise.allSettled(
    Array.from({ length: count }, () => generateImages(apiKey, modelId, prompt, signal, settings, format)),
  );
  const images = outcomes.flatMap((outcome) => (outcome.status === "fulfilled" ? outcome.value : []));
  const failures = outcomes.filter(
    (outcome): outcome is PromiseRejectedResult => outcome.status === "rejected",
  );
  if (images.length === 0 && failures.length > 0) throw failures[0].reason;
  return { images, failed: failures.length };
}
