<script lang="ts">
  import { onMount } from "svelte";
  import { fade, scale } from "svelte/transition";
  import { requestAdminJson } from "$frontend/lib/api/admin";
  import { motionDuration } from "$frontend/lib/motion";
  import {
    isDuplicateToken,
    mergeBulkTokens,
    removeTokenAt,
  } from "$frontend/lib/endpoints/editor";
  import { pageHeaderActions, toast } from "$frontend/lib/stores";

  interface GenDefault { enabled: boolean; value: number | null; }
  interface Endpoint {
    index: number; name?: string; url: string; token?: string; tokens?: string[];
    apiFormat?: string; appendApiSuffix?: boolean; keyRotation?: string; keyHealth?: boolean;
    headers?: Record<string, string>;
    generationDefaults?: { temperature?: GenDefault; top_p?: GenDefault; max_tokens?: GenDefault };
    promptCaching?: { enabled: boolean; depth: number };
  }
  interface KeyState {
    tokenHash?: string; maskedKey?: string; status?: string; disabledUntil?: number;
    totalRequests?: number; failedRequests?: number; codeCounts?: Record<string, number>;
  }
  interface Settings {
    defaultEndpointApiFormat?: string; defaultEndpointKeyRotation?: string; defaultEndpointKeyHealth?: boolean;
    defaultEndpointTemperatureEnabled?: boolean; defaultEndpointTemperature?: number | null;
    defaultEndpointTopPEnabled?: boolean; defaultEndpointTopP?: number | null;
    defaultEndpointMaxTokensEnabled?: boolean; defaultEndpointMaxTokens?: number | null;
    defaultEndpointPromptCachingEnabled?: boolean; defaultEndpointPromptCachingDepth?: number;
  }

  const fmtLabels: Record<string, string> = {
    openai: "OpenAI", anthropic: "Anthropic", gemini: "Gemini",
    "openai-responses": "OpenAI Responses", "openai-codex": "OpenAI Codex",
  };

  let endpoints = $state<Endpoint[]>([]);
  let loading = $state(true);
  let errorMsg = $state("");

  // Edit/Add modal
  let modalOpen = $state(false);
  let editingIndex = $state<number | null>(null);
  let fName = $state("");
  let fUrl = $state("");
  let fAppendSuffix = $state(true);
  let fApiFormat = $state("openai");
  let fKeyRotation = $state("sticky");
  let fKeyHealth = $state(true);
  let fHeaders = $state("");
  let tokenInput = $state("");
  let bulkInput = $state("");
  let pendingTokens = $state<string[]>([]);
  let pendingDeleteConfirm = $state<Set<number>>(new Set());
  // Generation defaults
  let gTempEnabled = $state(false); let gTemp = $state("");
  let gTopPEnabled = $state(false); let gTopP = $state("");
  let gMaxEnabled = $state(false); let gMax = $state("");
  let gCacheEnabled = $state(false); let gCacheDepth = $state("");

  // Delete modal
  let deletingIndex = $state<number | null>(null);

  // Keys modal
  let keysModalIndex = $state<number | null>(null);
  let keysList = $state<KeyState[]>([]);
  let keysLoading = $state(false);
  let keysError = $state("");

  // Bulk delete tokens modal
  let bulkDeleteOpen = $state(false);

  async function load() {
    try {
      const d = await requestAdminJson<{ endpoints: Endpoint[] }>("/api/endpoints");
      endpoints = d.endpoints ?? [];
    } catch (e) {
      errorMsg = e instanceof Error ? e.message : "Failed to load endpoints";
    } finally {
      loading = false;
    }
  }

  function displayToken(tok: string) {
    if (tok.includes("****")) return tok;
    return tok.length > 20 ? tok.substring(0, 8) + "..." + tok.substring(tok.length - 6) : tok;
  }

  function addTokenFromInput() {
    const val = tokenInput.trim();
    if (!val) return;
    if (val.includes("****")) return toast.show("Cannot add a masked token placeholder", "error");
    if (isDuplicateToken(val, pendingTokens)) return toast.show("That token is already added", "error");
    pendingTokens = [...pendingTokens, val];
    tokenInput = "";
    pendingDeleteConfirm = new Set();
  }

  function importBulk() {
    const result = mergeBulkTokens(pendingTokens, bulkInput);
    if (result.added === 0) return toast.show(result.skipped > 0 ? "No new tokens to import" : "Nothing to import", "error");
    pendingTokens = result.tokens;
    bulkInput = "";
    pendingDeleteConfirm = new Set();
    toast.show(`Imported ${result.added} token${result.added !== 1 ? "s" : ""}${result.skipped > 0 ? ` (${result.skipped} skipped)` : ""}`);
  }

  function requestRemoveToken(idx: number) {
    pendingDeleteConfirm = new Set(pendingDeleteConfirm).add(idx);
  }
  function removeToken(idx: number) {
    const result = removeTokenAt(pendingTokens, pendingDeleteConfirm, idx);
    pendingTokens = result.tokens;
    pendingDeleteConfirm = result.pendingConfirmations;
  }

  function confirmBulkDeleteTokens() {
    const n = pendingTokens.length;
    pendingTokens = [];
    pendingDeleteConfirm = new Set();
    bulkDeleteOpen = false;
    toast.show(`Removed ${n} key${n !== 1 ? "s" : ""}`);
  }

  function setGenDefaults(gd: Endpoint["generationDefaults"]) {
    gTempEnabled = gd?.temperature?.enabled === true;
    gTemp = gd?.temperature?.value != null ? String(gd.temperature.value) : "";
    gTopPEnabled = gd?.top_p?.enabled === true;
    gTopP = gd?.top_p?.value != null ? String(gd.top_p.value) : "";
    gMaxEnabled = gd?.max_tokens?.enabled === true;
    gMax = gd?.max_tokens?.value != null ? String(gd.max_tokens.value) : "";
  }
  function setPromptCaching(pc: Endpoint["promptCaching"]) {
    gCacheEnabled = pc?.enabled === true;
    gCacheDepth = pc?.depth != null ? String(pc.depth) : "";
  }

  async function openAdd() {
    editingIndex = null;
    fName = ""; fUrl = ""; fAppendSuffix = true; fHeaders = "";
    tokenInput = ""; bulkInput = ""; pendingTokens = []; pendingDeleteConfirm = new Set();
    let defaults: Settings | undefined;
    try {
      defaults = (await requestAdminJson<{ settings: Settings }>("/api/settings")).settings;
    } catch { /* fall back to hardcoded defaults */ }
    fApiFormat = defaults?.defaultEndpointApiFormat || "openai";
    fKeyRotation = defaults?.defaultEndpointKeyRotation || "sticky";
    fKeyHealth = defaults?.defaultEndpointKeyHealth !== false;
    if (defaults) {
      setGenDefaults({
        temperature: { enabled: defaults.defaultEndpointTemperatureEnabled ?? false, value: defaults.defaultEndpointTemperature ?? null },
        top_p: { enabled: defaults.defaultEndpointTopPEnabled ?? false, value: defaults.defaultEndpointTopP ?? null },
        max_tokens: { enabled: defaults.defaultEndpointMaxTokensEnabled ?? false, value: defaults.defaultEndpointMaxTokens ?? null },
      });
      setPromptCaching({ enabled: defaults.defaultEndpointPromptCachingEnabled ?? false, depth: defaults.defaultEndpointPromptCachingDepth ?? 2 });
    } else {
      setGenDefaults(undefined); setPromptCaching(undefined);
    }
    modalOpen = true;
  }

  function openEdit(index: number) {
    const ep = endpoints.find((e) => e.index === index);
    if (!ep) return;
    editingIndex = index;
    fName = ep.name || ""; fUrl = ep.url; fAppendSuffix = ep.appendApiSuffix !== false;
    tokenInput = ""; bulkInput = "";
    pendingTokens = [...(ep.tokens || (ep.token ? [ep.token] : []))];
    pendingDeleteConfirm = new Set();
    fHeaders = ep.headers && Object.keys(ep.headers).length > 0 ? JSON.stringify(ep.headers, null, 2) : "";
    fApiFormat = ep.apiFormat || "openai";
    fKeyRotation = ep.keyRotation || "sticky";
    fKeyHealth = ep.keyHealth !== false;
    setGenDefaults(ep.generationDefaults);
    setPromptCaching(ep.promptCaching);
    modalOpen = true;
  }

  function closeModal() {
    modalOpen = false; editingIndex = null; pendingTokens = []; pendingDeleteConfirm = new Set();
  }

  function collectGenDefaults() {
    return {
      temperature: { enabled: gTempEnabled, value: gTempEnabled && gTemp !== "" ? Number(gTemp) : null },
      top_p: { enabled: gTopPEnabled, value: gTopPEnabled && gTopP !== "" ? Number(gTopP) : null },
      max_tokens: { enabled: gMaxEnabled, value: gMaxEnabled && gMax !== "" ? Number(gMax) : null },
    };
  }
  function collectPromptCaching() {
    const depth = gCacheEnabled && gCacheDepth !== "" ? Math.max(0, Math.floor(Number(gCacheDepth))) : 0;
    return { enabled: gCacheEnabled, depth };
  }

  async function submit() {
    const name = fName.trim();
    const url = fUrl.trim();
    // Flush pending token input and bulk textarea
    let finalTokens = [...pendingTokens];
    const pi = tokenInput.trim();
    if (pi && !pi.includes("****") && !isDuplicateToken(pi, finalTokens)) finalTokens.push(pi);
    if (bulkInput.trim()) finalTokens = mergeBulkTokens(finalTokens, bulkInput).tokens;

    if (!url) return toast.show("Please enter a URL", "error");

    let headers: Record<string, string> = {};
    if (fHeaders.trim()) {
      let parsed: unknown;
      try { parsed = JSON.parse(fHeaders); } catch { return toast.show("Invalid JSON in custom headers", "error"); }
      if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return toast.show("Custom headers must be a JSON object", "error");
      headers = parsed as Record<string, string>;
    }

    const payload: Record<string, unknown> = {
      name, url, tokens: finalTokens, headers, apiFormat: fApiFormat, appendApiSuffix: fAppendSuffix,
      keyRotation: fKeyRotation, keyHealth: fKeyHealth,
      generationDefaults: collectGenDefaults(), promptCaching: collectPromptCaching(),
    };
    if (editingIndex !== null) payload.index = editingIndex;

    try {
      await requestAdminJson("/api/endpoints", {
        method: editingIndex !== null ? "PUT" : "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      toast.show(`Endpoint ${editingIndex !== null ? "updated" : "added"} successfully`);
      closeModal();
      await load();
    } catch (e) {
      toast.show(e instanceof Error ? e.message : "Failed", "error");
    }
  }

  async function confirmDelete() {
    if (deletingIndex === null) return;
    try {
      await requestAdminJson("/api/endpoints", { method: "DELETE", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ index: deletingIndex }) });
      toast.show("Endpoint deleted successfully");
      deletingIndex = null;
      await load();
    } catch (e) {
      toast.show(e instanceof Error ? e.message : "Failed", "error");
    }
  }

  async function openKeysModal(index: number) {
    keysModalIndex = index; keysList = []; keysError = ""; keysLoading = true;
    try {
      const d = await requestAdminJson<{ keys?: KeyState[] }>(`/api/endpoints/${index}/keys`);
      keysList = d.keys ?? [];
    } catch (e) {
      keysError = e instanceof Error ? e.message : "Failed to load keys";
    } finally {
      keysLoading = false;
    }
  }

  async function keyAction(path: string, body: Record<string, unknown>, msg: string) {
    if (keysModalIndex === null) return;
    try {
      await requestAdminJson(`/api/endpoints/${keysModalIndex}/keys/${path}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
      toast.show(msg);
      if (keysModalIndex !== null) openKeysModal(keysModalIndex);
    } catch (e) {
      toast.show(e instanceof Error ? e.message : "Failed", "error");
    }
  }

  function keyStatusText(k: KeyState) {
    const labels: Record<string, string> = { active: "Active", invalid: "Invalid", timeout: "Timed out", disabled: "Disabled" };
    const status = k.status || "active";
    if (status === "timeout" && k.disabledUntil) {
      const mins = Math.max(0, Math.round((k.disabledUntil - Date.now()) / 60000));
      return `Timed out (${mins}m left)`;
    }
    return labels[status] || status;
  }

  $effect(() => {
    pageHeaderActions.set({ count: endpoints.length, noun: "endpoint", icon: "fa-solid fa-hexagon-nodes", addLabel: "Add Endpoint", onAdd: openAdd });
  });

  onMount(() => {
    const onDocumentClick = (event: MouseEvent) => {
      if (pendingDeleteConfirm.size === 0) return;
      const target = event.target;
      if (target instanceof Element && target.closest("[data-token-confirm]")) return;
      pendingDeleteConfirm = new Set();
    };
    const onKeydown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      if (bulkDeleteOpen) bulkDeleteOpen = false;
      else if (deletingIndex !== null) deletingIndex = null;
      else if (keysModalIndex !== null) keysModalIndex = null;
      else if (modalOpen) closeModal();
    };

    document.addEventListener("click", onDocumentClick);
    document.addEventListener("keydown", onKeydown);
    void load();

    return () => {
      pageHeaderActions.set(null);
      document.removeEventListener("click", onDocumentClick);
      document.removeEventListener("keydown", onKeydown);
    };
  });
</script>

{#if loading}
  <div class="loading"><div class="loading-spinner"></div><span>Loading endpoints…</span></div>
{:else if errorMsg}
  <div class="page-error" role="alert">{errorMsg}</div>
{:else if endpoints.length === 0}
  <div class="empty-state"><i class="fa-solid fa-server"></i><p>No endpoints configured yet</p><button class="btn btn-primary empty-state-action" type="button" onclick={openAdd}>Add Your First Endpoint</button></div>
{:else}
  <div class="card endpoints-card">
    <div class="card-header"><span class="card-title">Backend Endpoints</span></div>
    <div class="card-body models-list">
      {#each endpoints as ep (ep.index)}
        {@const tokens = ep.tokens || (ep.token ? [ep.token] : [])}
        {@const fmt = ep.apiFormat || "openai"}
        {@const gd = ep.generationDefaults || {}}
        <div class="model-item endpoint-item">
          <div class="model-info">
            <div class="model-icon"><i class="fa-solid fa-server"></i></div>
            <div class="endpoint-meta">
              <div class="model-name">
                <span>{ep.name || `Endpoint ${ep.index}`}</span>
                <span class="api-format-badge {fmt}"><i class="fa-solid fa-plug"></i>{fmtLabels[fmt] || fmt}</span>
                <span class="gen-badge"><i class="fa-solid {ep.keyRotation === 'roundrobin' ? 'fa-arrows-rotate' : 'fa-thumbtack'}"></i>{ep.keyRotation === "roundrobin" ? "Round-robin" : "Sticky"}</span>
                {#if ep.keyHealth === false}<span class="gen-badge health-off"><i class="fa-solid fa-heart-crack"></i>Health off</span>{/if}
                {#if gd.temperature?.enabled && gd.temperature.value !== null}<span class="gen-badge"><i class="fa-solid fa-temperature-half"></i>T={gd.temperature.value}</span>{/if}
                {#if gd.top_p?.enabled && gd.top_p.value !== null}<span class="gen-badge"><i class="fa-solid fa-chart-pie"></i>P={gd.top_p.value}</span>{/if}
                {#if gd.max_tokens?.enabled && gd.max_tokens.value !== null}<span class="gen-badge"><i class="fa-solid fa-stopwatch"></i>Max={gd.max_tokens.value}</span>{/if}
                {#if ep.promptCaching?.enabled}<span class="gen-badge cache"><i class="fa-solid fa-bolt"></i>Cache={ep.promptCaching.depth}</span>{/if}
                {#if ep.headers && Object.keys(ep.headers).length > 0}<span class="gen-badge"><i class="fa-solid fa-code"></i>{Object.keys(ep.headers).length} custom header{Object.keys(ep.headers).length !== 1 ? "s" : ""}</span>{/if}
              </div>
              <div class="model-mapping">{ep.url}</div>
            </div>
          </div>
          <div class="model-actions">
            <button class="btn btn-secondary btn-sm" type="button" onclick={() => openKeysModal(ep.index)}><i class="fa-solid fa-key"></i>{tokens.length} Keys</button>
            <button class="btn btn-secondary btn-sm" type="button" onclick={() => openEdit(ep.index)}><i class="fa-solid fa-pen"></i>Edit</button>
            <button class="btn btn-danger btn-sm" type="button" aria-label={`Delete ${ep.name || `Endpoint ${ep.index}`}`} onclick={() => deletingIndex = ep.index}><i class="fa-solid fa-trash"></i></button>
          </div>
        </div>
      {/each}
    </div>
  </div>
{/if}

<!-- Add/Edit modal -->
{#if modalOpen}
  <div class="modal-backdrop active endpoint-modal-backdrop" transition:fade={{ duration: motionDuration(300) }} onclick={(e) => { if (e.target === e.currentTarget) closeModal(); }} role="presentation">
    <div class="modal endpoint-modal" transition:scale={{ duration: motionDuration(300), start: 0.9 }} role="dialog" aria-modal="true">
      <div class="modal-header"><h2>{editingIndex !== null ? "Edit Endpoint" : "Add Endpoint"}</h2><button class="modal-close" type="button" aria-label="Close endpoint editor" onclick={closeModal}><i class="fa-solid fa-xmark"></i></button></div>

      <div class="modal-body modal-body-grid">
        <div class="modal-body-col">
          <div class="form-group"><label for="epName">Endpoint Name</label><input id="epName" type="text" bind:value={fName} placeholder="e.g., My API Server" /><p class="form-hint">A friendly name to identify this endpoint</p></div>
          <div class="form-group"><label for="epUrl">Endpoint URL</label><input id="epUrl" type="url" bind:value={fUrl} placeholder="e.g., https://api.example.com" /><p class="form-hint">Use a base URL when automatic suffixes are on, or include a provider prefix such as /v4 or /v1beta/openai when off.</p><label class="gen-toggle suffix-toggle"><input type="checkbox" bind:checked={fAppendSuffix} /><span class="gen-toggle-slider"></span><span>Append API version suffix</span></label><p class="form-hint">On adds the format's full versioned route. Off preserves your URL prefix and adds only the operation path.</p></div>
          <div class="form-group">
            <div class="section-label token-heading">API Tokens <span class="token-count">{pendingTokens.length ? `(${pendingTokens.length})` : ""}</span></div>
            <div class="tokens-scroll-list">
              {#if pendingTokens.length === 0}<span class="tokens-empty">No tokens added yet</span>{/if}
              {#each pendingTokens as tok, i (i)}
                <div class="token-pill"><span class="val">{#if tok.includes("****")}<i class="fa-solid fa-lock token-lock"></i>{/if}{displayToken(tok)}</span>{#if pendingDeleteConfirm.has(i)}<button class="confirm-token" data-token-confirm type="button" title="Click again to confirm delete" onclick={() => removeToken(i)}>?</button>{:else}<button class="remove-token" data-token-confirm type="button" onclick={() => requestRemoveToken(i)} aria-label="Remove token"><i class="fa-solid fa-xmark"></i></button>{/if}</div>
              {/each}
            </div>
            <div class="input-row"><input type="password" bind:value={tokenInput} placeholder={editingIndex !== null ? "Add a new token (optional)" : "Paste a token and press Add"} onkeydown={(e) => { if (e.key === "Enter") { e.preventDefault(); addTokenFromInput(); } }} /><button class="btn btn-secondary" type="button" onclick={addTokenFromInput} disabled={!tokenInput.trim()}>Add</button></div>
            <p class="form-hint">Keys are optional. Requests cannot use this endpoint until at least one key is configured.</p>
            <div class="bulk-token-section"><textarea class="bulk-input" bind:value={bulkInput} rows="3" placeholder="Paste many tokens, one per line, then click Import"></textarea><div class="bulk-actions"><button class="btn btn-danger btn-sm" type="button" onclick={() => bulkDeleteOpen = true} disabled={pendingTokens.length === 0}><i class="fa-solid fa-trash"></i> Delete all keys</button><button class="btn btn-secondary btn-sm" type="button" onclick={importBulk} disabled={!bulkInput.trim()}><i class="fa-solid fa-file-import"></i> Import lines</button></div><p class="form-hint">One token per line. Blank lines, duplicates, and masked placeholders are skipped.</p></div>
          </div>
        </div>
        <div class="modal-body-col">
          <div class="form-group"><label for="epHeaders">Custom Headers (JSON)</label><textarea id="epHeaders" bind:value={fHeaders} rows="4" placeholder={'{ "X-Custom-Header": "value" }'}></textarea><p class="form-hint">Add custom request headers as JSON. Example: {`{"X-Custom-Header": "value"}`}</p></div>
          <div class="form-group"><div class="section-label">Generation Settings</div><p class="form-hint gen-hint">Off strips the client value. On with a blank field passes the client value through. On with a value overrides the client.</p>
            <div class="gen-setting-row"><label class="gen-toggle"><input type="checkbox" bind:checked={gTempEnabled} /><span class="gen-toggle-slider"></span><span>Temperature</span></label><input class="gen-input" class:active={gTempEnabled} disabled={!gTempEnabled} type="number" step="0.1" min="0" max="2" bind:value={gTemp} placeholder="1" /></div>
            <div class="gen-setting-row"><label class="gen-toggle"><input type="checkbox" bind:checked={gTopPEnabled} /><span class="gen-toggle-slider"></span><span>Top P</span></label><input class="gen-input" class:active={gTopPEnabled} disabled={!gTopPEnabled} type="number" step="0.05" min="0" max="1" bind:value={gTopP} placeholder="1" /></div>
            <div class="gen-setting-row"><label class="gen-toggle"><input type="checkbox" bind:checked={gMaxEnabled} /><span class="gen-toggle-slider"></span><span>Max Tokens</span></label><input class="gen-input" class:active={gMaxEnabled} disabled={!gMaxEnabled} type="number" step="1" min="1" bind:value={gMax} placeholder="4096" /></div>
          </div>
          <div class="form-group"><div class="section-label">Prompt Caching for Claude</div><p class="form-hint gen-hint">When enabled, cache_control breakpoints are injected into Claude messages. No effect on non-Claude models.</p><div class="gen-setting-row"><label class="gen-toggle"><input type="checkbox" bind:checked={gCacheEnabled} /><span class="gen-toggle-slider"></span><span>Enable caching</span></label><input class="gen-input" class:active={gCacheEnabled} disabled={!gCacheEnabled} type="number" step="1" min="0" bind:value={gCacheDepth} placeholder="2" /></div></div>
        </div>
        <div class="modal-body-col">
          <div class="form-group"><label for="epFmt">API Format</label><select id="epFmt" bind:value={fApiFormat} class="form-select"><option value="openai">OpenAI — /v1/chat/completions (default)</option><option value="anthropic">Anthropic — /v1/messages</option><option value="gemini">Gemini — /v1beta/generateContent</option><option value="openai-responses">OpenAI Responses — /v1/responses</option><option value="openai-codex">OpenAI Codex — /v1/responses</option></select><p class="form-hint">Controls which API path is appended when forwarding requests to this endpoint.</p></div>
          <div class="form-group"><label for="epRot">Key Rotation</label><select id="epRot" bind:value={fKeyRotation} class="form-select"><option value="sticky">Sticky — use the first healthy key until it fails</option><option value="roundrobin">Round-robin — start at a random healthy key, then cycle</option></select><p class="form-hint">How this endpoint picks among its keys. On a 400/401/402/403/429, the request hops to the next healthy key automatically.</p></div>
          <div class="form-group"><label for="epHealth">Key Health</label><select id="epHealth" bind:value={fKeyHealth} class="form-select"><option value={true}>On — bench a key on 401/402/429</option><option value={false}>Off — never bench keys, just hop and return</option></select><p class="form-hint">When on, 401/402 marks a key invalid and 429 times it out temporarily. Turn this off for short-lived RPM/TPM limits so a good key is not parked for hours; requests still hop either way.</p></div>
        </div>
      </div>

      <div class="modal-footer">
        <button class="btn btn-secondary" type="button" onclick={closeModal}>Cancel</button>
        <button class="btn btn-primary" type="button" onclick={submit}>{editingIndex !== null ? "Save Changes" : "Add Endpoint"}</button>
      </div>
    </div>
  </div>
{/if}

<!-- Delete endpoint modal -->
{#if deletingIndex !== null}
  <div class="modal-backdrop active" transition:fade={{ duration: motionDuration(300) }} onclick={(e) => { if (e.target === e.currentTarget) deletingIndex = null; }} role="presentation">
    <div class="modal" transition:scale={{ duration: motionDuration(300), start: 0.9 }} role="dialog" aria-modal="true">
      <div class="modal-header"><h2>Delete Endpoint</h2><button class="modal-close" type="button" onclick={() => deletingIndex = null}>✕</button></div>
      <p>Are you sure you want to delete endpoint <strong>{endpoints.find((e) => e.index === deletingIndex)?.name || `#${deletingIndex}`}</strong>? This cannot be undone.</p>
      <div class="modal-footer">
        <button class="btn btn-secondary" type="button" onclick={() => deletingIndex = null}>Cancel</button>
        <button class="btn btn-danger" type="button" onclick={confirmDelete}>Delete</button>
      </div>
    </div>
  </div>
{/if}

<!-- Key health modal -->
{#if keysModalIndex !== null}
  {@const ep = endpoints.find((e) => e.index === keysModalIndex)}
  <div class="modal-backdrop active" transition:fade={{ duration: motionDuration(300) }} onclick={(e) => { if (e.target === e.currentTarget) keysModalIndex = null; }} role="presentation">
    <div class="modal" style="max-width:760px;" transition:scale={{ duration: motionDuration(300), start: 0.9 }} role="dialog" aria-modal="true">
      <div class="modal-header"><h2>Keys — {ep?.name || `Endpoint ${keysModalIndex}`}</h2><button class="modal-close" type="button" onclick={() => keysModalIndex = null}>✕</button></div>
      {#if keysLoading}
        <div class="loading"><div class="loading-spinner"></div><span>Loading keys…</span></div>
      {:else if keysError}
        <div class="page-error" role="alert">{keysError}</div>
      {:else if keysList.length === 0}
        <p style="color:var(--text-secondary);">No key health data available.</p>
      {:else}
        <div class="key-health-toolbar"><p class="form-hint">Per-key health and usage. Codes 401/402 disable a key; 429 times it out temporarily.</p><div><button class="btn btn-secondary btn-sm" type="button" onclick={() => keyAction("reset", { all: true }, "All keys re-enabled")}><i class="fa-solid fa-rotate-left"></i> Re-enable all</button><button class="btn btn-secondary btn-sm" type="button" onclick={() => keyAction("reset-stats", { all: true }, "All stats reset")}><i class="fa-solid fa-eraser"></i> Reset stats</button></div></div>
        <div class="key-states-list">
          {#each keysList as k (k.tokenHash || k.maskedKey)}
            {@const status = k.status || "active"}
            {@const total = k.totalRequests || 0}
            {@const failed = k.failedRequests || 0}
            <div class="key-state-item">
              <div class="key-state-main">
                <div class="key-state-title"><span class="key-state-code">{k.maskedKey || k.tokenHash || "unknown"}</span><span class="key-status-pill {status}"><i class="fa-solid {status === 'active' ? 'fa-circle-check' : status === 'invalid' ? 'fa-circle-xmark' : status === 'timeout' ? 'fa-clock' : 'fa-ban'}"></i>{keyStatusText(k)}</span></div>
                <div class="key-state-stats"><span class="gen-badge"><i class="fa-solid fa-paper-plane"></i>{total} req</span><span class="gen-badge"><i class="fa-solid fa-circle-exclamation"></i>{failed} fail ({total ? Math.round(failed / total * 100) : 0}%)</span>{#if k.codeCounts}{#each Object.entries(k.codeCounts).sort(([a], [b]) => a.localeCompare(b)) as [code, count]}<span class="gen-badge cache">{code}×{count}</span>{/each}{/if}</div>
              </div>
              <div class="key-state-actions"><button class="btn btn-secondary btn-sm" type="button" title={status === "active" ? "Disable this key" : "Re-enable this key"} onclick={() => keyAction(status === "active" ? "disable" : "reset", { tokenHash: k.tokenHash }, status === "active" ? "Key disabled" : "Key re-enabled")}><i class="fa-solid {status === 'active' ? 'fa-ban' : 'fa-rotate-left'}"></i></button><button class="btn btn-secondary btn-sm" type="button" title="Reset stats for this key" onclick={() => keyAction("reset-stats", { tokenHash: k.tokenHash }, "Stats reset")}><i class="fa-solid fa-eraser"></i></button></div>
            </div>
          {/each}
        </div>
      {/if}
      <div class="modal-footer">
        <button class="btn btn-secondary" type="button" onclick={() => keysModalIndex = null}>Close</button>
      </div>
    </div>
  </div>
{/if}

<!-- Bulk delete tokens confirm -->
{#if bulkDeleteOpen}
  <div class="modal-backdrop active" transition:fade={{ duration: motionDuration(300) }} onclick={(e) => { if (e.target === e.currentTarget) bulkDeleteOpen = false; }} role="presentation">
    <div class="modal" transition:scale={{ duration: motionDuration(300), start: 0.9 }} role="dialog" aria-modal="true">
      <div class="modal-header"><h2>Remove All Tokens</h2><button class="modal-close" type="button" onclick={() => bulkDeleteOpen = false}>✕</button></div>
      <p>Remove all <strong>{pendingTokens.length}</strong> token{pendingTokens.length !== 1 ? "s" : ""} from this endpoint? You can save the endpoint without keys and add them later.</p>
      <div class="modal-footer">
        <button class="btn btn-secondary" type="button" onclick={() => bulkDeleteOpen = false}>Cancel</button>
        <button class="btn btn-danger" type="button" onclick={confirmBulkDeleteTokens}>Remove all</button>
      </div>
    </div>
  </div>
{/if}

<style>
  .empty-state-action { margin-top: 16px; }
  .endpoints-card { overflow: hidden; }
  .card-header { padding: 20px 24px; border-bottom: 1px solid var(--border-color); }
  .card-title { color: var(--text-primary); font-family: Georgia, "Times New Roman", serif; font-size: 16px; font-weight: 500; }
  .card-body { padding: 24px; }
  .models-list { display: flex; flex-direction: column; gap: 10px; }
  .model-item { display: flex; align-items: center; justify-content: space-between; padding: 16px 20px; border: 1px solid var(--border-color); border-radius: 8px; background: var(--bg-secondary); transition: border-color .2s ease; }
  .model-item:hover { border-color: var(--primary); }
  .model-info { display: flex; align-items: center; min-width: 0; flex: 1; gap: 12px; }
  .model-icon { display: flex; width: 40px; height: 40px; align-items: center; justify-content: center; flex-shrink: 0; border-radius: 10px; background: var(--gradient-primary); color: white; }
  .endpoint-meta { min-width: 0; flex: 1; }
  .model-name { display: flex; align-items: center; flex-wrap: wrap; gap: 6px; color: var(--text-primary); font-weight: 500; }
  .model-mapping { margin-top: 2px; overflow-wrap: anywhere; color: var(--text-secondary); font-size: 12px; }
  .model-actions { display: flex; flex-shrink: 0; gap: 8px; }
  .api-format-badge, .gen-badge { display: inline-flex; align-items: center; gap: 4px; padding: 2px 8px; border-radius: 6px; font-family: monospace; font-size: 11px; font-weight: 500; }
  .api-format-badge.openai { background: var(--primary-alpha-01); color: var(--primary); }
  .api-format-badge.anthropic, .cache { background: rgba(217,119,6,.1); color: #d97706; }
  .api-format-badge.gemini { background: rgba(99,102,241,.1); color: #6366f1; }
  .api-format-badge.openai-responses { background: rgba(16,185,129,.1); color: #10b981; }
  .api-format-badge.openai-codex { background: rgba(20,184,166,.1); color: #14b8a6; }
  .gen-badge { background: var(--gray-100); color: var(--gray-600); }
  .health-off { background: rgba(220,38,38,.1); color: #dc2626; }
  :global(.endpoint-modal-backdrop) { padding: 24px; background: rgba(24, 17, 31, .58); backdrop-filter: blur(3px); }
  :global(.modal-backdrop .endpoint-modal) { display: flex; width: 100%; max-width: 1200px; max-height: calc(100vh - 48px); flex-direction: column; padding: 0; overflow: hidden; border: 1px solid var(--border-color); border-radius: 11px; background: var(--card-bg); box-shadow: 0 24px 70px rgba(25, 15, 35, .24); }
  :global(.endpoint-modal .modal-header) { flex-shrink: 0; margin: 0; padding: 20px 24px; border-bottom: 1px solid var(--border-color); }
  :global(.endpoint-modal .modal-header h2) { color: var(--text-primary); font: 500 18px/1.2 Georgia, "Times New Roman", serif; }
  :global(.endpoint-modal .modal-close) { display: flex; width: 32px; height: 32px; align-items: center; justify-content: center; padding: 0; border-radius: 8px; background: var(--bg-tertiary); color: var(--text-secondary); font-size: 14px; transition: background .2s ease, color .2s ease; }
  :global(.endpoint-modal .modal-close:hover) { background: var(--gray-200); color: var(--text-primary); }
  .modal-body { min-height: 0; flex: 1; padding: 24px; overflow-y: auto; }
  .modal-body-grid { display: grid; grid-template-columns: 1.5fr 1fr 1fr; align-items: start; gap: 24px; }
  .modal-body-col { min-width: 0; }
  .modal-body-col :global(.form-group:last-child) { margin-bottom: 0; }
  :global(.endpoint-modal .form-group) { margin-bottom: 20px; }
  :global(.endpoint-modal .form-group > label:not(.gen-toggle)), .section-label { display: block; margin-bottom: 8px; color: var(--text-secondary); font-size: 11px; font-weight: 700; letter-spacing: .03em; text-transform: none; }
  :global(.endpoint-modal .form-group > input), :global(.endpoint-modal .form-group > select), :global(.endpoint-modal .form-group > textarea), :global(.endpoint-modal .input-row input), :global(.endpoint-modal .gen-input) { padding: 12px 16px; border: 1px solid var(--input-border); border-radius: 8px; background: var(--input-bg); color: var(--text-primary); font: 14px/normal Inter, ui-sans-serif, system-ui, sans-serif; transition: border-color .2s ease, box-shadow .2s ease, background .2s ease; }
  :global(.endpoint-modal .form-group input:focus), :global(.endpoint-modal .form-group select:focus), :global(.endpoint-modal .form-group textarea:focus) { outline: none; border-color: var(--primary); background-color: var(--card-bg); box-shadow: 0 0 0 3px var(--primary-alpha-01); }
  :global(.endpoint-modal .form-select) { min-width: 0; padding-right: 36px; appearance: none; background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='12' viewBox='0 0 12 12'%3E%3Cpath fill='%236b7280' d='M6 8L1 3h10z'/%3E%3C/svg%3E"); background-repeat: no-repeat; background-position: right 14px center; }
  :global(.endpoint-modal .modal-footer) { flex-shrink: 0; gap: 12px; margin: 0; padding: 16px 24px; border-top: 1px solid var(--border-color); }
  .form-hint { margin: 6px 0 0; color: var(--text-secondary); font-size: 12px; line-height: 1.45; }
  .suffix-toggle { margin-top: 10px; }
  .token-heading { margin-bottom: 8px; }
  .section-label { color: var(--text-secondary); }
  .token-count { color: var(--text-secondary); font-weight: 400; }
  .tokens-scroll-list { display: flex; min-height: 36px; max-height: 160px; flex-direction: column; gap: 6px; margin-bottom: 8px; padding: 8px; overflow-y: auto; border: 1px solid var(--border-color); border-radius: 10px; background: var(--bg-tertiary); scrollbar-color: var(--gray-300) transparent; scrollbar-width: thin; }
  .tokens-empty { margin: auto; color: var(--text-secondary); font-size: 12px; }
  .token-pill { display: flex; width: 100%; box-sizing: border-box; align-items: center; gap: 8px; padding: 6px 12px; border: 1px solid var(--border-color); border-radius: 10px; background: var(--gray-100); color: var(--gray-700); font-family: monospace; font-size: 13px; }
  .token-pill .val { min-width: 0; flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .token-lock { margin-right: 6px; color: var(--gray-400); font-size: 10px; }
  .remove-token, .confirm-token { border: 0; cursor: pointer; }
  .remove-token { padding: 2px 4px; border-radius: 6px; background: var(--gray-200); color: var(--gray-500); }
  .confirm-token { padding: 2px 7px; border-radius: 12px; background: #d97706; color: white; font-size: 11px; font-weight: 600; }
  .input-row { display: flex; gap: 8px; }
  .input-row input { min-width: 0; flex: 1; }
  .bulk-token-section { margin-top: 10px; }
  .bulk-input { width: 100%; box-sizing: border-box; resize: vertical; overflow-x: auto; font-family: monospace; font-size: 13px; white-space: pre; overflow-wrap: normal; }
  .bulk-actions { display: flex; align-items: center; justify-content: space-between; gap: 8px; margin-top: 6px; }
  .bulk-actions .btn { white-space: nowrap; }
  .gen-hint { margin-bottom: 12px; }
  .gen-setting-row { display: flex; align-items: center; gap: 12px; margin-bottom: 12px; }
  .gen-toggle { display: inline-flex; align-items: center; flex: 1; gap: 10px; color: var(--gray-700); font-size: 14px; font-weight: 500; cursor: pointer; user-select: none; }
  .gen-toggle input { display: none; }
  .gen-toggle-slider { position: relative; width: 40px; height: 22px; flex-shrink: 0; border-radius: 22px; background: var(--gray-300); transition: background .2s ease; }
  .gen-toggle-slider::after { content: ""; position: absolute; top: 2px; left: 2px; width: 18px; height: 18px; border-radius: 50%; background: white; transition: transform .2s ease; }
  .gen-toggle input:checked + .gen-toggle-slider { background: var(--primary-dark); }
  .gen-toggle input:checked + .gen-toggle-slider::after { transform: translateX(18px); }
  .gen-input { width: 120px; flex-shrink: 0; opacity: .5; pointer-events: none; }
  .gen-input.active { opacity: 1; pointer-events: auto; }
  .key-health-toolbar { display: flex; align-items: center; justify-content: space-between; flex-wrap: wrap; gap: 12px; margin-bottom: 16px; }
  .key-health-toolbar p { margin: 0; }
  .key-health-toolbar > div { display: flex; gap: 8px; }
  .key-states-list { display: flex; max-height: 460px; flex-direction: column; gap: 10px; overflow-y: auto; }
  .key-state-item { display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 12px 14px; border: 1px solid var(--border-color); border-radius: 8px; background: var(--bg-secondary); }
  .key-state-main { display: flex; min-width: 0; flex-direction: column; gap: 6px; }
  .key-state-title, .key-state-stats { display: flex; align-items: center; flex-wrap: wrap; gap: 6px; }
  .key-state-title { gap: 10px; }
  .key-state-code { color: var(--text-primary); font-family: monospace; font-size: 13px; font-weight: 600; }
  .key-state-actions { display: flex; flex-shrink: 0; gap: 8px; }
  .key-status-pill { display: inline-flex; align-items: center; gap: 5px; padding: 3px 10px; border-radius: 20px; font-size: 12px; font-weight: 500; white-space: nowrap; }
  .key-status-pill.active { background: var(--success-alpha-01); color: var(--success); }
  .key-status-pill.invalid { background: var(--danger-alpha-01); color: var(--danger); }
  .key-status-pill.timeout { background: rgba(217,119,6,.1); color: #d97706; }
  .key-status-pill.disabled { background: var(--gray-200); color: var(--gray-600); }
  @media (max-width: 768px) {
    :global(.endpoint-modal-backdrop) { padding: 2.5vw; }
    :global(.modal-backdrop .endpoint-modal) { max-width: 95vw; max-height: 95vh; }
    .modal-body-grid { grid-template-columns: 1fr; }
  }
  @media (max-width: 720px) { .model-item, .key-state-item { align-items: flex-start; flex-direction: column; gap: 12px; } .model-actions, .key-state-actions { align-self: flex-end; flex-wrap: wrap; } }
</style>
