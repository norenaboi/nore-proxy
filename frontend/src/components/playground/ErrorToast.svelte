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
    border: 1px solid rgba(164, 63, 85, 0.35);
    border-radius: 10px;
    background: #fff2f4;
    color: #8f2940;
    font-size: 13px;
    line-height: 1.55;
    box-shadow: 0 14px 36px rgba(36, 27, 45, 0.18);
  }

  .body { min-width: 0; overflow-wrap: anywhere; }

  .dismiss {
    flex: none;
    padding: 0 6px 3px;
    border: 1px solid rgba(164, 63, 85, 0.35);
    border-radius: 7px;
    background: transparent;
    color: inherit;
    font-size: 16px;
    line-height: 1.2;
    cursor: pointer;
  }

  .dismiss:hover { background: rgba(164, 63, 85, 0.12); }
</style>
