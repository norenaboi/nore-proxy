import type { ChatRequestBody, ChatRequestMessage, PlaygroundMessage, PlaygroundSettings } from "./types.js";

/** Blank fields mean "let the model decide", so they must not reach the request. */
export function parseNumericSetting(value: string): number | undefined {
  const trimmed = value.trim();
  if (trimmed === "") return undefined;
  const parsed = Number.parseFloat(trimmed);
  return Number.isFinite(parsed) ? parsed : undefined;
}

export function buildChatRequest(
  messages: PlaygroundMessage[],
  settings: PlaygroundSettings,
): ChatRequestBody {
  // Reasoning is display-only and is never sent back upstream.
  const history: ChatRequestMessage[] = messages
    .filter((message) => message.content.trim().length > 0)
    .map(({ role, content }) => ({ role, content }));

  const systemPrompt = settings.systemPrompt.trim();
  if (systemPrompt.length > 0) history.unshift({ role: "system", content: systemPrompt });

  const body: ChatRequestBody = {
    model: settings.modelId,
    messages: history,
    stream: settings.stream,
  };

  const temperature = parseNumericSetting(settings.temperature);
  if (temperature !== undefined) body.temperature = temperature;
  const topP = parseNumericSetting(settings.topP);
  if (topP !== undefined) body.top_p = topP;
  return body;
}

/**
 * The proxy returns `error` as an object for authentication and quota failures
 * but as a bare string for an unknown model, so both shapes have to work.
 */
export function extractApiErrorMessage(body: unknown, status: number): string {
  const payload = body as { error?: unknown; message?: unknown } | null | undefined;
  const error = payload?.error;

  if (typeof error === "string" && error.length > 0) return error;
  if (error !== null && typeof error === "object") {
    const message = (error as { message?: unknown }).message;
    if (typeof message === "string" && message.length > 0) return message;
  }
  if (typeof payload?.message === "string" && payload.message.length > 0) return payload.message;
  return `Request failed (${status})`;
}
