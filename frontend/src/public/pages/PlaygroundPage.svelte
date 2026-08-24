<script lang="ts">
  import { onMount, tick } from "svelte";
  import type { PublicModelsResponse } from "$contracts/models";
  import Composer from "$frontend/components/playground/Composer.svelte";
  import ConversationSidebar from "$frontend/components/playground/ConversationSidebar.svelte";
  import ErrorToast from "$frontend/components/playground/ErrorToast.svelte";
  import ModelDropdown from "$frontend/components/playground/ModelDropdown.svelte";
  import SettingsModal from "$frontend/components/playground/SettingsModal.svelte";
  import Transcript from "$frontend/components/playground/Transcript.svelte";
  import { requestPublicJson } from "$frontend/lib/api/public";
  import { normalizeModels, readModelCache, writeModelCache, type CatalogModel } from "$frontend/lib/models/catalog";
  import { collectGarbage, readPayloads, writePayload } from "$frontend/lib/playground/attachmentStore";
  import { AttachmentError, readAttachment } from "$frontend/lib/playground/attachments";
  import { createMessageId } from "$frontend/lib/playground/ids";
  import { buildChatRequest } from "$frontend/lib/playground/request";
  import {
    clearApiKey,
    conversationTitle,
    createConversation,
    createWorkspace,
    readApiKey,
    readWorkspace,
    referencedPayloadIds,
    writeApiKey,
    writeWorkspace,
  } from "$frontend/lib/playground/storage";
  import { ChatStreamError, streamChatCompletion } from "$frontend/lib/playground/stream";
  import type {
    PlaygroundAttachment,
    PlaygroundMessage,
    PlaygroundWorkspace,
  } from "$frontend/lib/playground/types";

  let apiKey = $state("");
  let workspace = $state<PlaygroundWorkspace>(createWorkspace());
  let draft = $state("");
  let pendingAttachments = $state<PlaygroundAttachment[]>([]);
  let models = $state<CatalogModel[]>([]);
  let chatModelIds = $state<Set<string> | null>(null);
  let modelsLoading = $state(true);
  let modelsError = $state("");
  let streaming = $state(false);
  let errorMessage = $state("");
  let statusMessage = $state("");
  let persistenceFailed = $state(false);
  let storageTrimmed = $state(false);
  let hydrated = $state(false);
  let settingsOpen = $state(false);
  let sidebarOpen = $state(false);

  let controller: AbortController | null = null;
  let persistTimer: ReturnType<typeof setTimeout> | undefined;
  let composer: { focusComposer: () => void } | undefined = $state();
  let settingsModal: { focusKeyInput: () => void } | undefined = $state();

  // Image bytes are kept out of localStorage (quota), so the workspace persists
  // only metadata and IndexedDB holds the data URLs keyed by attachment id. A
  // remote image reference is persisted inline, so it needs no payload row.
  function persistPayloads(message: PlaygroundMessage): void {
    for (const attachment of message.attachments ?? []) {
      if (attachment.type === "image" && attachment.value) void writePayload(attachment.id, attachment.value);
    }
    for (const image of message.images ?? []) {
      if (image.dataUrl.startsWith("data:")) void writePayload(image.id, image.dataUrl);
    }
  }

  /** Fills empty image/attachment values back in from IndexedDB after a reload. */
  async function hydratePayloads(target: PlaygroundWorkspace): Promise<void> {
    const wanted: string[] = [];
    for (const conversation of target.conversations) {
      for (const message of conversation.messages) {
        for (const attachment of message.attachments ?? []) {
          if (attachment.type === "image" && !attachment.value) wanted.push(attachment.id);
        }
        for (const image of message.images ?? []) {
          if (!image.dataUrl) wanted.push(image.id);
        }
      }
    }
    if (wanted.length === 0) return;

    const payloads = await readPayloads(wanted);
    if (payloads.size === 0) return;
    for (const conversation of target.conversations) {
      for (const message of conversation.messages) {
        for (const attachment of message.attachments ?? []) {
          const found = payloads.get(attachment.id);
          if (attachment.type === "image" && !attachment.value && found) attachment.value = found;
        }
        for (const image of message.images ?? []) {
          const found = payloads.get(image.id);
          if (!image.dataUrl && found) image.dataUrl = found;
        }
      }
    }
  }

  /** Removes stored payloads no message references any more. */
  function reconcilePayloads(): void {
    void collectGarbage(referencedPayloadIds(workspace));
  }

  // Image models cannot answer a chat request, but the cached catalog has no
  // type, so the filter only applies once the live response arrives.
  const selectableModels = $derived(
    chatModelIds === null ? models : models.filter((model) => chatModelIds?.has(model.id) ?? true),
  );
  const active = $derived(
    workspace.conversations.find((conversation) => conversation.id === workspace.activeId) ??
      workspace.conversations[0],
  );
  const messages = $derived(active?.messages ?? []);
  const activeModelId = $derived(active?.modelId || workspace.settings.modelId);

  function persist(): void {
    if (persistenceFailed || !hydrated) return;
    const result = writeWorkspace(localStorage, workspace);
    if (result === "trimmed") storageTrimmed = true;
    if (result === "failed") persistenceFailed = true;
  }

  function schedulePersist(): void {
    if (persistTimer) clearTimeout(persistTimer);
    persistTimer = setTimeout(persist, 400);
  }

  function touchActive(): void {
    if (active) active.updatedAt = Date.now();
  }

  function openSettings(): void {
    settingsOpen = true;
  }

  function closeSettings(): void {
    settingsOpen = false;
    persist();
  }

  function submitKey(key: string): void {
    apiKey = key;
    writeApiKey(localStorage, key);
    errorMessage = "";
    statusMessage = "API key saved.";
  }

  function forgetKey(): void {
    apiKey = "";
    clearApiKey(localStorage);
    statusMessage = "API key removed from this browser.";
  }

  function selectModel(modelId: string): void {
    // Stored on the conversation and kept as the default for new ones.
    if (active) active.modelId = modelId;
    workspace.settings.modelId = modelId;
    errorMessage = "";
    schedulePersist();
  }

  function selectConversation(id: string): void {
    if (streaming || id === workspace.activeId) return;
    workspace.activeId = id;
    errorMessage = "";
    draft = "";
    pendingAttachments = [];
    sidebarOpen = false;
    persist();
  }

  function newConversation(): void {
    if (streaming) return;
    const conversation = createConversation(workspace.settings.modelId);
    workspace.conversations.push(conversation);
    workspace.activeId = conversation.id;
    errorMessage = "";
    draft = "";
    pendingAttachments = [];
    sidebarOpen = false;
    statusMessage = "Started a new chat.";
    persist();
    void tick().then(() => composer?.focusComposer());
  }

  // Safe during a stream: a title is not part of the transcript being written.
  function renameConversation(id: string, title: string): void {
    const conversation = workspace.conversations.find((entry) => entry.id === id);
    if (!conversation) return;
    conversation.title = title;
    persist();
  }

  function deleteConversation(id: string): void {
    if (streaming) return;
    const index = workspace.conversations.findIndex((conversation) => conversation.id === id);
    if (index === -1) return;

    workspace.conversations.splice(index, 1);
    // The workspace always holds at least one conversation to talk into.
    if (workspace.conversations.length === 0) {
      const replacement = createConversation(workspace.settings.modelId);
      workspace.conversations.push(replacement);
      workspace.activeId = replacement.id;
    } else if (workspace.activeId === id) {
      const next = [...workspace.conversations].sort((left, right) => right.updatedAt - left.updatedAt)[0];
      workspace.activeId = next.id;
    }
    statusMessage = "Chat deleted.";
    persist();
    reconcilePayloads();
  }

  async function runTurn(): Promise<void> {
    if (streaming || !active) return;
    errorMessage = "";
    statusMessage = "Generating response…";
    streaming = true;
    controller = new AbortController();

    const conversation = active;
    const assistant: PlaygroundMessage = {
      id: createMessageId(),
      role: "assistant",
      content: "",
      reasoning: "",
      createdAt: Date.now(),
    };
    conversation.messages.push(assistant);
    // Holding the index is safe only because switching chats and every message
    // mutation are disabled while streaming is true.
    const index = conversation.messages.length - 1;
    const request = buildChatRequest(conversation.messages.slice(0, index), {
      ...workspace.settings,
      modelId: activeModelId,
    });

    try {
      await streamChatCompletion(apiKey, request, controller.signal, {
        onContentDelta: (delta) => {
          conversation.messages[index].content += delta;
        },
        onContentReplace: (content) => {
          conversation.messages[index].content = content;
        },
        onReasoning: (reasoning) => {
          conversation.messages[index].reasoning = reasoning;
        },
        onImages: (images) => {
          // Ids are assigned once per position so re-renders keep their keys and
          // the payload written to IndexedDB stays addressable.
          const existing = conversation.messages[index].images ?? [];
          conversation.messages[index].images = images.map((image, position) => ({
            id: existing[position]?.id ?? createMessageId(),
            mimeType: image.mimeType,
            dataUrl: image.dataUrl,
          }));
        },
      });
      statusMessage = "Response complete.";
    } catch (error) {
      const partial = conversation.messages[index];
      const hasOutput = Boolean(partial?.content || partial?.reasoning || partial?.images?.length);

      if (error instanceof DOMException && error.name === "AbortError") {
        statusMessage = hasOutput ? "Stopped." : "Stopped before any output.";
        if (!hasOutput) conversation.messages.splice(index, 1);
      } else {
        const message = error instanceof Error ? error.message : "The request failed.";
        statusMessage = "The request failed.";
        if (hasOutput) {
          // Keep whatever arrived and attach the reason to that turn.
          partial.error = message;
        } else {
          conversation.messages.splice(index, 1);
          errorMessage = message;
        }

        if (error instanceof ChatStreamError) {
          if (error.status === 401) {
            errorMessage = `${message} Check the key and try again.`;
            forgetKey();
            openSettings();
            void tick().then(() => settingsModal?.focusKeyInput());
          }
          if (error.status === 404) {
            conversation.modelId = "";
            workspace.settings.modelId = "";
          }
        }
      }
    } finally {
      streaming = false;
      controller = null;
      persistPayloads(conversation.messages[index]);
      touchActive();
      persist();
    }
  }

  /** Returns false and explains what is missing instead of silently refusing. */
  function readyToSend(): boolean {
    if (!apiKey) {
      errorMessage = "Add a client API key in Settings before sending a message.";
      statusMessage = "An API key is required.";
      openSettings();
      void tick().then(() => settingsModal?.focusKeyInput());
      return false;
    }
    if (!activeModelId) {
      errorMessage = "Choose a model before sending a message.";
      statusMessage = "A model is required.";
      return false;
    }
    return true;
  }

  function send(): void {
    const content = draft.trim();
    const attachments = pendingAttachments;
    if ((!content && attachments.length === 0) || streaming || !active) return;
    if (!readyToSend()) return;

    if (!active.modelId) active.modelId = activeModelId;
    const message: PlaygroundMessage = {
      id: createMessageId(),
      role: "user",
      content,
      reasoning: "",
      createdAt: Date.now(),
    };
    if (attachments.length > 0) message.attachments = attachments;
    active.messages.push(message);
    persistPayloads(message);
    touchActive();
    draft = "";
    pendingAttachments = [];
    void runTurn();
  }

  async function addAttachments(files: File[]): Promise<void> {
    const added: PlaygroundAttachment[] = [];
    for (const file of files) {
      try {
        added.push(await readAttachment(file));
      } catch (error) {
        errorMessage = error instanceof AttachmentError ? error.message : `Could not read ${file.name}.`;
      }
    }
    if (added.length > 0) pendingAttachments = [...pendingAttachments, ...added];
  }

  function removeAttachment(id: string): void {
    pendingAttachments = pendingAttachments.filter((attachment) => attachment.id !== id);
  }

  function stop(): void {
    controller?.abort();
  }

  function deleteMessage(id: string): void {
    if (streaming || !active) return;
    const index = active.messages.findIndex((message) => message.id === id);
    if (index === -1) return;
    active.messages.splice(index, 1);
    statusMessage = "Message deleted.";
    touchActive();
    persist();
    reconcilePayloads();
  }

  /**
   * A resend replays stored history, so any image whose bytes the browser
   * evicted would be sent as an empty part. Refuse instead and name the file.
   */
  function firstUnavailableImage(upTo: number): PlaygroundAttachment | null {
    if (!active) return null;
    for (let cursor = 0; cursor <= upTo; cursor += 1) {
      for (const attachment of active.messages[cursor].attachments ?? []) {
        if (attachment.type === "image" && !attachment.value) return attachment;
      }
    }
    return null;
  }

  /** Everything after the given index is discarded before the resend. */
  function truncateAndRun(index: number): void {
    if (!active || !readyToSend()) return;
    const missing = firstUnavailableImage(index);
    if (missing) {
      errorMessage = `Reattach ${missing.name || "the image"} before resending this message.`;
      return;
    }
    active.messages.splice(index + 1);
    persist();
    reconcilePayloads();
    void runTurn();
  }

  function resend(id: string): void {
    if (streaming || !active) return;
    const index = active.messages.findIndex((message) => message.id === id);
    if (index === -1) return;

    if (active.messages[index].role === "user") {
      truncateAndRun(index);
      return;
    }
    // Resending an answer means re-asking the question that produced it.
    for (let cursor = index - 1; cursor >= 0; cursor -= 1) {
      if (active.messages[cursor].role === "user") {
        truncateAndRun(cursor);
        return;
      }
    }
    errorMessage = "There is no earlier message from you to resend.";
  }

  function editMessage(id: string, content: string): void {
    if (streaming || !active) return;
    const index = active.messages.findIndex((message) => message.id === id);
    if (index === -1) return;

    active.messages[index].content = content;
    delete active.messages[index].error;
    touchActive();
    persist();
    // Saving only rewrites history. Resend is the explicit way to re-run it.
    statusMessage = "Message updated.";
  }

  onMount(() => {
    apiKey = readApiKey(localStorage);
    const stored = readWorkspace(localStorage);
    if (stored) workspace = stored;
    // Persisting before this point would overwrite stored chats with the empty
    // defaults the effects see on first run.
    hydrated = true;

    const controller = new AbortController();
    // Image bytes live in IndexedDB, so a restored transcript renders its
    // placeholders first and fills them in once the payloads are read back.
    void hydratePayloads(workspace).then(() => {
      if (!controller.signal.aborted) reconcilePayloads();
    });
    const cached = readModelCache(localStorage);
    if (cached) {
      models = cached;
      modelsLoading = false;
    }

    void requestPublicJson<PublicModelsResponse>("/v1/models", {
      cache: "no-store",
      signal: controller.signal,
    })
      .then((response) => {
        const fresh = normalizeModels(response);
        chatModelIds = new Set(
          (response.data ?? []).filter((model) => (model.type ?? "chat") === "chat").map((model) => model.id),
        );
        if (fresh.length === 0) {
          models = [];
          modelsError = "No models are currently available.";
          return;
        }
        models = fresh;
        modelsError = "";
        try {
          writeModelCache(localStorage, fresh);
        } catch {
          // The catalog stays usable in memory when storage is unavailable.
        }
      })
      .catch((error: unknown) => {
        if (!controller.signal.aborted && !cached) {
          modelsError = error instanceof Error ? error.message : "Failed to load models.";
        }
      })
      .finally(() => {
        if (!controller.signal.aborted) modelsLoading = false;
      });

    const handleEscape = (event: KeyboardEvent): void => {
      if (event.key !== "Escape" || settingsOpen) return;
      if (streaming) stop();
      else if (sidebarOpen) sidebarOpen = false;
    };
    window.addEventListener("keydown", handleEscape);

    return () => {
      controller.abort();
      window.removeEventListener("keydown", handleEscape);
      if (persistTimer) clearTimeout(persistTimer);
    };
  });

  $effect(() => {
    void workspace.settings.systemPrompt;
    void workspace.settings.temperature;
    void workspace.settings.topP;
    schedulePersist();
  });
