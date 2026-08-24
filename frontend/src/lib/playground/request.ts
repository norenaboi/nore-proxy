import type { ChatRequestBody, ChatRequestMessage, PlaygroundMessage, PlaygroundSettings } from "./types.js";

/** Blank fields mean "let the model decide", so they must not reach the request. */
export function parseNumericSetting(value: string): number | undefined {
  const trimmed = value.trim();
  if (trimmed === "") return undefined;
  const parsed = Number.parseFloat(trimmed);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function messageContent(message: PlaygroundMessage): ChatRequestMessage["content"] {
  const blocks: NonNullable<ChatRequestMessage["content"]> = [];
  if (message.content.length > 0) blocks.push({ type: "text", text: message.content });
  for (const attachment of message.attachments ?? []) {
    if (attachment.type === "text") {
      blocks.push({
        type: "text",
        text: `\n\n[File: ${attachment.name}]\n\`\`\`\n${attachment.value}\n\`\`\``,
      });
    } else if (attachment.value.startsWith("data:")) {
      blocks.push({ type: "image_url", image_url: { url: attachment.value } });
    }
  }
  if (blocks.length === 0) return "";
  return blocks.length === 1 && blocks[0].type === "text" ? blocks[0].text : blocks;
}

/** True when a turn carries nothing an upstream would accept as content. */
function isEmpty(content: ChatRequestMessage["content"]): boolean {
  return typeof content === "string" ? content.trim().length === 0 : content.length === 0;
}

export function buildChatRequest(
  messages: PlaygroundMessage[],
  settings: PlaygroundSettings,
): ChatRequestBody {
  // Reasoning and response images are display-only and are never sent upstream.
  // Filtering after the content is built also drops a turn whose only payload
  // was an image the browser has since evicted, rather than sending it blank.
  const history: ChatRequestMessage[] = messages
    .map((message) => ({ role: message.role, content: messageContent(message) }))
    .filter((message) => !isEmpty(message.content));

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
