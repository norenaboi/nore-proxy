import { createMessageId } from "./ids.js";
import type {
  PlaygroundConversation,
  PlaygroundMessage,
  PlaygroundSettings,
  PlaygroundWorkspace,
} from "./types.js";

export const PLAYGROUND_KEY_STORAGE_KEY = "nore-proxy:playground:key:v1";
export const PLAYGROUND_WORKSPACE_KEY = "nore-proxy:playground:workspace:v1";
/** Written by an earlier single-conversation build; read once, then replaced. */
export const PLAYGROUND_LEGACY_CONVERSATION_KEY = "nore-proxy:playground:conversation:v1";

const WORKSPACE_VERSION = 1;
const MAX_CONVERSATIONS = 60;
const MAX_PERSISTED_MESSAGES = 240;
const MAX_PERSISTED_CHARS = 40_000;
const TITLE_LENGTH = 48;

export type WriteResult = "ok" | "trimmed" | "failed";

interface WorkspaceEnvelope {
  version: number;
  workspace: PlaygroundWorkspace;
}

export function defaultSettings(): PlaygroundSettings {
  return { modelId: "", systemPrompt: "", temperature: "", topP: "", stream: true };
}

export function createConversation(modelId = ""): PlaygroundConversation {
  const now = Date.now();
  return { id: createMessageId(), title: "", modelId, messages: [], createdAt: now, updatedAt: now };
}

export function createWorkspace(): PlaygroundWorkspace {
  const conversation = createConversation();
  return { conversations: [conversation], activeId: conversation.id, settings: defaultSettings() };
}

/** Falls back to a stable label so a titled row never renders as empty. */
export function conversationTitle(conversation: PlaygroundConversation): string {
  if (conversation.title.trim().length > 0) return conversation.title.trim();
  const firstUser = conversation.messages.find((message) => message.role === "user");
  const source = firstUser?.content.trim() ?? "";
  if (source.length === 0) return "New chat";
  const firstLine = source.split("\n", 1)[0] ?? source;
  return firstLine.length > TITLE_LENGTH ? `${firstLine.slice(0, TITLE_LENGTH).trimEnd()}…` : firstLine;
}

export function readApiKey(storage: Storage): string {
  try {
    return storage.getItem(PLAYGROUND_KEY_STORAGE_KEY) ?? "";
  } catch {
    return "";
  }
}

export function writeApiKey(storage: Storage, key: string): void {
  try {
    storage.setItem(PLAYGROUND_KEY_STORAGE_KEY, key);
  } catch {
    // The key still works for this session even if it cannot be remembered.
  }
}

export function clearApiKey(storage: Storage): void {
  try {
    storage.removeItem(PLAYGROUND_KEY_STORAGE_KEY);
  } catch {
    // Nothing to recover from; the in-memory key is cleared by the caller.
  }
}

function text(candidate: unknown): string {
  return typeof candidate === "string" ? candidate : "";
}

function normalizeSettings(value: unknown): PlaygroundSettings {
  const input = (value ?? {}) as Partial<Record<keyof PlaygroundSettings, unknown>>;
  return {
    modelId: text(input.modelId),
    systemPrompt: text(input.systemPrompt),
    temperature: text(input.temperature),
    topP: text(input.topP),
    // Streaming is the default, so only an explicit false turns it off.
    stream: input.stream !== false,
  };
}

function normalizeMessage(value: unknown): PlaygroundMessage | null {
  const input = value as Partial<Record<keyof PlaygroundMessage, unknown>> | null;
  if (input === null || typeof input !== "object") return null;
  if (typeof input.id !== "string" || input.id.length === 0) return null;
  if (input.role !== "user" && input.role !== "assistant") return null;
  if (typeof input.content !== "string") return null;

  const message: PlaygroundMessage = {
    id: input.id,
    role: input.role,
    content: input.content,
    reasoning: text(input.reasoning),
    createdAt: typeof input.createdAt === "number" ? input.createdAt : Date.now(),
  };
  if (typeof input.error === "string" && input.error.length > 0) message.error = input.error;
  return message;
}

function normalizeConversation(value: unknown): PlaygroundConversation | null {
  const input = value as Partial<Record<keyof PlaygroundConversation, unknown>> | null;
  if (input === null || typeof input !== "object") return null;
  if (typeof input.id !== "string" || input.id.length === 0) return null;
  if (!Array.isArray(input.messages)) return null;

  const now = Date.now();
  return {
    id: input.id,
    title: text(input.title),
    modelId: text(input.modelId),
    messages: input.messages
      .map((message) => normalizeMessage(message))
      .filter((message): message is PlaygroundMessage => message !== null),
    createdAt: typeof input.createdAt === "number" ? input.createdAt : now,
    updatedAt: typeof input.updatedAt === "number" ? input.updatedAt : now,
  };
}

