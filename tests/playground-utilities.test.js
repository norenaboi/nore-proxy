import assert from "node:assert/strict";
import test from "node:test";

import { createMessageId } from "../frontend/src/lib/playground/ids.js";
import { buildChatRequest, extractApiErrorMessage, parseNumericSetting } from "../frontend/src/lib/playground/request.js";
import {
  clearApiKey,
  clearWorkspace,
  conversationTitle,
  createConversation,
  createWorkspace,
  defaultSettings,
  readApiKey,
  readWorkspace,
  referencedPayloadIds,
  writeApiKey,
  writeWorkspace,
} from "../frontend/src/lib/playground/storage.js";
import { ChatStreamError, streamChatCompletion } from "../frontend/src/lib/playground/stream.js";
import { extractThinkTags } from "../frontend/src/lib/playground/thinkTags.js";

class MemoryStorage {
  values = new Map();
  get length() { return this.values.size; }
  clear() { this.values.clear(); }
  getItem(key) { return this.values.get(key) ?? null; }
  key(index) { return [...this.values.keys()][index] ?? null; }
  removeItem(key) { this.values.delete(key); }
  setItem(key, value) { this.values.set(key, value); }
}

function userMessage(content) {
  return { id: createMessageId(), role: "user", content, reasoning: "", createdAt: 1 };
}

/** Serves the given chunks as an SSE response so the reader can be driven offline. */
function stubFetch(chunks, init = {}) {
  const original = globalThis.fetch;
  globalThis.fetch = async () => {
    const stream = new ReadableStream({
      start(controller) {
        const encoder = new TextEncoder();
        for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
        controller.close();
      },
    });
    return new Response(stream, {
      status: init.status ?? 200,
      headers: { "content-type": init.contentType ?? "text/event-stream" },
    });
  };
  return () => { globalThis.fetch = original; };
}

function streamingBody(overrides = {}) {
  return { model: "m", messages: [], stream: true, ...overrides };
}

function collectHandlers() {
  const state = { content: "", reasoning: "", images: [] };
  return {
    state,
    handlers: {
      onContentDelta: (delta) => { state.content += delta; },
      onContentReplace: (content) => { state.content = content; },
      onReasoning: (reasoning) => { state.reasoning = reasoning; },
      onImages: (images) => { state.images = images; },
    },
  };
}

test("think tag extraction splits closed and in-progress reasoning", () => {
  assert.deepEqual(extractThinkTags("plain answer"), { reasoning: "", content: "plain answer" });

  assert.deepEqual(extractThinkTags("<think>weighing it</think>the answer"), {
    reasoning: "weighing it",
    content: "the answer",
  });

  assert.deepEqual(extractThinkTags("a<think>one</think>b<think>two</think>c"), {
    reasoning: "one\ntwo",
    content: "abc",
  });

  // A trailing open tag is reasoning that has not finished streaming yet.
  assert.deepEqual(extractThinkTags("visible<think>still going"), {
    reasoning: "still going",
    content: "visible",
  });

  // Leading whitespace in content survives, since this re-runs per token.
  assert.equal(extractThinkTags("<think>x</think>  spaced").content, "  spaced");

  // The pattern is global and module-level, so a second call must not resume
  // from the previous cursor.
  const first = extractThinkTags("<think>a</think>one");
  const second = extractThinkTags("<think>b</think>two");
  assert.deepEqual(first, { reasoning: "a", content: "one" });
  assert.deepEqual(second, { reasoning: "b", content: "two" });
});

