import { isDeepStrictEqual } from "node:util";

export type ToolProtocol = "openai" | "anthropic";

export class ToolValidationError extends Error {
  constructor(message: string, public readonly code: string, public readonly param: string) {
    super(message);
    this.name = "ToolValidationError";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function displayName(name: string): string {
  const escaped = JSON.stringify(name).replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, (character) =>
    `\\u${character.charCodeAt(0).toString(16).padStart(4, "0")}`,
  );
  return escaped.length > 100 ? `${escaped.slice(0, 96)}…"` : escaped;
}

export function normalizeToolCatalog(tools: unknown, protocol: ToolProtocol): unknown {
  if (tools == null) return tools;
  if (!Array.isArray(tools)) {
    throw new ToolValidationError("tools must be an array.", "invalid_tools", "tools");
  }

  const normalized: Record<string, unknown>[] = [];
  const seen = new Map<string, { index: number; tool: Record<string, unknown> }>();
  for (const [index, tool] of tools.entries()) {
    const field = `tools[${index}]`;
    if (!isRecord(tool)) {
      throw new ToolValidationError(`${field} must be a tool object.`, "invalid_tools", field);
    }
    if (tool.type !== undefined && (typeof tool.type !== "string" || !tool.type.trim())) {
      throw new ToolValidationError(`${field}.type must be a non-empty string.`, "invalid_tools", `${field}.type`);
    }
    if (protocol === "openai" && tool.type === undefined) {
      throw new ToolValidationError(`${field}.type is required.`, "invalid_tools", `${field}.type`);
    }

    const custom = protocol === "openai"
      ? tool.type === "function"
      : tool.type === undefined || tool.type === "custom";
    // Provider-native declarations need not have a function name or schema.
    if (!custom) {
      normalized.push(tool);
      continue;
    }

    let name: unknown;
    let nameField: string;
    if (protocol === "openai") {
      if (!isRecord(tool.function)) {
        throw new ToolValidationError(`${field}.function must be an object.`, "invalid_tools", `${field}.function`);
      }
      name = tool.function.name;
      nameField = `${field}.function.name`;
    } else {
      name = tool.name;
      nameField = `${field}.name`;
    }
    if (typeof name !== "string" || !name.trim()) {
      throw new ToolValidationError(`${nameField} must be a non-empty string.`, "invalid_tool_name", nameField);
    }

    const previous = seen.get(name);
    if (previous) {
      if (!isDeepStrictEqual(previous.tool, tool)) {
        throw new ToolValidationError(
          `${field} conflicts with tools[${previous.index}]: duplicate function name ${displayName(name)} has different definitions. Remove the duplicate registration or use distinct names in the client.`,
          "conflicting_tool_definitions",
          field,
        );
      }
      continue;
    }
    seen.set(name, { index, tool });
    normalized.push(tool);
  }
  return normalized;
}
