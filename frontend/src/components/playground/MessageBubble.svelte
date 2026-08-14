<script lang="ts">
  import { tick } from "svelte";
  import { renderMarkdown } from "$frontend/lib/playground/markdown";
  import type { PlaygroundMessage } from "$frontend/lib/playground/types";

  let {
    message,
    busy,
    streaming,
    onEdit,
    onDelete,
    onResend,
  }: {
    message: PlaygroundMessage;
    /** True while this specific message is still being generated. */
    busy: boolean;
    /** True while any request is in flight, which locks every action. */
    streaming: boolean;
    onEdit: (id: string, content: string) => void;
    onDelete: (id: string) => void;
    onResend: (id: string) => void;
  } = $props();

  let editing = $state(false);
  let draft = $state("");
  let editBox: HTMLTextAreaElement | undefined = $state();
  let editButton: HTMLButtonElement | undefined = $state();

  const isUser = $derived(message.role === "user");
  const renderedContent = $derived(isUser ? "" : renderMarkdown(message.content));
  const timestamp = $derived(
    new Date(message.createdAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }),
  );

  function startEditing(): void {
    draft = message.content;
    editing = true;
    void tick().then(() => {
      editBox?.focus();
      editBox?.setSelectionRange(draft.length, draft.length);
    });
  }

  function stopEditing(): void {
    editing = false;
    // Focus would otherwise fall to the document when the textarea unmounts.
    void tick().then(() => editButton?.focus());
  }

  function save(): void {
    const next = draft;
    stopEditing();
    onEdit(message.id, next);
  }

  function handleEditKeydown(event: KeyboardEvent): void {
    if (event.key !== "Escape") return;
    event.preventDefault();
    stopEditing();
  }
</script>

