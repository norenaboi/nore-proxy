import { extractApiErrorMessage } from "./request.js";
import { extractThinkTags } from "./thinkTags.js";
import type { ChatRequestBody } from "./types.js";

export type ChatStreamFailure = "http" | "stream" | "network";

export class ChatStreamError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly kind: ChatStreamFailure,
  ) {
    super(message);
    this.name = "ChatStreamError";
  }
}

export interface ChatStreamHandlers {
  onContentDelta(delta: string): void;
  /** Used only once inline `<think>` tags force the content to be re-derived. */
  onContentReplace(content: string): void;
  onReasoning(reasoning: string): void;
  /** Generated images, delivered as they arrive. */
  onImages(images: StreamImage[]): void;
}

export interface StreamImage {
  mimeType: string;
  dataUrl: string;
}

export interface ChatStreamResult {
  content: string;
  reasoning: string;
  images: StreamImage[];
  finishReason: string | null;
}

interface RawImage {
  type?: unknown;
  image_url?: { url?: unknown } | null;
  url?: unknown;
  b64_json?: unknown;
  mime_type?: unknown;
  mimeType?: unknown;
}

interface StreamChunk {
  error?: { message?: unknown; code?: unknown };
  choices?: Array<{
    finish_reason?: unknown;
    delta?: {
      content?: unknown;
      reasoning_content?: unknown;
      reasoning?: unknown;
      thinking?: unknown;
      images?: unknown;
    };
  }>;
}

interface CompletionBody {
  error?: { message?: unknown; code?: unknown };
  choices?: Array<{
    finish_reason?: unknown;
    message?: {
      content?: unknown;
      reasoning_content?: unknown;
      reasoning?: unknown;
      thinking?: unknown;
      images?: unknown;
    };
  }>;
}

/** Reads the media type out of a data URL so downloads get a real extension. */
function mimeFromDataUrl(url: string): string {
  const match = /^data:([^;,]+)[;,]/.exec(url);
  return match ? match[1] : "image/png";
}

/**
 * Only inline data and https references are rendered. Anything else — a
 * provider file id, a blob: handle, a javascript: URL — is not an image this
 * page can display, and must never reach an img src.
 */
function readImageUrl(url: string): StreamImage | null {
  if (url.startsWith("data:image/")) return { mimeType: mimeFromDataUrl(url), dataUrl: url };
  if (url.startsWith("https://")) return { mimeType: "", dataUrl: url };
  return null;
}

/**
 * Providers disagree on how a generated image is returned even after the proxy
 * normalizes them, so every documented shape is accepted: an OpenAI image part,
 * a bare URL, or raw base64 with a separate media type. Anything that is not a
 * usable image reference is dropped rather than rendered as a broken image.
 */
function readImages(value: unknown): StreamImage[] {
  if (!Array.isArray(value)) return [];
  const images: StreamImage[] = [];

  for (const entry of value) {
    if (typeof entry === "string") {
      const image = readImageUrl(entry);
      if (image) images.push(image);
      continue;
    }
    if (entry === null || typeof entry !== "object") continue;

    const raw = entry as RawImage;
    const url = typeof raw.image_url?.url === "string" ? raw.image_url.url : typeof raw.url === "string" ? raw.url : "";
    const image = readImageUrl(url);
    if (image) {
      images.push(image);
      continue;
    }
    if (typeof raw.b64_json === "string" && raw.b64_json.length > 0) {
      const mimeType = typeof raw.mime_type === "string"
        ? raw.mime_type
        : typeof raw.mimeType === "string"
          ? raw.mimeType
          : "image/png";
      images.push({ mimeType, dataUrl: `data:${mimeType};base64,${raw.b64_json}` });
    }
  }
  return images;
}

function readReasoningDelta(delta: {
  reasoning_content?: unknown;
  reasoning?: unknown;
  thinking?: unknown;
}): string {
  // The proxy normalizes provider reasoning fields into reasoning_content, but
  // the originals can still arrive from endpoints that pass responses through.
  for (const value of [delta.reasoning_content, delta.reasoning, delta.thinking]) {
    if (typeof value === "string" && value.length > 0) return value;
  }
  return "";
}

/**
 * A streaming request can fail after the SSE headers are already flushed, in
 * which case the body is an event stream even though the status is not 2xx.
 */
async function readErrorResponse(response: Response): Promise<ChatStreamError> {
  const contentType = response.headers.get("content-type") ?? "";
  const text = await response.text().catch(() => "");

  if (contentType.includes("text/event-stream")) {
    for (const line of text.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed.startsWith("data:")) continue;
      const payload = trimmed.slice(5).trim();
      if (payload === "[DONE]") break;
      try {
        const event = JSON.parse(payload) as StreamChunk;
        const message = event.error?.message;
        if (typeof message === "string" && message.length > 0) {
          return new ChatStreamError(message, response.status, "http");
        }
      } catch {
        // Try the next frame; a partial frame is not a reason to give up.
      }
    }
  }

  let parsed: unknown = null;
  try {
    parsed = JSON.parse(text);
  } catch {
    // Fall back to the status-based message for non-JSON bodies.
  }
  return new ChatStreamError(extractApiErrorMessage(parsed, response.status), response.status, "http");
}

