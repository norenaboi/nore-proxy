<script lang="ts">
  let {
    message,
    onDismiss,
  }: {
    message: string;
    onDismiss: () => void;
  } = $props();
</script>

{#if message}
  <div class="toast" role="alert">
    <span class="body">{message}</span>
    <button class="dismiss" type="button" aria-label="Dismiss error" onclick={onDismiss}>×</button>
  </div>
{/if}

<style>
  /* Fixed so it survives transcript scrolling, and it stays until dismissed. */
  .toast {
    position: fixed;
    bottom: 26px;
    left: 50%;
    z-index: 80;
    transform: translateX(-50%);
    display: flex;
    align-items: start;
    gap: 14px;
    width: max-content;
    max-width: min(620px, calc(100vw - 32px));
    padding: 14px 16px;
    border: 1px solid var(--danger-line);
    border-radius: 10px;
    background: var(--danger-soft);
    color: var(--danger);
    font-size: 13px;
    line-height: 1.55;
    box-shadow: var(--shadow-md);
  }

  .body { min-width: 0; overflow-wrap: anywhere; }

  .dismiss {
    flex: none;
    padding: 0 6px 3px;
    border: 1px solid var(--danger-line);
    border-radius: 7px;
    background: transparent;
    color: inherit;
    font-size: 16px;
    line-height: 1.2;
    cursor: pointer;
  }

  .dismiss:hover { background: var(--danger-hover); }
</style>
