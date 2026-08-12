export interface ThinkSplit {
  reasoning: string;
  content: string;
}

const THINK_OPEN = "<think>";
const CLOSED_THINK = /<think>([\s\S]*?)<\/think>/g;

/**
 * Some models emit reasoning inline as `<think>…</think>` inside the content
 * stream. Separate it so it can render in its own block, treating a trailing
 * unclosed tag as reasoning that is still being generated.
 */
export function extractThinkTags(text: string): ThinkSplit {
  const reasoningParts: string[] = [];
  const contentParts: string[] = [];
  let lastIndex = 0;

  // The pattern is module-level and global, so its cursor must be reset.
  CLOSED_THINK.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = CLOSED_THINK.exec(text)) !== null) {
    contentParts.push(text.slice(lastIndex, match.index));
    reasoningParts.push(match[1] ?? "");
    lastIndex = match.index + match[0].length;
  }

  const tail = text.slice(lastIndex);
  const unclosed = tail.indexOf(THINK_OPEN);
  if (unclosed === -1) {
    contentParts.push(tail);
  } else {
    contentParts.push(tail.slice(0, unclosed));
    reasoningParts.push(tail.slice(unclosed + THINK_OPEN.length));
  }

  // Content is not trimmed: this runs again on every token while streaming, and
  // trimming would keep eating whitespace the model actually emitted.
  return { reasoning: reasoningParts.join("\n").trim(), content: contentParts.join("") };
}