test("request builder omits blank generation settings and keeps zero", () => {
  assert.equal(parseNumericSetting(""), undefined);
  assert.equal(parseNumericSetting("  "), undefined);
  assert.equal(parseNumericSetting("abc"), undefined);
  assert.equal(parseNumericSetting("0"), 0);
  assert.equal(parseNumericSetting(" 0.7 "), 0.7);

  const messages = [userMessage("hello"), userMessage("   ")];

  const bare = buildChatRequest(messages, { ...defaultSettings(), modelId: "gpt-5" });
  assert.deepEqual(bare, {
    model: "gpt-5",
    messages: [{ role: "user", content: "hello" }],
    stream: true,
  });

  const configured = buildChatRequest(messages, {
    modelId: "gpt-5",
    systemPrompt: "  be terse  ",
    temperature: "0",
    topP: "",
    stream: false,
  });
  assert.deepEqual(configured.messages[0], { role: "system", content: "be terse" });
  assert.equal(configured.temperature, 0);
  assert.equal("top_p" in configured, false);
  assert.equal(configured.stream, false);

  // Reasoning is display-only and must never be replayed upstream.
  const withReasoning = buildChatRequest(
    [{ id: "a", role: "assistant", content: "answer", reasoning: "hidden", createdAt: 1 }],
    { ...defaultSettings(), modelId: "gpt-5" },
  );
  assert.deepEqual(withReasoning.messages, [{ role: "assistant", content: "answer" }]);
});

test("api error extraction accepts every shape the proxy returns", () => {
  assert.equal(extractApiErrorMessage({ error: { message: "Invalid API Key" } }, 401), "Invalid API Key");
  assert.equal(extractApiErrorMessage({ error: "Model 'x' not found." }, 404), "Model 'x' not found.");
  assert.equal(extractApiErrorMessage({ message: "nope" }, 500), "nope");
  assert.equal(extractApiErrorMessage(null, 502), "Request failed (502)");
  assert.equal(extractApiErrorMessage({ error: {} }, 503), "Request failed (503)");
});

test("attachments become OpenAI content parts and text files are inlined", () => {
  const dataUrl = "data:image/png;base64,AAAA";
  const messages = [
    {
      ...userMessage("look at this"),
      attachments: [
        { id: "f1", type: "text", name: "notes.md", mimeType: "text/markdown", value: "# Title" },
        { id: "i1", type: "image", name: "shot.png", mimeType: "image/png", value: dataUrl },
      ],
    },
  ];

  const request = buildChatRequest(messages, { ...defaultSettings(), modelId: "gpt-5" });
  assert.deepEqual(request.messages, [
    {
      role: "user",
      content: [
        { type: "text", text: "look at this" },
        { type: "text", text: "\n\n[File: notes.md]\n```\n# Title\n```" },
        { type: "image_url", image_url: { url: dataUrl } },
      ],
    },
  ]);

  // A lone text file needs no content parts, so it collapses back to a string.
  const textOnly = buildChatRequest(
    [
      {
        ...userMessage(""),
        attachments: [{ id: "f1", type: "text", name: "a.txt", mimeType: "text/plain", value: "body" }],
      },
    ],
    { ...defaultSettings(), modelId: "gpt-5" },
  );
  assert.equal(textOnly.messages[0].content, "\n\n[File: a.txt]\n```\nbody\n```");

  // An image whose bytes were evicted must not become an empty image part.
  const evicted = buildChatRequest(
    [
      {
        ...userMessage("still here"),
        attachments: [{ id: "i1", type: "image", name: "gone.png", mimeType: "image/png", value: "" }],
      },
    ],
    { ...defaultSettings(), modelId: "gpt-5" },
  );
  assert.equal(evicted.messages[0].content, "still here");

  // A turn whose only payload was an evicted image is dropped, not sent blank.
  const evictedOnly = buildChatRequest(
    [
      {
        ...userMessage(""),
        attachments: [{ id: "i1", type: "image", name: "gone.png", mimeType: "image/png", value: "" }],
      },
      userMessage("and now this"),
    ],
    { ...defaultSettings(), modelId: "gpt-5" },
  );
  assert.deepEqual(evictedOnly.messages, [{ role: "user", content: "and now this" }]);

  // Generated images are display-only and are never replayed upstream.
  const withImages = buildChatRequest(
    [{
      id: "a",
      role: "assistant",
      content: "here",
      reasoning: "",
      createdAt: 1,
      images: [{ id: "g1", mimeType: "image/png", dataUrl }],
    }],
    { ...defaultSettings(), modelId: "gpt-5" },
  );
  assert.deepEqual(withImages.messages, [{ role: "assistant", content: "here" }]);
});

