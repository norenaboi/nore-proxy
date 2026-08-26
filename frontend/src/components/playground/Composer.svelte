<script lang="ts">
  import { tick } from "svelte";
  import { ATTACHMENT_ACCEPT } from "$frontend/lib/playground/attachments";
  import type { PlaygroundAttachment } from "$frontend/lib/playground/types";

  let {
    value = $bindable(),
    attachments,
    streaming,
    onSend,
    onStop,
    onAttach,
    onRemoveAttachment,
  }: {
    value: string;
    attachments: PlaygroundAttachment[];
    streaming: boolean;
    onSend: () => void;
    onStop: () => void;
    onAttach: (files: File[]) => void;
    onRemoveAttachment: (id: string) => void;
  } = $props();

  let textarea: HTMLTextAreaElement | undefined = $state();
  let fileInput: HTMLInputElement | undefined = $state();
  let dragging = $state(false);
  // Dragging over a child fires dragleave on the parent, so the nesting depth
  // is counted rather than toggling a flag on every event.
  let dragDepth = 0;

  const canSend = $derived(value.trim().length > 0 || attachments.length > 0);

  export function focusComposer(): void {
    textarea?.focus();
  }

  function autoGrow(): void {
    if (!textarea) return;
    // Height must collapse before scrollHeight is read, or it only ever grows.
    textarea.style.height = "auto";
    textarea.style.height = `${Math.min(textarea.scrollHeight, 220)}px`;
  }

  function submit(): void {
    // Sending without a key or model stays allowed so the page can explain what
    // is missing rather than presenting a dead button.
    if (streaming || !canSend) return;
    onSend();
    // The parent clears the value, so the box has to be re-measured after.
    void tick().then(autoGrow);
  }

  function handleKeydown(event: KeyboardEvent): void {
    // isComposing keeps an IME's Enter-to-commit from sending a half-typed word.
    if (event.key !== "Enter" || event.shiftKey || event.isComposing) return;
    event.preventDefault();
    submit();
  }

  function pickFiles(): void {
    fileInput?.click();
  }

  function handleFileInput(event: Event): void {
    const input = event.currentTarget as HTMLInputElement;
    const files = [...(input.files ?? [])];
    // Clearing lets the same file be picked twice in a row.
    input.value = "";
    if (files.length > 0) onAttach(files);
  }

  function handleDragEnter(event: DragEvent): void {
    if (streaming || !event.dataTransfer?.types.includes("Files")) return;
    dragDepth += 1;
    dragging = true;
  }

  function handleDragOver(event: DragEvent): void {
    if (streaming || !event.dataTransfer?.types.includes("Files")) return;
    // Without this the browser navigates to the dropped file instead.
    event.preventDefault();
    event.dataTransfer.dropEffect = "copy";
  }

  function handleDragLeave(): void {
    dragDepth = Math.max(0, dragDepth - 1);
    if (dragDepth === 0) dragging = false;
  }

  function handleDrop(event: DragEvent): void {
    dragDepth = 0;
    dragging = false;
    if (streaming) return;
    const files = [...(event.dataTransfer?.files ?? [])];
    if (files.length === 0) return;
    event.preventDefault();
    onAttach(files);
  }

  /** Pasted screenshots arrive as files; pasted text is left to the textarea. */
  function handlePaste(event: ClipboardEvent): void {
    if (streaming) return;
    const files = [...(event.clipboardData?.items ?? [])]
      .filter((item) => item.kind === "file")
      .map((item) => item.getAsFile())
      .filter((file): file is File => file !== null);
    if (files.length === 0) return;
    event.preventDefault();
    onAttach(files);
  }
</script>

<!-- The drag handlers are a pointer-only shortcut for the "Attach files" button
     below, which stays the keyboard and screen-reader path. The role gives the
     control cluster an identity so the handlers are not on an anonymous div. -->
<div
  class:dragging
  class="composer panel"
  role="group"
  aria-label="Message composer"
  ondragenter={handleDragEnter}
  ondragover={handleDragOver}
  ondragleave={handleDragLeave}
  ondrop={handleDrop}