/** Non-streaming replies arrive whole, so the message is delivered in one go. */
async function readCompletion(response: Response, handlers: ChatStreamHandlers): Promise<ChatStreamResult> {
  const text = await response.text();
  let body: CompletionBody;
  try {
    body = JSON.parse(text) as CompletionBody;
  } catch {
    throw new ChatStreamError("The proxy returned a response that could not be read.", response.status, "stream");
  }

  if (body?.error && typeof body.error === "object") {
    const message = body.error.message;
    throw new ChatStreamError(
      typeof message === "string" && message.length > 0 ? message : "The upstream model failed.",
      typeof body.error.code === "number" ? body.error.code : response.status,
      "stream",
    );
  }

  const choice = body?.choices?.[0];
  const raw = typeof choice?.message?.content === "string" ? choice.message.content : "";
  let reasoning = choice?.message ? readReasoningDelta(choice.message) : "";
  const images = readImages(choice?.message?.images);

  const split = extractThinkTags(raw);
  if (split.reasoning) reasoning = reasoning ? `${reasoning}\n${split.reasoning}`.trim() : split.reasoning;
  if (reasoning) handlers.onReasoning(reasoning);
  if (images.length > 0) handlers.onImages(images);
  handlers.onContentReplace(split.content);

  return {
    content: split.content,
    reasoning,
    images,
    finishReason: typeof choice?.finish_reason === "string" ? choice.finish_reason : null,
  };
}

export async function streamChatCompletion(
  apiKey: string,
  body: ChatRequestBody,
  signal: AbortSignal,
  handlers: ChatStreamHandlers,
): Promise<ChatStreamResult> {
  let response: Response;
  try {
    response = await fetch("/v1/chat/completions", {
      method: "POST",
      credentials: "same-origin",
      signal,
      headers: {
        "Content-Type": "application/json",
        Accept: body.stream ? "text/event-stream" : "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify(body),
    });
  } catch (error) {
    // An abort must stay an abort so the caller can tell it from a failure.
    if (signal.aborted) throw error;
    throw new ChatStreamError("Could not reach the proxy. Check your connection.", 0, "network");
  }

  if (!response.ok) throw await readErrorResponse(response);
  if (!body.stream) return readCompletion(response, handlers);
  if (!response.body) {
    throw new ChatStreamError("The proxy returned an empty stream.", response.status, "stream");
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder("utf-8");
  let buffer = "";
  let raw = "";
  let reasoning = "";
  const images: StreamImage[] = [];
  let finishReason: string | null = null;
  let sawThink = false;
  let streamError: ChatStreamError | null = null;
  let done = false;

  try {
    while (!done) {
      const chunk = await reader.read();
      if (chunk.done) break;

      buffer += decoder.decode(chunk.value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed.startsWith("data:")) continue;
        const payload = trimmed.slice(5).trim();
        if (payload === "[DONE]") {
          done = true;
          break;
        }

        let event: StreamChunk;
        try {
          event = JSON.parse(payload) as StreamChunk;
        } catch {
          continue;
        }
        if (event === null || typeof event !== "object") continue;

        // A mid-stream failure carries its message at the top level of the
        // chunk rather than inside the delta, so read it before the choices.
        if (event.error !== null && typeof event.error === "object") {
          const message = event.error?.message;
          const code = event.error?.code;
          streamError = new ChatStreamError(
            typeof message === "string" && message.length > 0
              ? message
              : "The upstream model failed mid-response.",
            typeof code === "number" ? code : response.status,
            "stream",
          );
        }

        const choice = event.choices?.[0];
        if (!choice) continue;
        if (typeof choice.finish_reason === "string") finishReason = choice.finish_reason;

        const delta = choice.delta;
        if (delta === null || typeof delta !== "object") continue;

        const reasoningDelta = readReasoningDelta(delta);
        if (reasoningDelta) {
          reasoning += reasoningDelta;
          handlers.onReasoning(reasoning);
        }

        const imageDelta = readImages(delta.images);
        if (imageDelta.length > 0) {
          images.push(...imageDelta);
          handlers.onImages([...images]);
        }

        const token = delta.content;
        if (typeof token !== "string" || token === "") continue;
        raw += token;

        if (!sawThink && !raw.includes("<think>")) {
          handlers.onContentDelta(token);
          continue;
        }

        // Inline reasoning tags mean the whole message has to be re-split, so
        // stay on the cheap append path until one actually shows up.
        sawThink = true;
        const split = extractThinkTags(raw);
        if (split.reasoning) {
          reasoning = split.reasoning;
          handlers.onReasoning(reasoning);
        }
        handlers.onContentReplace(split.content);
      }
    }
  } finally {
    // Releasing the lock matters on abort, where the body is never drained.
    try {
      await reader.cancel();
    } catch {
      // The stream is already closed.
    }
  }

  if (streamError) throw streamError;
  return {
    content: sawThink ? extractThinkTags(raw).content : raw,
    reasoning,
    images,
    finishReason,
  };
}
