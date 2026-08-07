/**
 * Fixed safety limits for upstream SSE consumption.
 *
 * Two distinct hazards are bounded here:
 *
 *  1. Carry buffers. Every stream consumer appends raw upstream bytes to a
 *     string and only drains it when a delimiter arrives. An upstream that
 *     never sends one — broken, hostile, or a proxy corrupting framing —
 *     grows that string without limit.
 *
 *  2. Retained output. Generated text is accumulated in full so it can be
 *     logged and used for token-estimation fallback. That retention is
 *     proportional to total output, not to what the client still needs.
 *
 * These are code-level invariants, not runtime settings: they exist to keep
 * one request from exhausting process memory, and an operator lowering or
 * raising them would not be making a policy decision about behavior.
 *
 * Limits are measured in UTF-8 bytes, since character counts do not bound
 * memory for multibyte content.
 */

/**
 * Largest incomplete SSE record tolerated while waiting for a delimiter.
 *
 * Sized well above any legitimate single event rather than close to it. The
 * openai-responses and openai-codex formats end a stream with one
 * `response.completed` event embedding the whole response object — full output
 * text and reasoning, JSON-escaped, in a single `data:` line — so the largest
 * real record scales with the model's output limit, not with a delta.
 */
export const MAX_SSE_CARRY_BYTES = 8 * 1024 * 1024;

/** Largest amount of generated text retained per request for logging. */
export const MAX_RETAINED_OUTPUT_BYTES = 1024 * 1024;

/**
 * Largest amount of buffered tool-call argument JSON retained per request.
 *
 * Cumulative across every tool call in a response, since the budget resets
 * only when blocks are flushed. Agentic clients emitting large file writes or
 * many parallel calls in one turn are the sizing constraint, and exceeding it
 * fails the request, so this stays generous.
 */
export const MAX_RETAINED_TOOL_BYTES = 8 * 1024 * 1024;

export type StreamLimitKind = "sse_carry" | "retained_output" | "tool_arguments";

/**
 * Raised when a stream exceeds one of the limits above. Carries a status so
 * the existing upstream-failure classification treats it like any other
 * terminal upstream error, and deliberately omits the offending buffer so
 * oversized attacker-controlled data never reaches error storage.
 */
export class UpstreamStreamLimitError extends Error {
  readonly kind: StreamLimitKind;

  constructor(kind: StreamLimitKind, limitBytes: number) {
    super(`Upstream stream exceeded the ${kind} limit of ${limitBytes} bytes.`);
    this.name = "UpstreamStreamLimitError";
    this.kind = kind;
    this.statusCode = 502;
    this.code = `upstream_stream_${kind}_limit`;
  }
}

/**
 * Throws when an undelimited carry buffer has grown past the cap. Call after
 * appending a chunk and before splitting on the delimiter, so a buffer that
 * legitimately contains complete records is never rejected.
 */
export function guardCarryBuffer(
  buffer: string,
  limitBytes: number = MAX_SSE_CARRY_BYTES,
): void {
  if (Buffer.byteLength(buffer, "utf8") > limitBytes) {
    throw new UpstreamStreamLimitError("sse_carry", limitBytes);
  }
}

/**
 * Longest prefix of `value` whose UTF-8 encoding fits `limitBytes`, cut on a
 * code-point boundary. Buffer truncation alone would leave a partial multibyte
 * sequence that decodes to a replacement character.
 */
function sliceToByteLimit(value: string, limitBytes: number): string {
  let bytes = 0;
  let end = 0;
  for (const character of value) {
    const characterBytes = Buffer.byteLength(character, "utf8");
    if (bytes + characterBytes > limitBytes) break;
    bytes += characterBytes;
    end += character.length;
  }
  return value.slice(0, end);
}

/**
 * Accumulates text up to a byte budget while tracking the full length that
 * passed through.
 *
 * `text` is what gets persisted; `totalLength` is the character count of
 * everything appended, so token-estimation fallback stays accurate for
 * responses larger than the retention budget. Appending past the budget is
 * not an error — output is simply no longer retained.
 */
export function createBoundedText(limitBytes: number = MAX_RETAINED_OUTPUT_BYTES) {
  const parts: string[] = [];
  let retainedBytes = 0;
  let totalLength = 0;
  let truncated = false;

  return {
    append(value: string | null | undefined): void {
      if (!value) return;
      totalLength += value.length;
      const remaining = limitBytes - retainedBytes;
      if (remaining <= 0) {
        truncated = true;
        return;
      }
      const valueBytes = Buffer.byteLength(value, "utf8");
      if (valueBytes <= remaining) {
        parts.push(value);
        retainedBytes += valueBytes;
        return;
      }
      // Retain the longest whole-character prefix that fits, so the stored
      // text never ends in a split multibyte sequence.
      parts.push(sliceToByteLimit(value, remaining));
      retainedBytes = limitBytes;
      truncated = true;
    },
    get text(): string {
      return parts.join("");
    },
    get totalLength(): number {
      return totalLength;
    },
    get truncated(): boolean {
      return truncated;
    },
  };
}

export type BoundedText = ReturnType<typeof createBoundedText>;

/**
 * Tracks buffered tool-call argument fragments, which must be retained in
 * full to emit well-formed tool events. Exceeding the budget is therefore a
 * hard failure rather than silent truncation.
 */
export function createToolByteBudget(limitBytes: number = MAX_RETAINED_TOOL_BYTES) {
  let bytes = 0;
  return {
    add(value: string | null | undefined): void {
      if (!value) return;
      bytes += Buffer.byteLength(value, "utf8");
      if (bytes > limitBytes) {
        throw new UpstreamStreamLimitError("tool_arguments", limitBytes);
      }
    },
    reset(): void {
      bytes = 0;
    },
  };
}
