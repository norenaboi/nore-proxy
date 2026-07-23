import { createRequire } from "module";

const require = createRequire(import.meta.url);
const { v4: uuidv4 } = require("uuid") as { v4: () => string };

export function openAIResponseToAnthropic(openaiData: any, modelName: any, requestId: any) {
  const choice = openaiData.choices?.[0];
  const message = choice?.message || {};
  const contentBlocks = [];

  if (message.reasoning_content) {
    contentBlocks.push({
      type: "thinking",
      thinking: message.reasoning_content,
    });
  }

  if (message.content) {
    contentBlocks.push({ type: "text", text: message.content });
  }

  if (message.tool_calls) {
    for (const tc of message.tool_calls) {
      contentBlocks.push({
        type: "tool_use",
        id: tc.id || `toolu_${uuidv4().replace(/-/g, "").slice(0, 20)}`,
        name: tc.function?.name || "",
        input: safeParseJSON(tc.function?.arguments || "{}"),
      });
    }
  }

  if (contentBlocks.length === 0) {
    contentBlocks.push({ type: "text", text: "" });
  }

  const usage = openaiData.usage || {};
  let stopReason = "end_turn";
  if (choice?.finish_reason === "length") stopReason = "max_tokens";
  else if (choice?.finish_reason === "tool_calls") stopReason = "tool_use";
  else if (choice?.finish_reason === "stop") stopReason = "end_turn";

  return {
    id: openaiData.id || `msg_${requestId}`,
    type: "message",
    role: "assistant",
    model: modelName,
    content: contentBlocks,
    stop_reason: stopReason,
    stop_sequence: null,
    usage: {
      input_tokens: usage.prompt_tokens || 0,
      output_tokens: usage.completion_tokens || 0,
    },
  };
}

function safeParseJSON(str: any) {
  try { return JSON.parse(str); } catch { return {}; }
}
