<script lang="ts">
  import { tick } from "svelte";
  import { conversationTitle } from "$frontend/lib/playground/storage";
  import type { PlaygroundConversation } from "$frontend/lib/playground/types";

  let {
    conversations,
    activeId,
    disabled,
    keyMissing,
    onSelect,
    onCreate,
    onRename,
    onDelete,
    onOpenSettings,
  }: {
    conversations: PlaygroundConversation[];
    activeId: string;
    disabled: boolean;
    keyMissing: boolean;
    onSelect: (id: string) => void;
    onCreate: () => void;
    onRename: (id: string, title: string) => void;
    onDelete: (id: string) => void;
    onOpenSettings: () => void;
  } = $props();

  let query = $state("");
  let renamingId = $state("");
  let renameDraft = $state("");
  let renameBox: HTMLInputElement | undefined = $state();

  const ordered = $derived([...conversations].sort((left, right) => right.updatedAt - left.updatedAt));
  const normalizedQuery = $derived(query.trim().toLowerCase());
  const visible = $derived(
    normalizedQuery.length === 0
      ? ordered
      : ordered.filter(
          (conversation) =>
            conversationTitle(conversation).toLowerCase().includes(normalizedQuery) ||
            conversation.messages.some((message) => message.content.toLowerCase().includes(normalizedQuery)),
        ),
  );

  function dateLabel(conversation: PlaygroundConversation): string {
    return new Date(conversation.updatedAt).toLocaleDateString([], { month: "short", day: "numeric" });
  }

  function startRename(conversation: PlaygroundConversation): void {
    renamingId = conversation.id;
    renameDraft = conversationTitle(conversation);
    void tick().then(() => renameBox?.select());
  }

  function commitRename(): void {
    if (!renamingId) return;
    const id = renamingId;
    const title = renameDraft.trim();
    renamingId = "";
    onRename(id, title);
  }

  function handleRenameKeydown(event: KeyboardEvent): void {
    if (event.key === "Enter") {
      event.preventDefault();
      commitRename();
    } else if (event.key === "Escape") {
      event.preventDefault();
      renamingId = "";
    }
  }
</script>