test("an attachment-only turn is still sent and names the chat", () => {
  const conversation = createConversation("gpt-5");
  conversation.messages.push({
    ...userMessage(""),
    attachments: [
      { id: "i1", type: "image", name: "diagram.png", mimeType: "image/png", value: "data:image/png;base64,AA" },
    ],
  });

  assert.equal(conversationTitle(conversation), "diagram.png");
  const request = buildChatRequest(conversation.messages, { ...defaultSettings(), modelId: "gpt-5" });
  assert.equal(request.messages.length, 1);
});

test("persisted attachments keep metadata but drop binary payloads", () => {
  const storage = new MemoryStorage();
  const workspace = createWorkspace();
  const dataUrl = "data:image/png;base64,AAAA";
  workspace.conversations[0].messages.push(
    {
      ...userMessage("with files"),
      attachments: [
        { id: "i1", type: "image", name: "shot.png", mimeType: "image/png", value: dataUrl },
        { id: "f1", type: "text", name: "a.txt", mimeType: "text/plain", value: "x".repeat(30_000) },
      ],
    },
    {
      id: "b",
      role: "assistant",
      content: "made one",
      reasoning: "",
      createdAt: 2,
      images: [{ id: "g1", mimeType: "image/png", dataUrl }],
    },
  );

  assert.equal(writeWorkspace(storage, workspace), "ok");
  const restored = readWorkspace(storage);
  const [user, assistant] = restored.conversations[0].messages;

  // Image bytes live in IndexedDB; only the addressable metadata is persisted.
  assert.deepEqual(user.attachments[0], {
    id: "i1",
    type: "image",
    name: "shot.png",
    mimeType: "image/png",
    value: "",
  });
  assert.equal(assistant.images[0].dataUrl, "");
  assert.equal(assistant.images[0].id, "g1");
  // Text attachments survive, capped so one pasted file cannot fill the quota.
  assert.equal(user.attachments[1].value.length, 20_000);

  // The in-memory workspace is untouched by persistence.
  assert.equal(workspace.conversations[0].messages[0].attachments[0].value, dataUrl);
  assert.deepEqual(referencedPayloadIds(restored), ["i1", "g1"]);
});

test("unusable persisted attachments are dropped rather than trusted", () => {
  const storage = new MemoryStorage();
  storage.setItem(
    "nore-proxy:playground:workspace:v1",
    JSON.stringify({
      version: 1,
      workspace: {
        activeId: "keep",
        settings: { modelId: "gpt-5" },
        conversations: [
          {
            id: "keep",
            messages: [
              {
                id: "a",
                role: "user",
                content: "ok",
                attachments: [
                  { id: "good", type: "image", name: "a.png", mimeType: "image/png", value: "" },
                  { id: "bad-type", type: "video", name: "v.mp4" },
                  { type: "image", name: "no id" },
                  "not an object",
                ],
                images: [{ id: "g", mimeType: "image/png", dataUrl: "" }, { mimeType: "image/png" }],
              },
            ],
          },
        ],
      },
    }),
  );

  const restored = readWorkspace(storage);
  const message = restored.conversations[0].messages[0];
  assert.deepEqual(message.attachments.map((attachment) => attachment.id), ["good"]);
  assert.deepEqual(message.images.map((image) => image.id), ["g"]);
});

