<script lang="ts">
  import MessageBubble from "./MessageBubble.svelte";
  import { motionDuration } from "$frontend/lib/motion";
  import type { PlaygroundMessage } from "$frontend/lib/playground/types";

  let {
    messages,
    streaming,
    statusMessage,
    onEdit,
    onDelete,
    onResend,
  }: {
    messages: PlaygroundMessage[];
    streaming: boolean;
    statusMessage: string;
    onEdit: (id: string, content: string) => void;
    onDelete: (id: string) => void;
    onResend: (id: string) => void;
  } = $props();

  let viewport: HTMLDivElement | undefined = $state();
  let stick = $state(true);
  let scrollQueued = false;

  function handleScroll(): void {
    if (!viewport) return;
    stick = viewport.scrollHeight - viewport.scrollTop - viewport.clientHeight < 48;
  }

  function scheduleScroll(): void {
    if (!stick || scrollQueued || !viewport) return;
    scrollQueued = true;
    requestAnimationFrame(() => {
      scrollQueued = false;
      // Assigning scrollTop is intentionally instant: an animation per token
      // would fight itself and ignore a reduced-motion preference.
      if (viewport) viewport.scrollTop = viewport.scrollHeight;
    });
  }

  function jumpToLatest(): void {
    if (!viewport) return;
    viewport.scrollTo({
      top: viewport.scrollHeight,
      behavior: motionDuration(300) === 0 ? "auto" : "smooth",
    });
    stick = true;
  }

  $effect(() => {
    const last = messages.at(-1);
    // Subscribe to the fields that grow while streaming.
    void messages.length;
    void last?.content;
    void last?.reasoning;
    scheduleScroll();
  });
</script>

<div class="transcript-wrap">
  <div
    bind:this={viewport}
    class="transcript"
    role="log"
    aria-label="Conversation"
    aria-live="off"
    onscroll={handleScroll}
  >
    {#if messages.length === 0}
      <p class="empty">
        Send a message to start. Pick a model above and add a client API key in Settings; the conversation stays in this
        browser.
      </p>
    {:else}
      {#each messages as message, index (message.id)}
        <MessageBubble
          {message}
          busy={streaming && index === messages.length - 1 && message.role === "assistant"}
          {streaming}
          {onEdit}
          {onDelete}
          {onResend}
        />
      {/each}
    {/if}
  </div>

  {#if !stick && messages.length > 0}
    <button class="jump" type="button" onclick={jumpToLatest}>Jump to latest ↓</button>
  {/if}
</div>

<p class="visually-hidden" role="status" aria-live="polite">{statusMessage}</p>

<style>
  .transcript-wrap {
    position: relative;
    flex: 1;
    min-height: 0;
    min-width: 0;
    display: flex;
    border: 1px solid var(--line);
    border-radius: 10px;
    background: var(--surface);
  }

  .transcript {
    flex: 1;
    min-height: 0;
    min-width: 0;
    overflow-y: auto;
    overflow-x: hidden;
    overscroll-behavior: contain;
    display: grid;
    gap: 12px;
    align-content: start;
    padding: 14px;
  }

  .empty {
    margin: 0;
    padding: 48px 20px;
    color: var(--muted);
    text-align: center;
    max-width: 46ch;
    justify-self: center;
    line-height: 1.7;
  }

  .jump {
    position: absolute;
    right: 14px;
    bottom: 12px;
    padding: 7px 13px;
    border: 1px solid var(--line);
    border-radius: 999px;
    background: var(--surface);
    color: var(--accent-ink);
    font-size: 11.5px;
    font-weight: 600;
    box-shadow: var(--shadow-sm);
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
