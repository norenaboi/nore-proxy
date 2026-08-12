<script lang="ts">
  import { tick } from "svelte";
  import { maskTokenLikeServer } from "$frontend/lib/endpoints/editor";
  import type { PlaygroundSettings } from "$frontend/lib/playground/types";

  let {
    open,
    settings = $bindable(),
    storedKey,
    disabled,
    onSubmitKey,
    onForgetKey,
    onClose,
  }: {
    open: boolean;
    settings: PlaygroundSettings;
    storedKey: string;
    disabled: boolean;
    onSubmitKey: (key: string) => void;
    onForgetKey: () => void;
    onClose: () => void;
  } = $props();

  let draftKey = $state("");
  let dialog: HTMLDivElement | undefined = $state();
  let keyInput: HTMLInputElement | undefined = $state();

  export function focusKeyInput(): void {
    keyInput?.focus();
  }

  function submitKey(event: SubmitEvent): void {
    event.preventDefault();
    const key = draftKey.trim();
    if (!key) return;
    draftKey = "";
    onSubmitKey(key);
  }

  function forgetKey(): void {
    onForgetKey();
    void tick().then(() => keyInput?.focus());
  }

  /** Keeps Tab inside the dialog, which is what makes it modal for keyboards. */
  function trapFocus(event: KeyboardEvent): void {
    if (event.key !== "Tab" || !dialog) return;
    const focusable = [
      ...dialog.querySelectorAll<HTMLElement>(
        'button:not(:disabled), input:not(:disabled), textarea:not(:disabled), a[href]',
      ),
    ].filter((element) => element.offsetParent !== null);
    if (focusable.length === 0) return;

    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  }

  function handleKeydown(event: KeyboardEvent): void {
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      onClose();
      return;
    }
    trapFocus(event);
  }

  $effect(() => {
    if (!open) return;
    void tick().then(() => {
      if (storedKey) dialog?.querySelector<HTMLElement>("textarea, button")?.focus();
      else keyInput?.focus();
    });
  });
</script>