/** Reads the pre-sidebar single-conversation payload so history is not lost. */
function readLegacyWorkspace(storage: Storage): PlaygroundWorkspace | null {
  let value: string | null;
  try {
    value = storage.getItem(PLAYGROUND_LEGACY_CONVERSATION_KEY);
  } catch {
    return null;
  }
  if (!value) return null;

  try {
    const envelope = JSON.parse(value) as { version?: number; conversation?: unknown };
    if (envelope?.version !== 1) return null;
    const stored = envelope.conversation as
      | { messages?: unknown; settings?: unknown; updatedAt?: unknown }
      | null;
    if (!stored || !Array.isArray(stored.messages)) return null;

    const settings = normalizeSettings(stored.settings);
    const conversation = createConversation(settings.modelId);
    conversation.messages = stored.messages
      .map((message) => normalizeMessage(message))
      .filter((message): message is PlaygroundMessage => message !== null);
    if (typeof stored.updatedAt === "number") conversation.updatedAt = stored.updatedAt;

    return { conversations: [conversation], activeId: conversation.id, settings };
  } catch {
    return null;
  }
}

export function readWorkspace(storage: Storage): PlaygroundWorkspace | null {
  let value: string | null;
  try {
    value = storage.getItem(PLAYGROUND_WORKSPACE_KEY);
  } catch {
    return null;
  }
  if (!value) return readLegacyWorkspace(storage);

  try {
    const envelope = JSON.parse(value) as WorkspaceEnvelope;
    if (envelope?.version !== WORKSPACE_VERSION) return null;
    const stored = envelope.workspace;
    if (!stored || !Array.isArray(stored.conversations)) return null;

    // Everything read back was written by an earlier build, so revalidate it.
    const conversations = stored.conversations
      .map((conversation) => normalizeConversation(conversation))
      .filter((conversation): conversation is PlaygroundConversation => conversation !== null);
    if (conversations.length === 0) return null;

    const activeId = text(stored.activeId);
    return {
      conversations,
      activeId: conversations.some((conversation) => conversation.id === activeId)
        ? activeId
        : conversations[0].id,
      settings: normalizeSettings(stored.settings),
    };
  } catch {
    return null;
  }
}

function truncate(value: string): string {
  return value.length > MAX_PERSISTED_CHARS ? value.slice(0, MAX_PERSISTED_CHARS) : value;
}

export function trimForStorage(workspace: PlaygroundWorkspace): PlaygroundWorkspace {
  const byRecency = [...workspace.conversations].sort((left, right) => right.updatedAt - left.updatedAt);
  const kept = byRecency.slice(0, Math.max(1, Math.floor(MAX_CONVERSATIONS / 4)));
  const conversations = kept.map((conversation) => ({
    ...conversation,
    messages: conversation.messages.slice(-Math.floor(MAX_PERSISTED_MESSAGES / 4)).map((message) => ({
      ...message,
      content: truncate(message.content),
      reasoning: truncate(message.reasoning),
    })),
  }));

  return {
    conversations,
    activeId: conversations.some((conversation) => conversation.id === workspace.activeId)
      ? workspace.activeId
      : conversations[0].id,
    settings: workspace.settings,
  };
}

/**
 * Quota failures are reported rather than thrown so the page keeps working
 * without persistence. Browsers disagree on the error they raise here, so the
 * shape of the failure is not inspected.
 */
export function writeWorkspace(storage: Storage, workspace: PlaygroundWorkspace): WriteResult {
  const write = (value: PlaygroundWorkspace): void => {
    const envelope: WorkspaceEnvelope = { version: WORKSPACE_VERSION, workspace: value };
    storage.setItem(PLAYGROUND_WORKSPACE_KEY, JSON.stringify(envelope));
  };

  try {
    write(workspace);
    // The legacy payload has been folded in by now, so stop carrying it.
    try {
      storage.removeItem(PLAYGROUND_LEGACY_CONVERSATION_KEY);
    } catch {
      // Leaving it behind is harmless; it is only ever read as a fallback.
    }
    return "ok";
  } catch {
    try {
      write(trimForStorage(workspace));
      return "trimmed";
    } catch {
      return "failed";
    }
  }
}

export function clearWorkspace(storage: Storage): void {
  try {
    storage.removeItem(PLAYGROUND_WORKSPACE_KEY);
    storage.removeItem(PLAYGROUND_LEGACY_CONVERSATION_KEY);
  } catch {
    // The in-memory workspace is reset by the caller regardless.
  }
}