test("playground storage keeps the key and the workspace independent", () => {
  const storage = new MemoryStorage();
  const workspace = createWorkspace();
  workspace.settings.modelId = "gpt-5";
  workspace.conversations[0].messages.push(userMessage("hi"));

  writeApiKey(storage, "sk-test");
  assert.equal(writeWorkspace(storage, workspace), "ok");
  assert.deepEqual(readWorkspace(storage), workspace);
  assert.equal(readApiKey(storage), "sk-test");

  clearApiKey(storage);
  assert.equal(readApiKey(storage), "");
  assert.equal(readWorkspace(storage)?.conversations[0].messages.length, 1);

  writeApiKey(storage, "sk-test");
  clearWorkspace(storage);
  assert.equal(readWorkspace(storage), null);
  assert.equal(readApiKey(storage), "sk-test");
});

test("conversation titles fall back to the first message", () => {
  const conversation = createConversation("gpt-5");
  assert.equal(conversationTitle(conversation), "New chat");

  conversation.messages.push(userMessage("explain SSE framing\nsecond line"));
  assert.equal(conversationTitle(conversation), "explain SSE framing");

  conversation.messages[0].content = "x".repeat(80);
  assert.equal(conversationTitle(conversation).endsWith("…"), true);

  conversation.title = "  Named chat  ";
  assert.equal(conversationTitle(conversation), "Named chat");
});

test("playground storage rejects unusable persisted data", () => {
  const storage = new MemoryStorage();

  storage.setItem("nore-proxy:playground:workspace:v1", "not json");
  assert.equal(readWorkspace(storage), null);

  storage.setItem(
    "nore-proxy:playground:workspace:v1",
    JSON.stringify({ version: 99, workspace: createWorkspace() }),
  );
  assert.equal(readWorkspace(storage), null);

  storage.setItem(
    "nore-proxy:playground:workspace:v1",
    JSON.stringify({
      version: 1,
      workspace: {
        activeId: "missing",
        settings: { modelId: "gpt-5" },
        conversations: [
          {
            id: "keep",
            messages: [
              { id: "a", role: "user", content: "ok" },
              { id: "b", role: "system", content: "not a transcript role" },
              { role: "user", content: "no id" },
            ],
          },
          { id: "", messages: [] },
          { id: "no-messages" },
        ],
      },
    }),
  );
  const restored = readWorkspace(storage);
  assert.deepEqual(restored?.conversations.map((conversation) => conversation.id), ["keep"]);
  assert.deepEqual(restored?.conversations[0].messages.map((message) => message.id), ["a"]);
  // An unknown activeId must resolve to a conversation that actually exists.
  assert.equal(restored?.activeId, "keep");
  assert.equal(restored?.settings.systemPrompt, "");
});

test("a single-conversation payload from the previous build is migrated", () => {
  const storage = new MemoryStorage();
  storage.setItem(
    "nore-proxy:playground:conversation:v1",
    JSON.stringify({
      version: 1,
      conversation: {
        messages: [{ id: "old", role: "user", content: "carried over", reasoning: "", createdAt: 5 }],
        settings: { modelId: "gpt-5", systemPrompt: "be terse", temperature: "", topP: "" },
        updatedAt: 9,
      },
    }),
  );

  const migrated = readWorkspace(storage);
  assert.equal(migrated?.conversations.length, 1);
  assert.deepEqual(migrated?.conversations[0].messages.map((message) => message.content), ["carried over"]);
  assert.equal(migrated?.conversations[0].modelId, "gpt-5");
  assert.equal(migrated?.settings.systemPrompt, "be terse");
  assert.equal(migrated?.activeId, migrated?.conversations[0].id);

  // Writing the workspace retires the legacy key rather than duplicating it.
  writeWorkspace(storage, migrated);
  assert.equal(storage.getItem("nore-proxy:playground:conversation:v1"), null);
});