>
  {#if attachments.length > 0}
    <ul class="chips">
      {#each attachments as attachment (attachment.id)}
        <li class="chip">
          {#if attachment.type === "image" && attachment.value}
            <img class="thumb" src={attachment.value} alt="" />
          {:else}
            <span class="kind" aria-hidden="true">{attachment.type === "image" ? "IMG" : "TXT"}</span>
          {/if}
          <span class="chip-name" title={attachment.name}>{attachment.name}</span>
          <button
            class="chip-remove"
            type="button"
            aria-label={`Remove ${attachment.name}`}
            onclick={() => onRemoveAttachment(attachment.id)}
          >
            ×
          </button>
        </li>
      {/each}
    </ul>
  {/if}

  <div class="row">
    <label class="visually-hidden" for="playground-composer">Message</label>
    <textarea
      bind:this={textarea}
      bind:value
      id="playground-composer"
      class="composer-input"
      rows="2"
      placeholder="Send a message… (Enter to send, Shift+Enter for a new line)"
      oninput={autoGrow}
      onkeydown={handleKeydown}
      onpaste={handlePaste}
    ></textarea>
    <div class="composer-actions">
      <input
        bind:this={fileInput}
        class="visually-hidden"
        type="file"
        multiple
        accept={ATTACHMENT_ACCEPT}
        onchange={handleFileInput}
      />
      <button
        class="composer-attach"
        type="button"
        disabled={streaming}
        aria-label="Attach files"
        title="Attach text files or images"
        onclick={pickFiles}
      >
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden="true">
          <path
            d="M21.4 11.05 12.25 20.2a5.5 5.5 0 0 1-7.78-7.78l8.49-8.49a3.67 3.67 0 0 1 5.18 5.18l-8.49 8.49a1.83 1.83 0 0 1-2.6-2.6l7.79-7.78"
            stroke="currentColor"
            stroke-width="1.8"
            stroke-linecap="round"
            stroke-linejoin="round"
          />
        </svg>
      </button>
      {#if streaming}
        <button class="composer-stop" type="button" onclick={onStop}>Stop</button>
      {:else}
        <button class="usage-button" type="button" disabled={!canSend} onclick={submit}>Send</button>
      {/if}
    </div>
  </div>

  {#if dragging}
    <p class="drop-hint">Drop files to attach</p>
  {/if}
</div>

<style>
  .composer {
    position: relative;
    flex: none;
    display: grid;
    gap: 10px;
    padding: 14px;
  }

  .composer.dragging { border-color: var(--accent-ink); background: var(--accent-soft); }

  .row {
    display: grid;
    grid-template-columns: minmax(0, 1fr) auto;
    gap: 12px;
    /* Actions sit at the bottom so they stay put as the textarea grows. */
    align-items: end;
  }

  .chips {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
    margin: 0;
    padding: 0;
    list-style: none;
  }

  .chip {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    max-width: 220px;
    padding: 4px 6px 4px 5px;
    border: 1px solid var(--line);
    border-radius: 8px;
    background: var(--surface);
    font-size: 11.5px;
  }

  .thumb { width: 22px; height: 22px; border-radius: 4px; object-fit: cover; }

  .kind {
    padding: 2px 5px;
    border-radius: 4px;
    background: var(--accent-soft);
    color: var(--accent-ink);
    font-size: 9.5px;
    font-weight: 800;
    letter-spacing: 0.06em;
  }

  .chip-name {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .chip-remove {
    flex: none;
    width: 18px;
    height: 18px;
    padding: 0;
    border: 0;
    border-radius: 50%;
    background: none;
    color: var(--muted);
    font-size: 14px;
    line-height: 1;
    cursor: pointer;
  }

  .chip-remove:hover { color: var(--danger); }

  .drop-hint {
    margin: 0;
    color: var(--accent-ink);
    font-size: 11.5px;
    font-weight: 600;
    text-align: center;
  }

  .composer-input {
    width: 100%;
    min-height: 52px;
    max-height: 220px;
    padding: 10px 12px;
    border: 1px solid var(--line);
    border-radius: 8px;
    background: var(--surface);
    color: var(--ink);
    font: inherit;
    resize: none;
  }

  .composer-input::placeholder { color: var(--muted); }
  .composer-actions { display: flex; align-items: center; gap: 8px; }

  .composer-attach {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    flex: none;
    width: 40px;
    height: 40px;
    padding: 0;
    border: 1px solid var(--line);
    border-radius: 8px;
    background: var(--surface);
    color: var(--muted);
    cursor: pointer;
  }

  .composer-attach:hover:not(:disabled) { border-color: var(--accent-ink); color: var(--accent-ink); }
  .composer-attach:disabled { opacity: 0.45; cursor: not-allowed; }

  .usage-button {
    height: 40px;
    padding: 0 20px;
    border: 1px solid var(--accent-ink);
    border-radius: 8px;
    background: var(--accent-ink);
    color: var(--on-accent);
    font-weight: 700;
    cursor: pointer;
  }

  .usage-button:disabled { opacity: 0.45; cursor: not-allowed; }

  .composer-stop {
    height: 40px;
    padding: 0 20px;
    border: 1px solid var(--danger);
    border-radius: 8px;
    background: var(--surface);
    color: var(--danger);
    font-weight: 700;
    cursor: pointer;
  }

  .visually-hidden {
    position: absolute;
    width: 1px;
    height: 1px;
    overflow: hidden;
    clip-path: inset(50%);
    white-space: nowrap;
  }
</style>
