export function maskTokenLikeServer(token: string): string {
  return token.length > 8
    ? `${token.substring(0, 4)}****${token.substring(token.length - 4)}`
    : "****";
}

export function isDuplicateToken(value: string, tokens: string[]): boolean {
  if (tokens.includes(value)) return true;
  const masked = maskTokenLikeServer(value);
  return tokens.some((token) => token.includes("****") && token === masked);
}

export function mergeBulkTokens(
  existingTokens: string[],
  input: string,
): { tokens: string[]; added: number; skipped: number } {
  const tokens = [...existingTokens];
  let added = 0;
  let skipped = 0;

  for (const line of input.split("\n")) {
    const value = line.trim();
    if (!value) continue;
    if (value.includes("****") || isDuplicateToken(value, tokens)) {
      skipped++;
      continue;
    }
    tokens.push(value);
    added++;
  }

  return { tokens, added, skipped };
}

export function removeTokenAt(
  tokens: string[],
  pendingConfirmations: Set<number>,
  index: number,
): { tokens: string[]; pendingConfirmations: Set<number> } {
  const nextConfirmations = new Set<number>();
  for (const pendingIndex of pendingConfirmations) {
    if (pendingIndex === index) continue;
    nextConfirmations.add(pendingIndex > index ? pendingIndex - 1 : pendingIndex);
  }

  return {
    tokens: tokens.filter((_, tokenIndex) => tokenIndex !== index),
    pendingConfirmations: nextConfirmations,
  };
}