test("workspace write trims rather than failing when storage is full", () => {
  const workspace = createWorkspace();
  for (let index = 0; index < 40; index += 1) {
    const conversation = createConversation("gpt-5");
    conversation.messages = Array.from({ length: 30 }, (_, position) => userMessage(`m${position}`));
    workspace.conversations.push(conversation);
  }

  const full = new MemoryStorage();
  let attempts = 0;
  full.setItem = () => {
    attempts += 1;
    if (attempts === 1) throw new Error("QuotaExceededError");
  };
  assert.equal(writeWorkspace(full, workspace), "trimmed");

  const broken = new MemoryStorage();
  broken.setItem = () => { throw new Error("QuotaExceededError"); };
  assert.equal(writeWorkspace(broken, workspace), "failed");
});

test("message ids stay unique within the same millisecond", () => {
  const ids = new Set();
  for (let index = 0; index < 10_000; index += 1) ids.add(createMessageId());
  assert.equal(ids.size, 10_000);
});

test("stream reader assembles deltas split across chunk boundaries", async () => {
  const restore = stubFetch([
    'data: {"choices":[{"delta":{"content":"Hel"}}]}\n\ndata: {"choices":[{"delta":{"con',
    'tent":"lo"}}]}\n\ndata: {"choices":[{"delta":{"content":" there"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n',
  ]);
  try {
    const { state, handlers } = collectHandlers();
    const result = await streamChatCompletion("sk-test", streamingBody(), new AbortController().signal, handlers);
    assert.equal(result.content, "Hello there");
    assert.equal(result.finishReason, "stop");
    assert.equal(state.content, "Hello there");
  } finally {
    restore();
  }
});

test("stream reader normalizes reasoning fields and inline think tags", async () => {
  const restore = stubFetch([
    'data: {"choices":[{"delta":{"reasoning_content":"step one"}}]}\n\n',
    'data: {"choices":[{"delta":{"content":"<think>step two</think>answer"}}]}\n\n',
    "data: [DONE]\n\n",
  ]);
  try {
    const { state, handlers } = collectHandlers();
    const result = await streamChatCompletion("sk-test", streamingBody(), new AbortController().signal, handlers);
    assert.equal(result.content, "answer");
    assert.equal(state.content, "answer");
    assert.equal(result.reasoning, "step two");
  } finally {
    restore();
  }
});

test("stream reader surfaces a mid-stream error while keeping partial output", async () => {
  const restore = stubFetch([
    'data: {"choices":[{"delta":{"content":"partial"}}]}\n\n',
    'data: {"choices":[{"index":0,"delta":{},"finish_reason":"error"}],"error":{"message":"Upstream refused","type":"server_error","code":502}}\n\n',
    "data: [DONE]\n\n",
  ]);
  try {
    const { state, handlers } = collectHandlers();
    await assert.rejects(
      streamChatCompletion("sk-test", streamingBody(), new AbortController().signal, handlers),
      (error) => {
        assert.ok(error instanceof ChatStreamError);
        assert.equal(error.message, "Upstream refused");
        assert.equal(error.status, 502);
        return true;
      },
    );
    assert.equal(state.content, "partial");
  } finally {
    restore();
  }
});

test("stream reader reads an error frame served with a failing status", async () => {
  const restore = stubFetch(
    ['data: {"choices":[{"index":0,"delta":{},"finish_reason":"error"}],"error":{"message":"No endpoint available"}}\n\n', "data: [DONE]\n\n"],
    { status: 503 },
  );
  try {
    const { handlers } = collectHandlers();
    await assert.rejects(
      streamChatCompletion("sk-test", streamingBody(), new AbortController().signal, handlers),
      { message: "No endpoint available" },
    );
  } finally {
    restore();
  }
});

test("stream reader falls back to the JSON error body", async () => {
  const restore = stubFetch([JSON.stringify({ error: "Model 'ghost' not found." })], {
    status: 404,
    contentType: "application/json",
  });
  try {
    const { handlers } = collectHandlers();
    await assert.rejects(
      streamChatCompletion("sk-test", streamingBody(), new AbortController().signal, handlers),
      { message: "Model 'ghost' not found." },
    );
  } finally {
    restore();
  }
});