<aside class="sidebar">
  <div class="top">
    <button class="new-chat" type="button" {disabled} onclick={onCreate}>New chat</button>
    <label class="visually-hidden" for="playground-search">Search conversations</label>
    <input
      bind:value={query}
      id="playground-search"
      class="search"
      type="search"
      placeholder="Search chats…"
      autocomplete="off"
    />
  </div>

  <div class="list">
    {#if visible.length === 0}
      <p class="empty">{normalizedQuery ? "No chats match." : "No chats yet."}</p>
    {:else}
      {#each visible as conversation (conversation.id)}
        {#if renamingId === conversation.id}
          <div class="row renaming">
            <input
              bind:this={renameBox}
              bind:value={renameDraft}
              class="rename"
              type="text"
              aria-label="Conversation title"
              onkeydown={handleRenameKeydown}
              onblur={commitRename}
            />
          </div>
        {:else}
          <div class:active={conversation.id === activeId} class="row">
            <button class="open" type="button" onclick={() => onSelect(conversation.id)}>
              <span class="title">{conversationTitle(conversation)}</span>
              <span class="meta">{conversation.modelId || "No model"} · {dateLabel(conversation)}</span>
            </button>
            <div class="row-actions">
              <button
                type="button"
                aria-label={`Rename ${conversationTitle(conversation)}`}
                onclick={() => startRename(conversation)}
              >
                Rename
              </button>
              <button
                type="button"
                {disabled}
                aria-label={`Delete ${conversationTitle(conversation)}`}
                onclick={() => onDelete(conversation.id)}
              >
                Delete
              </button>
            </div>
          </div>
        {/if}
      {/each}
    {/if}
  </div>

  <div class="bottom">
    <button class="settings" type="button" onclick={onOpenSettings}>
      <span>Settings</span>
      {#if keyMissing}<span class="dot" aria-hidden="true"></span>{/if}
    </button>
  </div>
</aside>

<style>
  .sidebar {
    /* Fills the grid column; without this the flex parent leaves it at content
       width and the remaining column space reads as a gap. */
    flex: 1;
    display: flex;
    flex-direction: column;
    min-height: 0;
    min-width: 0;
    border: 1px solid var(--line);
    border-radius: 10px;
    background: var(--surface);
  }

  .top {
    display: grid;
    gap: 8px;
    padding: 12px;
    border-bottom: 1px solid var(--line);
  }

  .new-chat {
    min-height: 38px;
    padding: 9px 14px;
    border: 1px solid var(--accent-ink);
    border-radius: 8px;
    background: var(--accent-ink);
    color: white;
    font-weight: 700;
    font-size: 12.5px;
    cursor: pointer;
  }

  .new-chat:disabled { opacity: 0.45; cursor: not-allowed; }

  .search {
    width: 100%;
    min-width: 0;
    padding: 8px 11px;
    border: 1px solid var(--line);
    border-radius: 8px;
    background: var(--surface);
    color: var(--ink);
    font-size: 12.5px;
  }

  .search::placeholder { color: var(--muted); }

  .list {
    flex: 1;
    min-height: 0;
    overflow-y: auto;
    overscroll-behavior: contain;
    display: grid;
    gap: 2px;
    align-content: start;
    padding: 8px;
  }

  .row {
    position: relative;
    display: grid;
    align-items: center;
    min-width: 0;
    /* A fixed height plus a transparent border keeps rows identical in size
       whether they show a title or the rename field. */
    min-height: 52px;
    border: 1px solid transparent;
    border-radius: 8px;
  }

  .row:hover, .row.active { border-color: var(--accent); background: var(--accent-soft); }
  .row.renaming { border-color: var(--accent-ink); background: var(--surface); }

  .open {
    display: grid;
    gap: 2px;
    min-width: 0;
    max-width: 100%;
    padding: 8px 9px;
    border: 0;
    border-radius: 7px;
    background: none;
    color: inherit;
    text-align: left;
    cursor: pointer;
  }

  .row.active .open { color: var(--accent-ink); }

  .title {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-size: 12.5px;
    font-weight: 600;
  }

  .meta {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    color: var(--muted);
    font-size: 10.5px;
  }

  .row.active .meta { color: var(--accent-ink); opacity: 0.75; }

  .row-actions {
    position: absolute;
    top: 6px;
    right: 6px;
    display: flex;
    gap: 4px;
    opacity: 0;
    transition: opacity 0.12s;
  }

  /* Opacity rather than display so the buttons stay in the tab order. */
  .row:hover .row-actions, .row:focus-within .row-actions { opacity: 1; }

  .row-actions button {
    padding: 3px 7px;
    border: 1px solid var(--line);
    border-radius: 6px;
    background: var(--surface);
    color: var(--muted);
    font-size: 10px;
    cursor: pointer;
  }

  .row-actions button:hover:not(:disabled) { border-color: var(--accent-ink); color: var(--accent-ink); }
  .row-actions button:disabled { opacity: 0.4; cursor: not-allowed; }

  .rename {
    width: 100%;
    min-width: 0;
    /* Matches .open's box so the row does not resize while renaming. */
    padding: 8px 9px;
    border: 0;
    border-radius: 7px;
    background: none;
    color: inherit;
    font-size: 12.5px;
    font-weight: 600;
  }

  .empty {
    margin: 0;
    padding: 20px 10px;
    color: var(--muted);
    font-size: 12px;
    text-align: center;
  }

  /* Pinned below the scrolling list. */
  .bottom {
    padding: 10px 12px;
    border-top: 1px solid var(--line);
  }

  .settings {
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 8px;
    width: 100%;
    min-height: 38px;
    padding: 9px 14px;
    border: 1px solid var(--line);
    border-radius: 8px;
    background: var(--surface);
    color: var(--muted);
    font-size: 12.5px;
    cursor: pointer;
  }

  .settings:hover { border-color: var(--accent-ink); color: var(--accent-ink); }

  /* Marks Settings as needing attention while no key is stored. */
  .dot { width: 7px; height: 7px; border-radius: 50%; background: #a43f55; }

  .visually-hidden {
    position: absolute;
    width: 1px;
    height: 1px;
    overflow: hidden;
    clip-path: inset(50%);
    white-space: nowrap;
  }

  @media (prefers-reduced-motion: reduce) {
    .row-actions { transition: none; }
  }

  @media (max-width: 900px) {
    .row-actions { opacity: 1; }
    .list { max-height: 40vh; }
  }
</style>