<article class:user={isUser} class="turn" aria-busy={busy ? "true" : undefined}>
  <header class="head">
    <span class="role">{isUser ? "You" : "Assistant"}</span>
    <span class="time">{timestamp}</span>
  </header>

  {#if message.reasoning}
    <details class="reasoning">
      <summary>Thought process</summary>
      <p class="text">{message.reasoning}</p>
    </details>
  {/if}

  {#if editing}
    <div class="bubble edit">
      <label class="visually-hidden" for={`edit-${message.id}`}>Edit message</label>
      <textarea bind:this={editBox} bind:value={draft} id={`edit-${message.id}`} rows="5" onkeydown={handleEditKeydown}
      ></textarea>
      <div class="edit-actions">
        <button class="save" type="button" onclick={save}>Save</button>
        <button class="cancel" type="button" onclick={stopEditing}>Cancel</button>
      </div>
    </div>
  {:else if message.content}
    {#if isUser}
      <p class="bubble text">{message.content}</p>
    {:else}
      <!-- renderMarkdown escapes every span of model text; only its own tags survive. -->
      <div class="bubble markdown">{@html renderedContent}</div>
    {/if}
  {:else if busy}
    <p class="bubble pending">Waiting for the response…</p>
  {:else}
    <p class="bubble pending">No content.</p>
  {/if}

  {#if message.error}
    <p class="turn-error" role="alert">{message.error}</p>
  {/if}

  {#if !editing}
    <div class="actions">
      <button
        bind:this={editButton}
        type="button"
        disabled={streaming}
        aria-label={`Edit ${message.role} message`}
        onclick={startEditing}
      >
        Edit
      </button>
      <button
        type="button"
        disabled={streaming}
        aria-label={`Resend from this ${message.role} message`}
        onclick={() => onResend(message.id)}
      >
        Resend
      </button>
      <button
        type="button"
        disabled={streaming}
        aria-label={`Delete ${message.role} message`}
        onclick={() => onDelete(message.id)}
      >
        Delete
      </button>
    </div>
  {/if}
</article>

<style>
  .turn {
    display: grid;
    gap: 6px;
    min-width: 0;
    /* The opposite margin is what makes the column read as a conversation. */
    margin-right: 12%;
    justify-items: start;
  }

  .turn.user {
    margin-right: 0;
    margin-left: 12%;
    justify-items: end;
  }

  .head {
    display: flex;
    align-items: center;
    gap: 9px;
    max-width: 100%;
    padding: 0 4px;
  }

  .turn.user .head { flex-direction: row-reverse; }

  .role {
    color: var(--accent-ink);
    font-size: 10px;
    font-weight: 800;
    letter-spacing: 0.12em;
    text-transform: uppercase;
  }

  .time { color: var(--muted); font-size: 10.5px; font-variant-numeric: tabular-nums; }

  .actions {
    display: flex;
    gap: 5px;
    padding: 0 4px;
    opacity: 0;
    transition: opacity 0.12s;
  }

  /* Opacity rather than display so the buttons stay in the tab order. */
  .turn:hover .actions, .turn:focus-within .actions { opacity: 1; }

  .actions button {
    padding: 3px 8px;
    border: 1px solid var(--line);
    border-radius: 6px;
    background: var(--surface);
    color: var(--muted);
    font-size: 10.5px;
    cursor: pointer;
  }

  .actions button:hover:not(:disabled) { border-color: var(--accent-ink); color: var(--accent-ink); }
  .actions button:disabled { opacity: 0.4; cursor: not-allowed; }

  .bubble {
    max-width: 100%;
    min-width: 0;
    margin: 0;
    padding: 12px 15px;
    border: 1px solid var(--line);
    border-radius: 14px;
    background: var(--surface);
  }

  /* Squaring one corner points the bubble at its author. */
  .turn:not(.user) .bubble { border-bottom-left-radius: 5px; }

  .turn.user .bubble {
    border-color: var(--accent);
    background: var(--accent-soft);
    border-bottom-right-radius: 5px;
  }

  .text {
    white-space: pre-wrap;
    overflow-wrap: anywhere;
    line-height: 1.65;
  }

  .pending { color: var(--muted); font-style: italic; }

  .markdown {
    overflow-wrap: anywhere;
    line-height: 1.65;
  }

  .markdown :global(p) { margin: 0 0 10px; }
  .markdown :global(> :last-child) { margin-bottom: 0; }

  .markdown :global(h1),
  .markdown :global(h2),
  .markdown :global(h3),
  .markdown :global(h4),
  .markdown :global(h5),
  .markdown :global(h6) {
    margin: 14px 0 8px;
    font-weight: 700;
    line-height: 1.3;
  }

  .markdown :global(> :first-child) { margin-top: 0; }
  .markdown :global(h1) { font-size: 1.35em; }
  .markdown :global(h2) { font-size: 1.2em; }
  .markdown :global(h3) { font-size: 1.08em; }
  .markdown :global(h4), .markdown :global(h5), .markdown :global(h6) { font-size: 1em; }

  .markdown :global(ul), .markdown :global(ol) { margin: 0 0 10px; padding-left: 22px; }
  .markdown :global(li) { margin: 3px 0; }

  .markdown :global(blockquote) {
    margin: 0 0 10px;
    padding: 2px 12px;
    border-left: 3px solid var(--line);
    color: var(--muted);
  }

  .markdown :global(hr) {
    margin: 12px 0;
    border: 0;
    border-top: 1px solid var(--line);
  }

  .markdown :global(a) { color: var(--accent-ink); text-decoration: underline; }

  .markdown :global(code) {
    padding: 1px 5px;
    border-radius: 5px;
    background: var(--accent-soft);
    font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
    font-size: 0.9em;
  }

  .markdown :global(pre) {
    margin: 0 0 10px;
    padding: 10px 12px;
    overflow-x: auto;
    border: 1px solid var(--line);
    border-radius: 8px;
    background: var(--accent-soft);
  }

  .markdown :global(pre code) {
    padding: 0;
    background: none;
    white-space: pre;
  }

  /* The wrapper scrolls so a wide table cannot widen the bubble. */
  .markdown :global(.markdown-table) { margin: 0 0 10px; overflow-x: auto; }

  .markdown :global(table) {
    border-collapse: collapse;
    font-size: 12.5px;
  }

  .markdown :global(th), .markdown :global(td) {
    padding: 6px 10px;
    border: 1px solid var(--line);
    text-align: left;
    vertical-align: top;
  }

  .markdown :global(th) { background: var(--accent-soft); font-weight: 700; }

  .reasoning {
    max-width: 100%;
    min-width: 0;
    border: 1px solid var(--line);
    border-radius: 10px;
    background: var(--surface);
  }

  .reasoning summary {
    padding: 8px 12px;
    color: var(--muted);
    font-size: 11.5px;
    font-weight: 700;
    cursor: pointer;
  }

  .reasoning .text {
    margin: 0;
    padding: 0 12px 12px;
    border: 0;
    color: var(--muted);
    font-size: 13px;
  }

  .edit { display: grid; gap: 8px; width: min(560px, 100%); }

  .edit textarea {
    width: 100%;
    min-width: 0;
    padding: 10px 12px;
    border: 1px solid var(--line);
    border-radius: 8px;
    background: var(--surface);
    color: var(--ink);
    font: inherit;
    resize: vertical;
  }

  .edit-actions { display: flex; gap: 8px; }

  .save {
    padding: 7px 15px;
    border: 1px solid var(--accent-ink);
    border-radius: 8px;
    background: var(--accent-ink);
    color: var(--on-accent);
    font-weight: 700;
    cursor: pointer;
  }

  .cancel {
    padding: 7px 15px;
    border: 1px solid var(--line);
    border-radius: 8px;
    background: var(--surface);
    color: var(--muted);
    cursor: pointer;
  }

  .hint { margin: 0; color: var(--muted); font-size: 11.5px; }

  .turn-error {
    max-width: 100%;
    margin: 0;
    padding: 9px 12px;
    border: 1px solid var(--danger-line);
    border-radius: 8px;
    background: var(--danger-soft);
    color: var(--danger);
    font-size: 12.5px;
  }

  .visually-hidden {
    position: absolute;
    width: 1px;
    height: 1px;
    overflow: hidden;
    clip-path: inset(50%);
    white-space: nowrap;
  }

  @media (prefers-reduced-motion: reduce) {
    .actions { transition: none; }
  }

  @media (max-width: 700px) {
    .turn { margin-right: 6%; }
    .turn.user { margin-left: 6%; }
    .actions { opacity: 1; }
  }
</style>
