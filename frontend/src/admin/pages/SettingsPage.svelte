<script lang="ts">
  import { onMount } from "svelte";
  import { requestAdminJson } from "$frontend/lib/api/admin";
  import { toast } from "$frontend/lib/stores";

  interface Settings {
    rpdDefault: number; rpmDefault: number; maxContextSizeDefault: number;
    keyHopAttempts: number; autoModelMaxTargetAttempts: number; keyTimeoutHours: number;
    defaultEndpointApiFormat: string; defaultEndpointKeyRotation: string;
    defaultEndpointKeyHealth: boolean;
    defaultEndpointTemperatureEnabled: boolean; defaultEndpointTemperature: number | null;
    defaultEndpointTopPEnabled: boolean; defaultEndpointTopP: number | null;
    defaultEndpointMaxTokensEnabled: boolean; defaultEndpointMaxTokens: number | null;
    defaultEndpointPromptCachingEnabled: boolean; defaultEndpointPromptCachingDepth: number;
  }

  let s = $state<Settings | null>(null);
  let loading = $state(true);
  let loadError = $state("");
  let saving = $state(false);

  async function load() {
    try {
      const d = await requestAdminJson<{ settings: Settings }>("/api/settings");
      s = d.settings;
    } catch (e) {
      loadError = e instanceof Error ? e.message : "Failed to load settings";
      toast.show(loadError, "error");
    } finally {
      loading = false;
    }
  }

  async function save() {
    if (!s) return;
    if (isNaN(s.rpdDefault) || s.rpdDefault < 1) return toast.show("RPD default must be at least 1", "error");
    if (isNaN(s.rpmDefault) || s.rpmDefault < 1) return toast.show("RPM default must be at least 1", "error");
    if (isNaN(s.maxContextSizeDefault) || s.maxContextSizeDefault < 0) return toast.show("Max context size must be 0 or higher", "error");
    if (isNaN(s.keyHopAttempts) || s.keyHopAttempts < 0) return toast.show("Key hop attempts must be 0 or higher", "error");
    if (isNaN(s.autoModelMaxTargetAttempts) || s.autoModelMaxTargetAttempts < 1 || s.autoModelMaxTargetAttempts > 20) return toast.show("Auto model target attempts must be 1–20", "error");
    if (isNaN(s.keyTimeoutHours) || s.keyTimeoutHours < 1) return toast.show("Key timeout hours must be at least 1", "error");
    if (s.defaultEndpointTemperatureEnabled && s.defaultEndpointTemperature !== null && (isNaN(s.defaultEndpointTemperature) || s.defaultEndpointTemperature < 0 || s.defaultEndpointTemperature > 2)) return toast.show("Temperature must be 0–2", "error");
    if (s.defaultEndpointTopPEnabled && s.defaultEndpointTopP !== null && (isNaN(s.defaultEndpointTopP) || s.defaultEndpointTopP < 0 || s.defaultEndpointTopP > 1)) return toast.show("Top P must be 0–1", "error");
    if (s.defaultEndpointMaxTokensEnabled && s.defaultEndpointMaxTokens !== null && (isNaN(s.defaultEndpointMaxTokens) || s.defaultEndpointMaxTokens < 1)) return toast.show("Max tokens must be at least 1", "error");
    if (s.defaultEndpointPromptCachingEnabled && (isNaN(s.defaultEndpointPromptCachingDepth) || s.defaultEndpointPromptCachingDepth < 0)) return toast.show("Cache depth must be a non-negative integer", "error");

    saving = true;
    try {
      const d = await requestAdminJson<{ settings: Settings }>("/api/settings", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(s),
      });
      s = d.settings;
      toast.show("Settings saved successfully!");
    } catch (e) {
      toast.show(e instanceof Error ? e.message : "Failed to save settings", "error");
    } finally {
      saving = false;
    }
  }

  onMount(load);
</script>

