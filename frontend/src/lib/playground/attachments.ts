import { createMessageId } from "./ids.js";
import type { PlaygroundAttachment } from "./types.js";

/** Anything larger than this is refused rather than silently truncated. */
export const MAX_ATTACHMENT_BYTES = 5 * 1024 * 1024;

/**
 * The file picker's accept list. It is a hint only: a dropped or pasted file
 * bypasses it entirely, so readAttachment still classifies by MIME type.
 */
export const ATTACHMENT_ACCEPT =
  "image/*,text/*,.txt,.md,.json,.csv,.log,.xml,.yaml,.yml,.js,.ts,.py,.html,.css";

const TEXT_EXTENSIONS = new Set([
  "txt", "md", "markdown", "json", "csv", "tsv", "log", "xml", "yaml", "yml",
  "js", "jsx", "ts", "tsx", "py", "rb", "go", "rs", "java", "c", "h", "cpp",
  "sh", "sql", "html", "css", "svelte", "vue", "toml", "ini", "env", "conf",
]);

export class AttachmentError extends Error {}

function extensionOf(name: string): string {
  const dot = name.lastIndexOf(".");
  return dot === -1 ? "" : name.slice(dot + 1).toLowerCase();
}

/** Files without a MIME type are common, so the extension is the fallback. */
function isTextFile(file: File): boolean {
  if (file.type.startsWith("text/")) return true;
  if (file.type === "application/json" || file.type === "application/xml") return true;
  return TEXT_EXTENSIONS.has(extensionOf(file.name));
}

function read(file: File, as: "text" | "dataUrl"): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      if (typeof reader.result === "string") resolve(reader.result);
      else reject(new AttachmentError(`${file.name} could not be read.`));
    };
    reader.onerror = () => reject(new AttachmentError(`${file.name} could not be read.`));
    reader.onabort = () => reject(new AttachmentError(`Reading ${file.name} was cancelled.`));
    if (as === "text") reader.readAsText(file);
    else reader.readAsDataURL(file);
  });
}

function describeSize(bytes: number): string {
  return bytes >= 1024 * 1024
    ? `${(bytes / (1024 * 1024)).toFixed(1)}MB`
    : `${Math.max(1, Math.round(bytes / 1024))}KB`;
}

/**
 * Turns one picked, dropped, or pasted file into an attachment. Images become
 * data URLs so they can be sent as OpenAI image_url parts; everything else is
 * read as text and inlined into the prompt.
 */
export async function readAttachment(file: File): Promise<PlaygroundAttachment> {
  if (file.size > MAX_ATTACHMENT_BYTES) {
    throw new AttachmentError(
      `${file.name} is ${describeSize(file.size)}; the limit is ${describeSize(MAX_ATTACHMENT_BYTES)}.`,
    );
  }

  if (file.type.startsWith("image/")) {
    return {
      id: createMessageId(),
      type: "image",
      name: file.name || "Pasted image",
      mimeType: file.type,
      value: await read(file, "dataUrl"),
    };
  }

  if (!isTextFile(file)) {
    throw new AttachmentError(`${file.name} is not a text or image file.`);
  }

  return {
    id: createMessageId(),
    type: "text",
    name: file.name || "Pasted text",
    mimeType: file.type || "text/plain",
    value: await read(file, "text"),
  };
}
