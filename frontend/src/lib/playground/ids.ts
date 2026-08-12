let sequence = 0;

/**
 * Timestamps alone collide when two messages are created in the same
 * millisecond, so combine one with a monotonic counter and some entropy.
 */
export function createMessageId(): string {
  sequence += 1;
  const entropy =
    typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
      ? crypto.randomUUID().slice(0, 8)
      : Math.random().toString(36).slice(2, 10);
  return `m-${Date.now().toString(36)}-${sequence.toString(36)}-${entropy}`;
}
