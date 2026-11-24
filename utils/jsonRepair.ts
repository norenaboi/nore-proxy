/**
 * Repair of JSON truncated by an upstream stream failure.
 *
 * When an upstream dies mid-tool-call, the argument JSON accumulated so far is
 * usually missing only closing braces (and possibly a dangling quote). A
 * stream cut without recovery strands the client with a tool_use block that
 * never closes and no message_stop, which breaks strict SSE consumers like
 * Claude Code out of their whole session. Appending the missing closers turns
 * that into a complete, parseable (though truncated) tool input the client
 * can reason about.
 *
 * Every candidate is validated with `JSON.parse` before being used: repair is
 * best-effort, and a repair that cannot round-trip cleanly is refused
 * (the original fragments are then flushed untouched).
 */

/**
 * Attempts to produce a complete JSON document from a truncated prefix.
 * Returns the repaired string when it parses, `null` when no simple suffix
 * closes it (the caller keeps the original bytes).
 */
export function repairTruncatedJson(candidate: string): string | null {
  if (!candidate) return null;
  try {
    JSON.parse(candidate);
    return candidate; // already complete — nothing to repair
  } catch { /* fall through to repair */ }

  // Scan the prefix tracking string/escape state and the open brace stack.
  const closers: string[] = [];
  let inString = false;
  let escaped = false;
  for (const ch of candidate) {
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === "{" || ch === "[") closers.push(ch === "{" ? "}" : "]");
    else if (ch === "}" || ch === "]") closers.pop();
  }

  // The stack holds closers in open order (outermost first); they must be
  // appended innermost-first, i.e. reversed.
  const closeAll = closers.join("").split("").reverse().join("");

  // Cut inside a string value: close the quote, then the braces.
  if (inString) {
    const attempt = candidate + '"' + closeAll;
    try { JSON.parse(attempt); return attempt; } catch { /* next strategy */ }
    // Cut inside a property name: closing the quote yields `{"key"}`, so the
    // property needs a null value to become valid (`{"key":null}`).
    const asProperty = candidate + '":null' + closeAll;
    try { JSON.parse(asProperty); return asProperty; } catch { /* give up */ }
    return null;
  }

  const attempt = candidate + closeAll;
  try { JSON.parse(attempt); return attempt; } catch { return null; }
}