{#if open}
  <!-- The backdrop is a plain click target; Escape and the close button cover
       keyboard users, so it needs no role of its own. -->
  <div class="backdrop" onclick={onClose} aria-hidden="true"></div>
  <div
    bind:this={dialog}
    class="dialog"
    role="dialog"
    aria-modal="true"
    aria-labelledby="playground-settings-title"
    tabindex="-1"
    onkeydown={handleKeydown}
  >
    <header class="dialog-head">
      <h2 id="playground-settings-title">Playground settings</h2>
      <button class="close" type="button" aria-label="Close settings" onclick={onClose}>×</button>
    </header>

    <div class="dialog-body">
      <section class="group">
        <p class="eyebrow">API key</p>
        {#if storedKey}
          <p class="key-current">Using <code>{maskTokenLikeServer(storedKey)}</code></p>
          <button class="secondary" type="button" onclick={forgetKey}>Forget key</button>
        {:else}
          <form class="key-form" onsubmit={submitKey}>
            <label for="playground-key">Client API key</label>
            <div class="key-entry">
              <input
                bind:this={keyInput}
                bind:value={draftKey}
                id="playground-key"
                type="password"
                autocomplete="off"
                placeholder="sk-…"
              />
              <button class="primary" type="submit" disabled={draftKey.trim().length === 0}>Save</button>
            </div>
          </form>
        {/if}
        <p class="note">
          The key is kept in this browser's local storage so the playground remembers it between visits. Anyone with
          access to this browser profile can read it.
        </p>
        <p class="note">Every message counts against the key's request and token limits.</p>
      </section>

      <section class="group">
        <p class="eyebrow">Generation</p>
        <div class="field">
          <label for="playground-system">System prompt</label>
          <textarea
            bind:value={settings.systemPrompt}
            id="playground-system"
            rows="5"
            {disabled}
            placeholder="Leave empty to send no system message."
          ></textarea>
        </div>
        <div class="field-row">
          <div class="field">
            <label for="playground-temperature">Temperature</label>
            <!-- Text rather than number so an empty field stays distinct from zero. -->
            <input
              bind:value={settings.temperature}
              id="playground-temperature"
              type="text"
              inputmode="decimal"
              autocomplete="off"
              {disabled}
              placeholder="default"
            />
          </div>
          <div class="field">
            <label for="playground-top-p">Top P</label>
            <input
              bind:value={settings.topP}
              id="playground-top-p"
              type="text"
              inputmode="decimal"
              autocomplete="off"
              {disabled}
              placeholder="default"
            />
          </div>
        </div>
        <p class="note">Blank values are omitted from the request so the model's own defaults apply.</p>

        <label class="toggle">
          <input bind:checked={settings.stream} type="checkbox" {disabled} />
          <span class="toggle-copy">
            <strong>Stream responses</strong>
            <span class="note">Off waits for the whole reply, so nothing appears until it is finished.</span>
          </span>
        </label>
      </section>
    </div>

    <footer class="dialog-foot">
      <button class="primary" type="button" onclick={onClose}>Done</button>
    </footer>
  </div>
{/if}

<style>
  .backdrop {
    position: fixed;
    inset: 0;
    z-index: 90;
    background: rgba(36, 27, 45, 0.34);
  }

  .dialog {
    position: fixed;
    top: 50%;
    left: 50%;
    z-index: 91;
    transform: translate(-50%, -50%);
    width: min(560px, calc(100vw - 32px));
    max-height: min(84vh, 760px);
    display: flex;
    flex-direction: column;
    border: 1px solid var(--line);
    border-radius: 12px;
    background: var(--surface);
    box-shadow: 0 24px 60px rgba(36, 27, 45, 0.24);
  }

  .dialog-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 16px;
    padding: 18px 20px;
    border-bottom: 1px solid var(--line);
  }

  .dialog-head h2 { margin: 0; font: 500 22px/1.2 Georgia, serif; }

  .close {
    padding: 2px 10px 5px;
    border: 1px solid var(--line);
    border-radius: 8px;
    background: var(--surface);
    color: var(--muted);
    font-size: 18px;
    line-height: 1;
    cursor: pointer;
  }

  .close:hover { border-color: var(--accent-ink); color: var(--accent-ink); }

  .dialog-body {
    flex: 1;
    min-height: 0;
    overflow-y: auto;
    display: grid;
    gap: 22px;
    padding: 20px;
  }

  .group { display: grid; gap: 10px; }
  .group .eyebrow { margin: 0; }

  .key-form { display: grid; gap: 7px; }
  .key-entry { display: grid; grid-template-columns: 1fr auto; gap: 10px; }

  .field { display: grid; gap: 6px; }
  .field-row { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; }

  label {
    color: var(--muted);
    font-size: 11px;
    font-weight: 700;
  }

  input, textarea {
    width: 100%;
    min-width: 0;
    padding: 10px 12px;
    border: 1px solid var(--line);
    border-radius: 8px;
    background: var(--surface);
    color: var(--ink);
    font: inherit;
  }

  textarea { resize: vertical; }
  input::placeholder, textarea::placeholder { color: var(--muted); }
  input:disabled, textarea:disabled { opacity: 0.6; }

  .toggle {
    display: flex;
    align-items: start;
    gap: 10px;
    padding: 12px 14px;
    border: 1px solid var(--line);
    border-radius: 8px;
    cursor: pointer;
  }

  .toggle input {
    width: auto;
    min-height: 0;
    margin: 2px 0 0;
    padding: 0;
    accent-color: var(--accent-ink);
    cursor: pointer;
  }

  .toggle-copy { display: grid; gap: 3px; }
  .toggle-copy strong { font-size: 12.5px; font-weight: 700; }

  .primary {
    min-height: 42px;
    padding: 9px 18px;
    border: 1px solid var(--accent-ink);
    border-radius: 8px;
    background: var(--accent-ink);
    color: white;
    font-weight: 700;
    cursor: pointer;
  }

  .primary:disabled { opacity: 0.45; cursor: not-allowed; }

  .secondary {
    justify-self: start;
    padding: 7px 13px;
    border: 1px solid var(--line);
    border-radius: 8px;
    background: var(--surface);
    color: var(--muted);
    font-size: 12px;
    cursor: pointer;
  }

  .secondary:hover { border-color: var(--accent-ink); color: var(--accent-ink); }

  .key-current { margin: 0; font-size: 13px; }
  .key-current code { font: 600 13px ui-monospace, monospace; }

  .note {
    margin: 0;
    color: var(--muted);
    font-size: 11.5px;
    line-height: 1.55;
  }

  .dialog-foot {
    display: flex;
    justify-content: flex-end;
    padding: 14px 20px;
    border-top: 1px solid var(--line);
  }

  @media (max-width: 560px) {
    .key-entry, .field-row { grid-template-columns: 1fr; }
  }
</style>
