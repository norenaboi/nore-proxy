<script lang="ts">
  import { tick } from "svelte";

  let {
    value = $bindable(),
    streaming,
    onSend,
    onStop,
  }: {
    value: string;
    streaming: boolean;
    onSend: () => void;
    onStop: () => void;
  } = $props();

  let textarea: HTMLTextAreaElement | undefined = $state();

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
    if (streaming || value.trim().length === 0) return;
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
</script>

<div class="composer panel">
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
  ></textarea>
  <div class="composer-actions">
    {#if streaming}
      <button class="composer-stop" type="button" onclick={onStop}>Stop</button>
    {:else}
      <button class="usage-button" type="button" disabled={value.trim().length === 0} onclick={submit}>Send</button>
    {/if}
  </div>
</div>

<style>
  .composer {
    flex: none;
    display: grid;
    grid-template-columns: minmax(0, 1fr) auto;
    gap: 12px;
    align-items: stretch;
    padding: 14px;
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
  .composer-actions { display: flex; gap: 8px; }

  .usage-button {
    min-height: 52px;
    padding: 9px 20px;
    border: 1px solid var(--accent-ink);
    border-radius: 8px;
    background: var(--accent-ink);
    color: var(--on-accent);
    font-weight: 700;
    cursor: pointer;
  }

  .usage-button:disabled { opacity: 0.45; cursor: not-allowed; }

  .composer-stop {
    min-height: 52px;
    padding: 9px 20px;
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