{#if loading}
  <div class="settings-skeleton" aria-hidden="true">
    {#each [3, 3, 6] as rows}
      <section class="settings-card skeleton-card">
        <div class="card-header"><span class="skeleton-block skeleton-icon"></span><span class="skeleton-block skeleton-title"></span><span class="skeleton-block skeleton-subtitle"></span></div>
        <div class="card-body">
          {#each Array(rows) as _}
            <div class="setting-row skeleton-row"><div class="skeleton-copy"><span class="skeleton-block skeleton-label"></span><span class="skeleton-block skeleton-description"></span></div><span class="skeleton-block skeleton-control"></span></div>
          {/each}
        </div>
      </section>
    {/each}
  </div>
  <span class="sr-only" role="status">Loading settings…</span>
{:else if loadError}
  <div class="page-error" role="alert">{loadError}</div>
{:else if s}
  <div class="settings-stack">
    <section class="settings-card">
      <div class="card-header"><i class="fa-solid fa-key"></i><h2>Keys</h2><span class="card-subtitle">Default per-key limits</span></div>
      <div class="card-body">
      {#each [["Default RPD", "rpdDefault", 1, 1, "500", "Requests per day limit for new API keys. 0 is not allowed."], ["Default RPM", "rpmDefault", 1, 1, "10", "Requests per minute limit for new API keys. 0 is not allowed."], ["Default Max Context Size", "maxContextSizeDefault", 0, 1, "0", "Maximum context size in tokens for new API keys. 0 means unlimited."]] as [label, field, min, step, placeholder, desc]}
        <div class="setting-row">
          <div class="setting-info"><div class="setting-label">{label}</div><div class="setting-description">{desc}</div></div>
          <div class="setting-control"><input class="number-input" type="number" bind:value={(s as Record<string, unknown>)[field as string]} {min} {step} {placeholder} /></div>
        </div>
      {/each}
      </div>
    </section>

    <section class="settings-card">
      <div class="card-header"><i class="fa-solid fa-shuffle"></i><h2>Key Failover</h2><span class="card-subtitle">Automatic key hopping</span></div>
      <div class="card-body">
      {#each [["Key Hop Attempts", "keyHopAttempts", 0, 1, "1", "Extra keys a single request may try on actionable errors. 0 disables hopping."], ["Auto Model Target Attempts", "autoModelMaxTargetAttempts", 1, 1, "3", "Global ceiling for how many targets an auto model may try per request."], ["Key Timeout Hours", "keyTimeoutHours", 1, 1, "24", "How long a rate-limited key stays timed out before auto-recovery."]] as [label, field, min, step, placeholder, desc]}
        <div class="setting-row">
          <div class="setting-info"><div class="setting-label">{label}</div><div class="setting-description">{desc}</div></div>
          <div class="setting-control"><input class="number-input" type="number" bind:value={(s as Record<string, unknown>)[field as string]} {min} {step} {placeholder} /></div>
        </div>
      {/each}
      </div>
    </section>

    <section class="settings-card">
      <div class="card-header"><i class="fa-solid fa-hexagon-nodes"></i><h2>Endpoint</h2><span class="card-subtitle">New endpoints only</span></div>
      <div class="card-body">

      <div class="setting-row">
        <div class="setting-info"><div class="setting-label">Default API Format</div><div class="setting-description">Pre-selected API format for newly created endpoints.</div></div>
        <div class="setting-control select-control"><select bind:value={s.defaultEndpointApiFormat} class="form-select">
          <option value="openai">OpenAI — /v1/chat/completions</option>
          <option value="anthropic">Anthropic — /v1/messages</option>
          <option value="gemini">Gemini — /v1beta/generateContent</option>
          <option value="openai-responses">OpenAI Responses — /v1/responses</option>
          <option value="openai-codex">OpenAI Codex — /v1/responses</option>
        </select></div>
      </div>

      <div class="setting-row">
        <div class="setting-info"><div class="setting-label">Default Key Rotation</div><div class="setting-description">Rotation mode seeded onto new endpoints.</div></div>
        <div class="setting-control select-control"><select bind:value={s.defaultEndpointKeyRotation} class="form-select">
          <option value="sticky">Sticky</option>
          <option value="roundrobin">Round-robin</option>
        </select></div>
      </div>

      <div class="setting-row">
        <div class="setting-info"><div class="setting-label">Default Key Health</div><div class="setting-description">Whether new endpoints bench keys on errors. Turn off for short-window rate limits.</div></div>
        <div class="setting-control select-control"><select bind:value={s.defaultEndpointKeyHealth} class="form-select">
          <option value={true as unknown as string}>On</option>
          <option value={false as unknown as string}>Off</option>
        </select></div>
      </div>

      {#each [["Default Temperature", "defaultEndpointTemperatureEnabled", "defaultEndpointTemperature", 0.1, 0, 2, "1"], ["Default Top P", "defaultEndpointTopPEnabled", "defaultEndpointTopP", 0.05, 0, 1, "1"], ["Default Max Tokens", "defaultEndpointMaxTokensEnabled", "defaultEndpointMaxTokens", 1, 1, null, "4096"]] as [label, enabledField, valueField, step, min, max, placeholder]}
        <div class="setting-row">
          <div class="setting-info"><div class="setting-label">{label}</div><div class="setting-description">Blank passes the client value through; a value overrides it.</div></div>
          <div class="setting-control toggle-control">
            <label class="toggle">
              <input type="checkbox" bind:checked={(s as Record<string, unknown>)[enabledField as string] as boolean} />
              <div class="toggle-track"></div><div class="toggle-thumb"></div>
            </label>
            <input type="number" bind:value={(s as Record<string, unknown>)[valueField as string]} {step} {min} max={max ?? undefined} {placeholder} disabled={!(s as Record<string, unknown>)[enabledField as string]} class="number-input" />
          </div>
        </div>
      {/each}

      <div class="setting-row">
        <div class="setting-info"><div class="setting-label">Default Prompt Caching for Claude</div><div class="setting-description">When enabled, new endpoints will have prompt caching turned on with the specified cache depth.</div></div>
        <div class="setting-control toggle-control">
          <label class="toggle">
            <input type="checkbox" bind:checked={s.defaultEndpointPromptCachingEnabled} />
            <div class="toggle-track"></div><div class="toggle-thumb"></div>
          </label>
          <input type="number" bind:value={s.defaultEndpointPromptCachingDepth} min="0" max="100" step="1" placeholder="2" disabled={!s.defaultEndpointPromptCachingEnabled} class="number-input" />
        </div>
      </div>
      </div>
    </section>

    <div class="save-row">
      <button class="btn btn-primary" type="button" onclick={save} disabled={saving} aria-busy={saving}>
        {#if saving}<span class="button-spinner" aria-hidden="true"></span> Saving…{:else}<i class="fa-solid fa-floppy-disk"></i> Save Changes{/if}
      </button>
    </div>
  </div>
{/if}

<style>
  .settings-stack, .settings-skeleton { display: flex; flex-direction: column; gap: 18px; }
  .settings-card { overflow: hidden; border: 1px solid var(--border-color); border-radius: 10px; background: var(--card-bg); box-shadow: none; }
  .card-header { display: flex; align-items: center; gap: 12px; padding: 20px 24px; border-bottom: 1px solid var(--border-color); }
  .card-header i { color: var(--primary-dark); font-size: 18px; }
  .card-header h2 { margin: 0; color: var(--text-primary); font: 500 18px/1.2 Georgia, "Times New Roman", serif; }
  .card-subtitle { margin-left: auto; color: var(--text-secondary); font-size: 13px; }
  .card-body { display: flex; flex-direction: column; gap: 24px; padding: 24px; }
  .setting-row { display: flex; align-items: flex-start; justify-content: space-between; gap: 24px; }
  .setting-row + .setting-row { padding-top: 24px; border-top: 1px solid var(--border-color); }
  .setting-info { flex: 1; }
  .setting-label { margin-bottom: 4px; color: var(--text-primary); font-size: 15px; font-weight: 600; }
  .setting-description { color: var(--text-secondary); font-size: 13px; line-height: 1.5; }
  .setting-control { display: flex; align-items: center; flex-shrink: 0; }
  .select-control { min-width: 220px; }
  .form-select { width: 100%; min-height: 42px; padding: 10px 36px 10px 14px; border: 1px solid var(--input-border); border-radius: 8px; background-color: var(--input-bg); color: var(--text-primary); }
  .number-input { width: 100px; padding: 9px 12px; border: 1px solid var(--input-border); border-radius: 8px; background: var(--input-bg); color: var(--text-primary); text-align: center; transition: opacity .2s ease; }
  .number-input:disabled { opacity: .4; cursor: not-allowed; }
  .toggle-control { gap: 12px; }
  .save-row { display: flex; justify-content: flex-end; padding: 6px 0; }
  .skeleton-card { pointer-events: none; }
  .skeleton-icon { width: 18px; height: 18px; }
  .skeleton-title { width: 96px; height: 20px; }
  .skeleton-subtitle { width: 150px; height: 14px; margin-left: auto; }
  .skeleton-row { width: 100%; }
  .skeleton-copy { display: flex; flex: 1; flex-direction: column; gap: 8px; }
  .skeleton-label { width: min(210px, 60%); height: 16px; }
  .skeleton-description { width: min(480px, 90%); height: 12px; }
  .skeleton-control { width: 100px; height: 42px; flex-shrink: 0; }
  .sr-only { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0, 0, 0, 0); white-space: nowrap; clip-path: inset(50%); }
  @media (max-width: 768px) { .setting-row { flex-direction: column; gap: 12px; } .setting-control, .select-control { width: 100%; } .toggle-control { justify-content: flex-end; } .card-header, .card-body { padding-left: 18px; padding-right: 18px; } .card-subtitle { font-size: 11px; } }
</style>