</script>

<div class="playground">
  <div class:open={sidebarOpen} class="side">
    <ConversationSidebar
      conversations={workspace.conversations}
      activeId={workspace.activeId}
      disabled={streaming}
      keyMissing={!apiKey}
      onSelect={selectConversation}
      onCreate={newConversation}
      onRename={renameConversation}
      onDelete={deleteConversation}
      onOpenSettings={openSettings}
    />
  </div>

  <section class="chat">
    <header class="bar">
      <button
        class="drawer-toggle"
        type="button"
        aria-expanded={sidebarOpen}
        onclick={() => (sidebarOpen = !sidebarOpen)}
      >
        Chats
      </button>
      <ModelDropdown
        models={selectableModels}
        selectedId={activeModelId}
        loading={modelsLoading}
        errorMessage={modelsError}
        onSelect={selectModel}
      />
      <h1 class="chat-title">{active ? conversationTitle(active) : "New chat"}</h1>
    </header>

    {#if persistenceFailed}
      <div class="notice">This browser will not store your chats, so they disappear when you leave the page.</div>
    {:else if storageTrimmed}
      <div class="notice">Older chats were dropped from storage to stay within the browser's limit.</div>
    {/if}

    <Transcript
      {messages}
      {streaming}
      {statusMessage}
      onEdit={editMessage}
      onDelete={deleteMessage}
      onResend={resend}
    />

    <Composer
      bind:this={composer}
      bind:value={draft}
      attachments={pendingAttachments}
      {streaming}
      onSend={send}
      onStop={stop}
      onAttach={addAttachments}
      onRemoveAttachment={removeAttachment}
    />
  </section>
</div>

<SettingsModal
  bind:this={settingsModal}
  bind:settings={workspace.settings}
  open={settingsOpen}
  storedKey={apiKey}
  disabled={streaming}
  onSubmitKey={submitKey}
  onForgetKey={forgetKey}
  onClose={closeSettings}
/>

<ErrorToast message={errorMessage} onDismiss={() => (errorMessage = "")} />

<style>
  .playground {
    flex: 1;
    min-height: 0;
    min-width: 0;
    display: grid;
    grid-template-columns: 310px minmax(0, 1fr);
    gap: 8px;
    /* The page itself never scrolls; only the transcript and the chat list do. */
    overflow: hidden;
  }

  .side { min-height: 0; min-width: 0; display: flex; }

  .chat {
    min-height: 0;
    min-width: 0;
    display: flex;
    flex-direction: column;
    gap: 12px;
    overflow: hidden;
  }

  .bar {
    display: flex;
    align-items: center;
    gap: 12px;
    min-width: 0;
  }

  .chat-title {
    flex: 1;
    min-width: 0;
    margin: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    color: var(--muted);
    font: 500 17px/1.3 Georgia, serif;
    letter-spacing: normal;
    text-align: right;
  }

  .drawer-toggle {
    display: none;
    min-height: 38px;
    padding: 8px 14px;
    border: 1px solid var(--line);
    border-radius: 8px;
    background: var(--surface);
    color: var(--muted);
    font-size: 12.5px;
    cursor: pointer;
  }

  .notice {
    margin: 0;
    padding: 12px 15px;
    border: 1px solid var(--line);
    border-radius: 8px;
    background: var(--accent-soft);
    color: var(--accent-ink);
    font-size: 12.5px;
  }

  @media (max-width: 900px) {
    .playground { grid-template-columns: minmax(0, 1fr); }
    .drawer-toggle { display: inline-flex; }
    /* The sidebar becomes a disclosure above the chat rather than a column. */
    .side { display: none; }
    .side.open { display: flex; max-height: 60vh; }
    .side.open + .chat { display: none; }
  }
</style>
