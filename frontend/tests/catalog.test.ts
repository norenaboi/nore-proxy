import { describe, expect, it } from "vitest";
import {
  clearModelCache,
  formatPrice,
  getProvider,
  normalizeModels,
  readModelCache,
  writeModelCache,
} from "$frontend/lib/models/catalog";

class MemoryStorage implements Storage {
  private values = new Map<string, string>();
  get length(): number { return this.values.size; }
  clear(): void { this.values.clear(); }
  getItem(key: string): string | null { return this.values.get(key) ?? null; }
  key(index: number): string | null { return [...this.values.keys()][index] ?? null; }
  removeItem(key: string): void { this.values.delete(key); }
  setItem(key: string, value: string): void { this.values.set(key, value); }
}

describe("model catalog", () => {
  it("classifies model providers", () => {
    expect(getProvider("claude-sonnet-5")).toBe("Anthropic");
    expect(getProvider("gemini-2.5-pro")).toBe("Google");
    expect(getProvider("gpt-5")).toBe("OpenAI");
    expect(getProvider("custom-model")).toBe("Others");
  });

  it("normalizes and sorts API models", () => {
    const models = normalizeModels({
      object: "list",
      data: [
        { id: "gpt-5", object: "model", created: 1, owned_by: "nore-proxy", type: "chat", pricing: null },
        { id: "claude-sonnet-5", object: "model", created: 1, owned_by: "nore-proxy", type: "chat", pricing: { input: 3 } },
      ],
    });
    expect(models.map((model) => model.id)).toEqual(["claude-sonnet-5", "gpt-5"]);
    expect(models[0]?.pricing).toEqual({ input: 3, output: 0, cache_write: 0, cache_read: 0 });
  });

  it("round-trips and clears the versioned cache", () => {
    const storage = new MemoryStorage();
    const models = normalizeModels(["gpt-5"]);
    writeModelCache(storage, models);
    expect(readModelCache(storage)).toEqual(models);
    clearModelCache(storage);
    expect(readModelCache(storage)).toBeNull();
  });

  it("formats prices consistently", () => {
    expect(formatPrice(0)).toBe("$0.00");
    expect(formatPrice(0.25)).toBe("$0.25");
    expect(formatPrice(0.003)).toBe("$0.003");
  });
});
