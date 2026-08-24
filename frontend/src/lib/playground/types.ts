export type ChatRole = "system" | "user" | "assistant";

export interface PlaygroundAttachment {
  id: string;
  type: "text" | "image";
  name: string;
  mimeType: string;
  /** Text content for text files, or a data URL for images. */
  value: string;
}

export interface PlaygroundImage {
  id: string;
  mimeType: string;
  dataUrl: string;
}

export interface PlaygroundMessage {
  id: string;
  role: Exclude<ChatRole, "system">;
  content: string;
  attachments?: PlaygroundAttachment[];
  images?: PlaygroundImage[];
  /** Empty string when the turn produced no reasoning, so call sites never guard. */
  reasoning: string;
  createdAt: number;
  /** Set when the turn ended in a failure that still left partial output. */
  error?: string;
}

export interface PlaygroundSettings {
  modelId: string;
  systemPrompt: string;
  /** Raw text so a blank field stays distinguishable from zero. */
  temperature: string;
  topP: string;
  stream: boolean;
}

export interface PlaygroundConversation {
  id: string;
  title: string;
  /** The model this conversation was last sent with. */
  modelId: string;
  messages: PlaygroundMessage[];
  createdAt: number;
  updatedAt: number;
}

export interface PlaygroundWorkspace {
  conversations: PlaygroundConversation[];
  activeId: string;
  /** Shared across conversations; modelId is the default for new ones. */
  settings: PlaygroundSettings;
}

export interface ChatRequestMessage {
  role: ChatRole;
  content: string | Array<
    | { type: "text"; text: string }
    | { type: "image_url"; image_url: { url: string } }
  >;
}

export interface ChatRequestBody {
  model: string;
  messages: ChatRequestMessage[];
  stream: boolean;
  temperature?: number;
  top_p?: number;
}
