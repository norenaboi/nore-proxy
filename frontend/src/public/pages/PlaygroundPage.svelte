<script lang="ts">
  import { onMount, tick } from "svelte";
  import type { ImageApiFormat } from "$contracts/apiFormats";
  import type { PublicModelsResponse } from "$contracts/models";
  import Composer from "$frontend/components/playground/Composer.svelte";
  import ConversationSidebar from "$frontend/components/playground/ConversationSidebar.svelte";
  import ErrorToast from "$frontend/components/playground/ErrorToast.svelte";
  import ImageStage from "$frontend/components/playground/ImageStage.svelte";
  import ModelDropdown from "$frontend/components/playground/ModelDropdown.svelte";
  import SettingsModal from "$frontend/components/playground/SettingsModal.svelte";
  import Transcript from "$frontend/components/playground/Transcript.svelte";
  import { requestPublicJson } from "$frontend/lib/api/public";
  import { normalizeModels, readModelCache, writeModelCache, type CatalogModel } from "$frontend/lib/models/catalog";
  import { collectGarbage, readPayloads, writePayload } from "$frontend/lib/playground/attachmentStore";
  import { AttachmentError, readAttachment } from "$frontend/lib/playground/attachments";
  import { createMessageId } from "$frontend/lib/playground/ids";
  import {
    ImageGenerationError,
    generateImageBatch,
    imageCountOf,
    type ImageSettings,
    type ImageSlot,
  } from "$frontend/lib/playground/images";
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
  import { ChatStreamError, streamChatCompletion, type StreamImage } from "$frontend/lib/playground/stream";
  import type {
    PlaygroundAttachment,
    PlaygroundMessage,
    PlaygroundWorkspace,
  } from "$frontend/lib/playground/types";

  let apiKey = $state("");
  let workspace = $state<PlaygroundWorkspace>(createWorkspace());
  let draft = $state("");
  let pendingAttachments = $state<PlaygroundAttachment[]>([]);
  let pendingImageAttachments = $state<PlaygroundAttachment[]>([]);
  let models = $state<CatalogModel[]>([]);
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
  // Image-mode output and references are deliberately unpersisted.
  let imageSlots = $state<ImageSlot[]>([]);
  let imageSettings = $state<ImageSettings>({ aspectRatio: "", imageSize: "", size: "", quality: "", count: "1" });

  interface ImageRunSnapshot {
    prompt: string;
    modelId: string;
    format?: ImageApiFormat;
    settings: ImageSettings;
    references: PlaygroundAttachment[];
  }

  const imageRetrySnapshots = new Map<string, ImageRunSnapshot>();
  const imageControllers = new Set<AbortController>();
  let imageBatchGenerating = $state(false);
  let activeImageOperations = $state(0);
  let latestImageOperation = 0;

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

  // Embedding models answer no playground request. Text and image models are
  // both selectable; picking an image model switches the page into image mode.
  const selectableModels = $derived(models.filter((model) => model.modality !== "embedding"));
  const active = $derived(
    workspace.conversations.find((conversation) => conversation.id === workspace.activeId) ??
      workspace.conversations[0],
  );
  const messages = $derived(active?.messages ?? []);
  const activeModelId = $derived(active?.modelId || workspace.settings.modelId);
  const imageFormat = $derived(models.find((model) => model.id === activeModelId)?.image_api_format);
  const isImageModel = $derived(
    models.find((model) => model.id === activeModelId)?.modality === "image",
  );

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

  function imageLayout(settings: ImageSettings): ImageSlot["layout"] {
    const ratio = settings.aspectRatio || settings.size;
    const match = ratio?.match(/^(\d+)\s*[:x]\s*(\d+)$/i);
    if (!match) return "default";
    const width = Number(match[1]);
    const height = Number(match[2]);
    if (width < height) return "portrait";
    if (width > height) return "landscape";
    return "default";
  }

  function updateImageSlot(id: string, update: (slot: ImageSlot) => ImageSlot): void {
    imageSlots = imageSlots.map((slot) => slot.id === id ? update(slot) : slot);
  }

  function readyTargetCount(targetSlotIds: string[]): number {
    const targets = new Set(targetSlotIds);
    return imageSlots.filter((slot) => targets.has(slot.id) && slot.state === "ready").length;
  }

  /** Runs a new image batch or regenerates selected failed slots in place. */
  async function runImageTurn(
    snapshot: ImageRunSnapshot,
    targetSlotIds: string[],
    kind: "batch" | "retry",
  ): Promise<void> {
    const operation = ++latestImageOperation;
    const imageController = new AbortController();
    imageControllers.add(imageController);
    activeImageOperations += 1;
    if (kind === "batch") imageBatchGenerating = true;
    errorMessage = "";
    statusMessage = targetSlotIds.length === 1 ? "Generating image…" : `Generating ${targetSlotIds.length} images…`;
    const reportStatus = (message: string): void => {
      if (operation === latestImageOperation) statusMessage = message;
    };
    const reportError = (message: string): void => {
      if (operation === latestImageOperation) errorMessage = message;
    };
    for (const id of targetSlotIds) {
      imageRetrySnapshots.delete(id);
      updateImageSlot(id, (slot) => ({ ...slot, state: "loading", image: undefined }));
    }

    const unfilled = [...targetSlotIds];
    const publishImages = (images: StreamImage[]): void => {
      for (const image of images) {
        const id = unfilled.shift();
        if (id === undefined) break;
        updateImageSlot(id, (slot) => ({ ...slot, state: "ready", image }));
      }
      const ready = readyTargetCount(targetSlotIds);
      if (operation === latestImageOperation) {
        statusMessage = ready === targetSlotIds.length
          ? (ready === 1 ? "Image ready." : `${ready} images ready.`)
          : `${ready} of ${targetSlotIds.length} images ready; generating the rest…`;
      }
    };

    const failSlots = (ids: string[], retryable: boolean): void => {
      for (const id of ids) {
        updateImageSlot(id, (slot) => ({ ...slot, state: "failed", image: undefined }));
        if (retryable) imageRetrySnapshots.set(id, snapshot);
        else imageRetrySnapshots.delete(id);
      }
    };

    try {
      const { images, failed } = await generateImageBatch(
        apiKey,
        snapshot.modelId,
        snapshot.prompt,
        imageController.signal,
        snapshot.settings,
        snapshot.format,
        {
          references: snapshot.references,
          count: targetSlotIds.length,
          onImages: publishImages,
        },
      );
      // The callback publishes normal responses. This fallback also makes a
      // custom batch implementation that skips callbacks safe to display.
      if (unfilled.length === targetSlotIds.length && images.length > 0) publishImages(images);

      const failedSlotIds = targetSlotIds.filter(
        (id) => imageSlots.find((slot) => slot.id === id)?.state !== "ready",
      );
      if (images.length === 0 && failed === 0) {
        failSlots(failedSlotIds, true);
        reportStatus("The model returned no image.");
        reportError("The model returned no image.");
      } else if (failed > 0) {
        failSlots(failedSlotIds, true);
        const ready = readyTargetCount(targetSlotIds);
        reportStatus(`${ready} of ${targetSlotIds.length} images ready.`);
        reportError(failed === 1
          ? "One generation failed; retry it from its grid cell."
          : `${failed} generations failed; retry them from their grid cells.`);
      } else if (failedSlotIds.length > 0) {
        failSlots(failedSlotIds, true);
        reportStatus(`${readyTargetCount(targetSlotIds)} of ${targetSlotIds.length} images ready.`);
        reportError("The model returned fewer images than requested.");
      } else {
        const ready = readyTargetCount(targetSlotIds);
        reportStatus(ready === 1 ? "Image ready." : `${ready} images ready.`);
      }
    } catch (error) {
      const failedSlotIds = targetSlotIds.filter(
        (id) => imageSlots.find((slot) => slot.id === id)?.state !== "ready",
      );
      const aborted = error instanceof DOMException && error.name === "AbortError";
      const terminal = error instanceof ImageGenerationError && (error.status === 401 || error.status === 404);
      failSlots(failedSlotIds, !terminal);

      const ready = readyTargetCount(targetSlotIds);
      if (aborted) {
        reportStatus(ready > 0 ? "Stopped; showing finished images." : "Stopped.");
      } else {
        const message = error instanceof Error ? error.message : "The request failed.";
        reportStatus(ready > 0 ? `${ready} of ${targetSlotIds.length} images ready; the rest failed.` : "The request failed.");
        reportError(message);

        if (operation === latestImageOperation && error instanceof ImageGenerationError) {
          if (error.status === 401) {
            reportError(`${message} Check the key and try again.`);
            forgetKey();
            openSettings();
            void tick().then(() => settingsModal?.focusKeyInput());
          }
          if (error.status === 404) {
            if (active) active.modelId = "";
            workspace.settings.modelId = "";
            persist();
          }
        }
      }
    } finally {
      imageControllers.delete(imageController);
      activeImageOperations = Math.max(0, activeImageOperations - 1);
      if (kind === "batch") imageBatchGenerating = false;
    }
  }

  function sendImagePrompt(): void {
    // Unlike chat, the draft and references stay available for adjustments.
    const prompt = draft.trim();
    if (!prompt || imageBatchGenerating) return;
    if (!readyToSend()) return;
    const settings = { ...imageSettings };
    const snapshot: ImageRunSnapshot = {
      prompt,
      modelId: activeModelId,
      format: imageFormat,
      settings,
      references: pendingImageAttachments.map((attachment) => ({ ...attachment })),
    };
    const count = imageCountOf(settings);
    const batchId = createMessageId();
    const layout = imageLayout(settings);
    const newSlots: ImageSlot[] = Array.from({ length: count }, () => ({
      id: createMessageId(),
      batchId,
      prompt,
      layout,
      state: "loading",
    }));
    imageSlots = [...newSlots, ...imageSlots];
    void tick().then(() => {
      const stage = document.querySelector<HTMLElement>("[data-image-stage]");
      if (stage) stage.scrollTop = 0;
    });
    void runImageTurn(snapshot, newSlots.map((slot) => slot.id), "batch");
  }

  function retryImageSlot(slotId: string): void {
    if (!readyToSend()) return;
    const slot = imageSlots.find((candidate) => candidate.id === slotId);
    const snapshot = imageRetrySnapshots.get(slotId);
    if (!snapshot || slot?.state !== "failed") return;
    void runImageTurn(snapshot, [slotId], "retry");
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
    if (isImageModel) {
      sendImagePrompt();
      return;
    }
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

  async function addImageAttachments(files: File[]): Promise<void> {
    const added: PlaygroundAttachment[] = [];
    for (const file of files) {
      try {
        const attachment = await readAttachment(file);
        if (attachment.type !== "image") {
          errorMessage = `${file.name || "That file"} is not an image.`;
          continue;
        }
        added.push(attachment);
      } catch (error) {
        errorMessage = error instanceof AttachmentError ? error.message : `Could not read ${file.name}.`;
      }
    }
    if (added.length > 0) pendingImageAttachments = [...pendingImageAttachments, ...added];
  }

  function removeImageAttachment(id: string): void {
    pendingImageAttachments = pendingImageAttachments.filter((attachment) => attachment.id !== id);
  }

  function stop(): void {
    controller?.abort();
    for (const imageController of imageControllers) imageController.abort();
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
      if (streaming || activeImageOperations > 0) stop();
      else if (sidebarOpen) sidebarOpen = false;
    };
    window.addEventListener("keydown", handleEscape);

    return () => {
      controller.abort();
      for (const imageController of imageControllers) imageController.abort();
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

<div class:image-mode={isImageModel} class="playground">
  {#if isImageModel}
    <aside class="image-input" aria-label="Image generation controls">
      <Composer
        bind:this={composer}
        bind:value={draft}
        attachments={pendingImageAttachments}
        streaming={imageBatchGenerating}
        stoppable={activeImageOperations > 0 && !imageBatchGenerating}
        sidebar
        allowAttachments
        attachmentAccept="image/*"
        attachmentLabel="Add reference images"
        attachmentTitle="Add one or more reference images"
        requireText
        placeholder="Describe the image to generate…"
        onOpenSettings={openSettings}
        onSend={send}
        onStop={stop}
        onAttach={addImageAttachments}
        onRemoveAttachment={removeImageAttachment}
      >
        {#snippet controls()}
          {#if imageFormat}
          <fieldset class="image-settings" disabled={imageBatchGenerating}>
            <legend>Image settings</legend>
            <label for="image-count">Images</label>
            <select id="image-count" bind:value={imageSettings.count}>
              {#each ["1", "2", "3", "4", "5", "6", "7", "8"] as option}
                <option value={option}>{option}</option>
              {/each}
            </select>
            {#if imageFormat === "gemini-interactions"}
            <label for="image-ratio">Aspect ratio</label>
            <select id="image-ratio" bind:value={imageSettings.aspectRatio}>
              <option value="">Model default</option>
              {#each ["1:1", "3:2", "2:3", "3:4", "4:3", "4:5", "5:4", "9:16", "16:9", "21:9"] as ratio}
                <option value={ratio}>{ratio}</option>
              {/each}
            </select>
            <label for="image-size">Resolution</label>
            <select id="image-size" bind:value={imageSettings.imageSize}>
              <option value="">Model default</option>
              {#each ["1K", "2K", "4K"] as size}
                <option value={size}>{size}</option>
              {/each}
            </select>
            {:else}
              <label for="image-pixel-size">Size</label>
              <input id="image-pixel-size" list="image-sizes" bind:value={imageSettings.size} placeholder="Model default" autocomplete="off" />
              <datalist id="image-sizes">
                {#each ["1024x1024", "1536x1024", "1024x1536", "1792x1024", "1024x1792", "512x512", "256x256"] as size}
                  <option value={size}></option>
                {/each}
              </datalist>
              <label for="image-quality">Quality</label>
              <select id="image-quality" bind:value={imageSettings.quality}>
                <option value="">Model default</option>
                {#each ["low", "medium", "high", "standard", "hd"] as quality}
                  <option value={quality}>{quality}</option>
                {/each}
              </select>
            {/if}
          </fieldset>
          {/if}
          <p class="reference-help">
            {imageFormat === "gemini-interactions"
              ? "Reference images are sent directly as Gemini image input."
              : "Reference images use input_references; support depends on the provider and model."}
          </p>
        {/snippet}
      </Composer>
    </aside>
  {:else}
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
  {/if}

  <section class="chat">
    <header class="bar">
      {#if !isImageModel}
        <button
          class="drawer-toggle"
          type="button"
          aria-expanded={sidebarOpen}
          onclick={() => (sidebarOpen = !sidebarOpen)}
        >
          Chats
        </button>
      {/if}
      <ModelDropdown
        models={selectableModels}
        selectedId={activeModelId}
        loading={modelsLoading}
        errorMessage={modelsError}
        onSelect={selectModel}
      />
      <h1 class="chat-title">
        {isImageModel ? "Image generation" : active ? conversationTitle(active) : "New chat"}
      </h1>
    </header>

    {#if persistenceFailed}
      <div class="notice">This browser will not store your chats, so they disappear when you leave the page.</div>
    {:else if storageTrimmed}
      <div class="notice">Older chats were dropped from storage to stay within the browser's limit.</div>
    {/if}

    {#if isImageModel}
      <ImageStage
        slots={imageSlots}
        generating={imageBatchGenerating}
        {statusMessage}
        onRetry={retryImageSlot}
      />
    {:else}
      <Transcript
        {messages}
        {streaming}
        {statusMessage}
        onEdit={editMessage}
        onDelete={deleteMessage}
        onResend={resend}
      />
    {/if}

    {#if !isImageModel}
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
    {/if}
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

  .image-input { display: flex; min-width: 0; min-height: 0; }
  .image-settings { display: grid; gap: 8px; margin: 0; padding: 12px 0 0; border: 0; border-top: 1px solid var(--line); min-width: 0; }
  .image-settings legend { padding: 0 6px 0 0; color: var(--muted); font-size: 12px; }
  .image-settings label { font-size: 12px; color: var(--muted); }
  .image-settings select, .image-settings input { width: 100%; min-width: 0; padding: 9px 10px; border: 1px solid var(--line); border-radius: 8px; background: var(--surface); color: var(--ink); font: inherit; }
  .reference-help { margin: 2px 0 0; color: var(--muted); font-size: 11.5px; line-height: 1.5; }

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
    .playground.image-mode { overflow-y: auto; grid-template-rows: auto minmax(360px, 1fr); }
    .image-input { min-height: 440px; }
    .drawer-toggle { display: inline-flex; }
    /* The sidebar becomes a disclosure above the chat rather than a column. */
    .side { display: none; }
    .side.open { display: flex; max-height: 60vh; }
    .side.open + .chat { display: none; }
  }
</style>