test("a non-streaming request reads the whole completion at once", async () => {
  const restore = stubFetch(
    [
      JSON.stringify({
        choices: [
          {
            finish_reason: "stop",
            message: { content: "<think>quietly</think>the answer", reasoning_content: "given" },
          },
        ],
      }),
    ],
    { contentType: "application/json" },
  );
  try {
    const { state, handlers } = collectHandlers();
    const result = await streamChatCompletion(
      "sk-test",
      streamingBody({ stream: false }),
      new AbortController().signal,
      handlers,
    );
    assert.equal(result.content, "the answer");
    assert.equal(state.content, "the answer");
    // Both transports contribute, so the two reasoning sources are joined.
    assert.equal(result.reasoning, "given\nquietly");
    assert.equal(result.finishReason, "stop");
  } finally {
    restore();
  }
});

test("generated images are read from both transports", async () => {
  const png = "data:image/png;base64,AAAA";

  const streamed = stubFetch([
    'data: {"choices":[{"delta":{"content":"here it is"}}]}\n\n',
    `data: {"choices":[{"delta":{"images":[{"type":"image_url","image_url":{"url":"${png}"}}]}}]}\n\n`,
    "data: [DONE]\n\n",
  ]);
  try {
    const { state, handlers } = collectHandlers();
    const result = await streamChatCompletion("sk-test", streamingBody(), new AbortController().signal, handlers);
    assert.equal(result.content, "here it is");
    assert.deepEqual(result.images, [{ mimeType: "image/png", dataUrl: png }]);
    assert.deepEqual(state.images, [{ mimeType: "image/png", dataUrl: png }]);
  } finally {
    streamed();
  }

  // Raw base64 with a separate media type is the other documented shape.
  const whole = stubFetch(
    [
      JSON.stringify({
        choices: [{ finish_reason: "stop", message: { content: "done", images: [{ b64_json: "BBBB", mime_type: "image/webp" }] } }],
      }),
    ],
    { contentType: "application/json" },
  );
  try {
    const { state, handlers } = collectHandlers();
    const result = await streamChatCompletion(
      "sk-test",
      streamingBody({ stream: false }),
      new AbortController().signal,
      handlers,
    );
    assert.deepEqual(result.images, [{ mimeType: "image/webp", dataUrl: "data:image/webp;base64,BBBB" }]);
    assert.deepEqual(state.images, result.images);
  } finally {
    whole();
  }
});

test("image entries that are not usable references are ignored", async () => {
  const restore = stubFetch(
    [
      JSON.stringify({
        choices: [{
          message: {
            content: "text only",
            images: [
              { image_url: { url: "https://example.com/remote.png" } },
              { image_url: { url: "blob:whatever" } },
              { image_url: {} },
              null,
              "not-a-data-url",
              {},
            ],
          },
        }],
      }),
    ],
    { contentType: "application/json" },
  );
  try {
    const { state, handlers } = collectHandlers();
    const result = await streamChatCompletion(
      "sk-test",
      streamingBody({ stream: false }),
      new AbortController().signal,
      handlers,
    );
    // An https reference renders; blob:/opaque/garbage entries are dropped.
    assert.deepEqual(result.images, [{ mimeType: "", dataUrl: "https://example.com/remote.png" }]);
    assert.deepEqual(state.images, result.images);
    assert.equal(result.content, "text only");
  } finally {
    restore();
  }
});

test("a non-streaming error body is surfaced rather than parsed as content", async () => {
  const restore = stubFetch([JSON.stringify({ error: { message: "Upstream refused", code: 502 } })], {
    contentType: "application/json",
  });
  try {
    const { handlers } = collectHandlers();
    await assert.rejects(
      streamChatCompletion("sk-test", streamingBody({ stream: false }), new AbortController().signal, handlers),
      (error) => {
        assert.ok(error instanceof ChatStreamError);
        assert.equal(error.message, "Upstream refused");
        assert.equal(error.status, 502);
        return true;
      },
    );
  } finally {
    restore();
  }
});
