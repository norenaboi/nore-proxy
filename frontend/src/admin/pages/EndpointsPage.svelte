<script lang="ts">
  import { onMount } from "svelte";
  import { fade, scale, slide } from "svelte/transition";
  import { requestAdminJson } from "$frontend/lib/api/admin";
  import { motionDuration } from "$frontend/lib/motion";
  import {
    bodyParamCounts,
    emptyHeaderPresets,
    extractHeaderPresets,
    isDuplicateToken,
    mergeBulkTokens,
    mergeHeaderPresets,
    parseBodyParams,
    parseCustomHeaders,
    parseStripBodyParams,
    removeTokenAt,
    serializeBodyParams,
    serializeCustomHeaders,
    serializeStripBodyParams,
    type BodyParamPolicy,
    type HeaderPresets,
  } from "$frontend/lib/endpoints/editor";
  import { pageHeaderActions, toast } from "$frontend/lib/stores";

  interface GenDefault { enabled: boolean; value: number | null; }
  interface Endpoint {
    index: number; name?: string; url: string; token?: string; tokens?: string[];
    apiFormat?: string; appendApiSuffix?: boolean; keyRotation?: string; keyHealth?: boolean; retryAttempts?: number;
    headers?: Record<string, string>;
    bodyParams?: BodyParamPolicy | null;
    proxyId?: string | null;
    generationDefaults?: { temperature?: GenDefault; top_p?: GenDefault; max_tokens?: GenDefault };
    promptCaching?: { enabled: boolean; depth: number; ttl?: "1h" };
  }
  interface ProxyOption { id: string; name: string; type: string; host: string; port: number; }
  interface KeyState {
    tokenHash?: string; maskedKey?: string; status?: string; disabledUntil?: number;
    totalRequests?: number; failedRequests?: number; codeCounts?: Record<string, number>;
  }
  interface Settings {
    defaultEndpointApiFormat?: string; defaultEndpointKeyRotation?: string; defaultEndpointKeyHealth?: boolean; defaultEndpointRetryAttempts?: number;
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
  let proxies = $state<ProxyOption[]>([]);
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
  let fRetryAttempts = $state(0);
  let fHeaders = $state("");
  let fHeaderPresets = $state<HeaderPresets>(emptyHeaderPresets());
  let fBodyParamsAdd = $state("");
  let fBodyParamsStrip = $state("");
  let tokenInput = $state("");
  let bulkInput = $state("");
  let bulkOpen = $state(false);
  let pendingTokens = $state<string[]>([]);
  let pendingDeleteConfirm = $state<Set<number>>(new Set());
  let fProxyId = $state("");
  // Generation defaults
  let gTempEnabled = $state(false); let gTemp = $state("");
  let gTopPEnabled = $state(false); let gTopP = $state("");
  let gMaxEnabled = $state(false); let gMax = $state("");
  let gCacheEnabled = $state(false); let gCacheDepth = $state(""); let gCacheOneHour = $state(false);

  // Advanced Settings disclosures. Only one is open at a time, so the column's
  // height stays predictable inside the fixed-height modal and expanding a
  // section never pushes the one you were reading off screen. null = all closed.
  type AdvancedSection = "generation" | "caching" | "headers" | "bodyParams" | "keys";
  let openSection = $state<AdvancedSection | null>(null);

  function toggleSection(section: AdvancedSection) {
    openSection = openSection === section ? null : section;
  }

  // Each collapsed section states what it currently holds, so an operator can
  // see that an endpoint overrides temperature or strips a param without
  // expanding all five sections to look.
  const genSummary = $derived.by(() => {
    const parts: string[] = [];
    if (gTempEnabled) parts.push(gTemp !== "" ? `T=${gTemp}` : "T pass");
    if (gTopPEnabled) parts.push(gTopP !== "" ? `P=${gTopP}` : "P pass");
    if (gMaxEnabled) parts.push(gMax !== "" ? `Max=${gMax}` : "Max pass");
    return parts.length ? parts.join(" · ") : "All stripped";
  });
  const cacheSummary = $derived(
    gCacheEnabled ? `Depth ${gCacheDepth || 0}${gCacheOneHour ? " · 1h" : ""}` : "Off",
  );
  const headersSummary = $derived.by(() => {
    const presetCount = [fHeaderPresets.anthropicBeta, fHeaderPresets.anthropicVersion, fHeaderPresets.userAgent].filter(Boolean).length;
    const parsed = parseCustomHeaders(fHeaders);
    const otherCount = parsed.ok ? Object.keys(parsed.headers).length : 0;
    const total = presetCount + otherCount;
    return total === 0 ? "None" : `${total} header${total !== 1 ? "s" : ""}`;
  });
  const bodyParamsSummary = $derived.by(() => {
    const added = parseBodyParams(fBodyParamsAdd);
    const stripped = parseStripBodyParams(fBodyParamsStrip);
    const addedCount = added.ok ? Object.keys(added.params).length : 0;
    const strippedCount = stripped.ok ? stripped.names.length : 0;
    if (addedCount === 0 && strippedCount === 0) return "None";
    const parts: string[] = [];
    if (addedCount) parts.push(`${addedCount} added`);
    if (strippedCount) parts.push(`${strippedCount} stripped`);
    return parts.join(" · ");
  });
  const keySummary = $derived(
    `${fKeyRotation === "roundrobin" ? "Round-robin" : "Sticky"} · health ${fKeyHealth ? "on" : "off"} · ${fRetryAttempts} retr${fRetryAttempts === 1 ? "y" : "ies"}`,
  );

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
      // Proxy names feed the editor's select and the list badge; a failure
      // here degrades to "None/unknown" rather than breaking the page.
      try {
        const p = await requestAdminJson<{ proxies: ProxyOption[] }>("/api/proxies");
        proxies = p.proxies ?? [];
      } catch {
        proxies = [];
      }
    } catch (e) {
      errorMsg = e instanceof Error ? e.message : "Failed to load endpoints";
    } finally {
      loading = false;
    }
  }

  function proxyLabel(id: string): string {
    const proxy = proxies.find((p) => p.id === id);
    if (proxy) return proxy.name || `${proxy.type} ${proxy.host}:${proxy.port}`;
    return `Unknown proxy (${id})`;
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
    gCacheOneHour = pc?.ttl === "1h";
  }

  async function openAdd() {
    editingIndex = null;
    fName = ""; fUrl = ""; fAppendSuffix = true; fHeaders = ""; fHeaderPresets = emptyHeaderPresets();
    fBodyParamsAdd = ""; fBodyParamsStrip = ""; fProxyId = "";
    tokenInput = ""; bulkInput = ""; bulkOpen = false; pendingTokens = []; pendingDeleteConfirm = new Set();
    openSection = null;
    let defaults: Settings | undefined;
    try {
      defaults = (await requestAdminJson<{ settings: Settings }>("/api/settings")).settings;
    } catch { /* fall back to hardcoded defaults */ }
    fApiFormat = defaults?.defaultEndpointApiFormat || "openai";
    fKeyRotation = defaults?.defaultEndpointKeyRotation || "sticky";
    fKeyHealth = defaults?.defaultEndpointKeyHealth !== false;
    fRetryAttempts = defaults?.defaultEndpointRetryAttempts ?? 0;
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
    tokenInput = ""; bulkInput = ""; bulkOpen = false;
    openSection = null;
    pendingTokens = [...(ep.tokens || (ep.token ? [ep.token] : []))];
    pendingDeleteConfirm = new Set();
    const extracted = extractHeaderPresets(ep.headers);
    fHeaderPresets = extracted.presets;
    fHeaders = serializeCustomHeaders(extracted.rest);
    fBodyParamsAdd = serializeBodyParams(ep.bodyParams?.add);
    fBodyParamsStrip = serializeStripBodyParams(ep.bodyParams?.strip);
    fApiFormat = ep.apiFormat || "openai";
    fKeyRotation = ep.keyRotation || "sticky";
    fKeyHealth = ep.keyHealth !== false;
    fRetryAttempts = ep.retryAttempts ?? 0;
    fProxyId = ep.proxyId ?? "";
    setGenDefaults(ep.generationDefaults);
    setPromptCaching(ep.promptCaching);
    modalOpen = true;
  }

  function closeModal() {
    modalOpen = false; editingIndex = null; pendingTokens = []; pendingDeleteConfirm = new Set();
    fHeaderPresets = emptyHeaderPresets();
    openSection = null; bulkOpen = false;
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
    return {
      enabled: gCacheEnabled,
      depth,
      ...(gCacheEnabled && gCacheOneHour ? { ttl: "1h" as const } : {}),
    };
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
    if (!Number.isInteger(fRetryAttempts) || fRetryAttempts < 0 || fRetryAttempts > 10) return toast.show("Retry attempts must be 0–10", "error");

    if (fHeaderPresets.userAgent && !fHeaderPresets.userAgentValue.trim()) {
      return toast.show("Enter a User-Agent value or turn the header off", "error");
    }
    const parsedHeaders = parseCustomHeaders(fHeaders);
    if (!parsedHeaders.ok) return toast.show(parsedHeaders.error, "error");
    const headers = mergeHeaderPresets(parsedHeaders.headers, fHeaderPresets);

    const parsedBodyAdd = parseBodyParams(fBodyParamsAdd);
    if (!parsedBodyAdd.ok) return toast.show(parsedBodyAdd.error, "error");
    const parsedBodyStrip = parseStripBodyParams(fBodyParamsStrip);
    if (!parsedBodyStrip.ok) return toast.show(parsedBodyStrip.error, "error");

    const payload: Record<string, unknown> = {
      name, url, tokens: finalTokens, headers, apiFormat: fApiFormat, appendApiSuffix: fAppendSuffix,
      keyRotation: fKeyRotation, keyHealth: fKeyHealth, retryAttempts: fRetryAttempts,
      generationDefaults: collectGenDefaults(), promptCaching: collectPromptCaching(),
      bodyParams: { add: parsedBodyAdd.params, strip: parsedBodyStrip.names },
      proxyId: fProxyId || null,
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
      const result = await requestAdminJson<{ deletedModels?: number; updatedAutoModels?: string[]; emptiedAutoModels?: string[] }>(
        "/api/endpoints",
        { method: "DELETE", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ index: deletingIndex }) },
      );
      const deletedModels = result.deletedModels ?? 0;
      const updated = result.updatedAutoModels ?? [];
      const emptied = result.emptiedAutoModels ?? [];
      toast.show(
        deletedModels
          ? `Endpoint deleted along with ${deletedModels} model${deletedModels === 1 ? "" : "s"}${updated.length ? `, removed from ${updated.length} auto model${updated.length === 1 ? "" : "s"}` : ""}`
          : "Endpoint deleted successfully",
      );
      if (emptied.length) {
        toast.show(`${emptied.join(", ")} ${emptied.length === 1 ? "has" : "have"} no targets left and cannot serve requests`, "error");
      }
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
  <div class="card skeleton" aria-hidden="true">
    <div class="skeleton-head">
      <span class="skeleton-block skeleton-eyebrow"></span>
      <span class="skeleton-block skeleton-heading"></span>
    </div>
    <div class="skeleton-rows">
      {#each Array(4) as _}
        <div class="skeleton-row">
          <span class="skeleton-block skeleton-cell wide"></span>
          <span class="skeleton-block skeleton-cell"></span>
          <span class="skeleton-block skeleton-cell narrow"></span>
        </div>
      {/each}
    </div>
  </div>
  <span class="sr-only" role="status">Loading endpoints…</span>
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
                {#if (ep.retryAttempts ?? 0) > 0}<span class="gen-badge"><i class="fa-solid fa-rotate-right"></i>Retries={ep.retryAttempts}</span>{/if}
                {#if gd.temperature?.enabled && gd.temperature.value !== null}<span class="gen-badge"><i class="fa-solid fa-temperature-half"></i>T={gd.temperature.value}</span>{/if}
                {#if gd.top_p?.enabled && gd.top_p.value !== null}<span class="gen-badge"><i class="fa-solid fa-chart-pie"></i>P={gd.top_p.value}</span>{/if}
                {#if gd.max_tokens?.enabled && gd.max_tokens.value !== null}<span class="gen-badge"><i class="fa-solid fa-stopwatch"></i>Max={gd.max_tokens.value}</span>{/if}
                {#if ep.promptCaching?.enabled}<span class="gen-badge cache"><i class="fa-solid fa-bolt"></i>Cache={ep.promptCaching.depth}{ep.promptCaching.ttl === "1h" ? " · 1h" : ""}</span>{/if}
                {#if ep.proxyId}<span class="gen-badge"><i class="fa-solid fa-network-wired"></i>{proxyLabel(ep.proxyId)}</span>{/if}
                {#if ep.headers && Object.keys(ep.headers).length > 0}<span class="gen-badge"><i class="fa-solid fa-code"></i>{Object.keys(ep.headers).length} custom header{Object.keys(ep.headers).length !== 1 ? "s" : ""}</span>{/if}
                {#if bodyParamCounts(ep.bodyParams).added > 0}<span class="gen-badge"><i class="fa-solid fa-plus"></i>{bodyParamCounts(ep.bodyParams).added} body param{bodyParamCounts(ep.bodyParams).added !== 1 ? "s" : ""}</span>{/if}
                {#if bodyParamCounts(ep.bodyParams).stripped > 0}<span class="gen-badge"><i class="fa-solid fa-scissors"></i>{bodyParamCounts(ep.bodyParams).stripped} stripped</span>{/if}
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
          <div class="form-group"><label for="epName">Endpoint Name</label><input id="epName" type="text" bind:value={fName} placeholder="e.g., My API Server" /></div>
          <div class="form-group"><label for="epUrl">Endpoint URL</label><input id="epUrl" type="url" bind:value={fUrl} placeholder="e.g., https://api.example.com" /><label class="gen-toggle suffix-toggle"><input type="checkbox" bind:checked={fAppendSuffix} /><span class="gen-toggle-slider"></span><span>Append API version suffix (/v1)</span></label></div>
          <div class="form-group"><label for="epFmt">API Format</label><select id="epFmt" bind:value={fApiFormat} class="form-select"><option value="openai">OpenAI — /v1/chat/completions (default)</option><option value="anthropic">Anthropic — /v1/messages</option><option value="gemini">Gemini — /v1beta/generateContent</option><option value="openai-responses">OpenAI Responses — /v1/responses</option><option value="openai-codex">OpenAI Codex — /v1/responses</option></select></div>
          <div class="form-group">
            <label for="epProxy">Outbound Proxy</label>
            <select id="epProxy" bind:value={fProxyId} class="form-select">
              <option value="">None — connect directly</option>
              {#if editingIndex !== null && fProxyId && !proxies.some((p) => p.id === fProxyId)}
                <option value={fProxyId}>Unknown proxy ({fProxyId})</option>
              {/if}
              {#each proxies as proxy (proxy.id)}
                <option value={proxy.id}>{proxy.name || proxy.id} · {proxy.type} · {proxy.host}:{proxy.port}</option>
              {/each}
            </select>
            <p class="form-hint">Routes this endpoint's upstream traffic through the selected proxy. Manage proxies on the Proxies page.</p>
          </div>
          <div class="form-group">
            <div class="section-label token-heading">API Tokens <span class="token-count">{pendingTokens.length ? `(${pendingTokens.length})` : ""}</span></div>
            <div class="tokens-scroll-list">
              {#if pendingTokens.length === 0}<span class="tokens-empty">No tokens added yet</span>{/if}
              {#each pendingTokens as tok, i (i)}
                <div class="token-pill"><span class="val">{#if tok.includes("****")}<i class="fa-solid fa-lock token-lock"></i>{/if}{displayToken(tok)}</span>{#if pendingDeleteConfirm.has(i)}<button class="confirm-token" data-token-confirm type="button" title="Click again to confirm delete" onclick={() => removeToken(i)}>?</button>{:else}<button class="remove-token" data-token-confirm type="button" onclick={() => requestRemoveToken(i)} aria-label="Remove token"><i class="fa-solid fa-xmark"></i></button>{/if}</div>
              {/each}
            </div>
            <div class="input-row"><input type="password" bind:value={tokenInput} placeholder={editingIndex !== null ? "Add a new token (optional)" : "Paste a token and press Add"} onkeydown={(e) => { if (e.key === "Enter") { e.preventDefault(); addTokenFromInput(); } }} /><button class="btn btn-secondary" type="button" onclick={addTokenFromInput} disabled={!tokenInput.trim()}>Add</button></div>
            <div class="disclosure bulk-disclosure" class:open={bulkOpen}>
              <button class="disclosure-head" type="button" aria-expanded={bulkOpen} aria-controls="epBulkTokens" onclick={() => bulkOpen = !bulkOpen}>
                <i class="fa-solid fa-chevron-right disclosure-chevron" class:open={bulkOpen}></i>
                <span class="disclosure-title">Bulk import</span>
                <span class="disclosure-summary" class:hidden={bulkOpen}>{bulkInput.trim() ? "Unimported lines" : "Paste many keys"}</span>
              </button>
              {#if bulkOpen}
                <div class="disclosure-body" id="epBulkTokens" transition:slide={{ duration: motionDuration(220) }}>
                  <textarea class="bulk-input" bind:value={bulkInput} rows="3" placeholder="Paste many tokens, one per line, then click Import"></textarea>
                  <div class="bulk-actions">
                    <button class="btn btn-danger btn-sm" type="button" onclick={() => bulkDeleteOpen = true} disabled={pendingTokens.length === 0}><i class="fa-solid fa-trash"></i> Delete all keys</button>
                    <button class="btn btn-secondary btn-sm" type="button" onclick={importBulk} disabled={!bulkInput.trim()}><i class="fa-solid fa-file-import"></i> Import lines</button>
                  </div>
                </div>
              {/if}
            </div>
          </div>
        </div>

        <div class="modal-body-col">
          <div class="advanced-heading">Advanced Settings</div>

          <div class="disclosure" class:open={openSection === "generation"}>
            <button class="disclosure-head" type="button" aria-expanded={openSection === "generation"} aria-controls="epGeneration" onclick={() => toggleSection("generation")}>
              <i class="fa-solid fa-chevron-right disclosure-chevron" class:open={openSection === "generation"}></i>
              <span class="disclosure-title">Generation Settings</span>
              <span class="disclosure-summary" class:hidden={openSection === "generation"}>{genSummary}</span>
            </button>
            {#if openSection === "generation"}
              <div class="disclosure-body" id="epGeneration" transition:slide={{ duration: motionDuration(220) }}>
                <p class="form-hint gen-hint">Off strips the client value. On with a blank field passes the client value through. On with a value overrides the client.</p>
                <div class="gen-setting-row"><label class="gen-toggle"><input type="checkbox" bind:checked={gTempEnabled} /><span class="gen-toggle-slider"></span><span>Temperature</span></label><input class="gen-input" class:active={gTempEnabled} disabled={!gTempEnabled} type="number" step="0.1" min="0" max="2" bind:value={gTemp} placeholder="1" /></div>
                <div class="gen-setting-row"><label class="gen-toggle"><input type="checkbox" bind:checked={gTopPEnabled} /><span class="gen-toggle-slider"></span><span>Top P</span></label><input class="gen-input" class:active={gTopPEnabled} disabled={!gTopPEnabled} type="number" step="0.05" min="0" max="1" bind:value={gTopP} placeholder="1" /></div>
                <div class="gen-setting-row last-row"><label class="gen-toggle"><input type="checkbox" bind:checked={gMaxEnabled} /><span class="gen-toggle-slider"></span><span>Max Tokens</span></label><input class="gen-input" class:active={gMaxEnabled} disabled={!gMaxEnabled} type="number" step="1" min="1" bind:value={gMax} placeholder="4096" /></div>
              </div>
            {/if}
          </div>

          <div class="disclosure" class:open={openSection === "caching"}>
            <button class="disclosure-head" type="button" aria-expanded={openSection === "caching"} aria-controls="epCaching" onclick={() => toggleSection("caching")}>
              <i class="fa-solid fa-chevron-right disclosure-chevron" class:open={openSection === "caching"}></i>
              <span class="disclosure-title">Prompt Caching for Claude</span>
              <span class="disclosure-summary" class:hidden={openSection === "caching"}>{cacheSummary}</span>
            </button>
            {#if openSection === "caching"}
              <div class="disclosure-body" id="epCaching" transition:slide={{ duration: motionDuration(220) }}>
                <p class="form-hint gen-hint">When enabled, cache_control breakpoints are injected into Claude messages. No effect on non-Claude models.</p>
                <div class="gen-setting-row"><label class="gen-toggle"><input type="checkbox" bind:checked={gCacheEnabled} /><span class="gen-toggle-slider"></span><span>Enable caching</span></label><input class="gen-input" class:active={gCacheEnabled} disabled={!gCacheEnabled} type="number" step="1" min="0" bind:value={gCacheDepth} placeholder="2" /></div>
                <div class="gen-setting-row cache-ttl-row last-row"><label class="gen-toggle" class:disabled={!gCacheEnabled}><input type="checkbox" bind:checked={gCacheOneHour} disabled={!gCacheEnabled} /><span class="gen-toggle-slider"></span><span>Caching for 1hr</span></label></div>
              </div>
            {/if}
          </div>

          <div class="disclosure" class:open={openSection === "headers"}>
            <button class="disclosure-head" type="button" aria-expanded={openSection === "headers"} aria-controls="epHeadersSection" onclick={() => toggleSection("headers")}>
              <i class="fa-solid fa-chevron-right disclosure-chevron" class:open={openSection === "headers"}></i>
              <span class="disclosure-title">Custom Headers</span>
              <span class="disclosure-summary" class:hidden={openSection === "headers"}>{headersSummary}</span>
            </button>
            {#if openSection === "headers"}
              <div class="disclosure-body" id="epHeadersSection" transition:slide={{ duration: motionDuration(220) }}>
                <div class="gen-setting-row header-preset-row header-preset-pair">
                  <label class="gen-toggle"><input type="checkbox" bind:checked={fHeaderPresets.anthropicBeta} /><span class="gen-toggle-slider"></span><span class="header-preset-text"><span class="header-preset-name">anthropic-beta</span><span class="header-preset-value">context-1m-2025-08-07</span></span></label>
                  <label class="gen-toggle"><input type="checkbox" bind:checked={fHeaderPresets.anthropicVersion} /><span class="gen-toggle-slider"></span><span class="header-preset-text"><span class="header-preset-name">anthropic-version</span><span class="header-preset-value">2023-06-01</span></span></label>
                </div>
                <div class="gen-setting-row header-preset-row header-preset-custom">
                  <label class="gen-toggle"><input type="checkbox" bind:checked={fHeaderPresets.userAgent} /><span class="gen-toggle-slider"></span><span class="header-preset-text"><span class="header-preset-name">User-Agent</span></span></label>
                  <input class="header-value-input" class:active={fHeaderPresets.userAgent} disabled={!fHeaderPresets.userAgent} type="text" bind:value={fHeaderPresets.userAgentValue} placeholder="e.g., my-app/1.0" aria-label="User-Agent header value" />
                </div>
                <label class="headers-list-label" for="epHeaders">Other headers (one per line)</label>
                <textarea id="epHeaders" class="headers-input" bind:value={fHeaders} rows="4" placeholder={"X-Custom-Header: value\nX-Another-Header: value"}></textarea>
              </div>
            {/if}
          </div>

          <div class="disclosure" class:open={openSection === "bodyParams"}>
            <button class="disclosure-head" type="button" aria-expanded={openSection === "bodyParams"} aria-controls="epBodyParams" onclick={() => toggleSection("bodyParams")}>
              <i class="fa-solid fa-chevron-right disclosure-chevron" class:open={openSection === "bodyParams"}></i>
              <span class="disclosure-title">Custom Body Params</span>
              <span class="disclosure-summary" class:hidden={openSection === "bodyParams"}>{bodyParamsSummary}</span>
            </button>
            {#if openSection === "bodyParams"}
              <div class="disclosure-body" id="epBodyParams" transition:slide={{ duration: motionDuration(220) }}>
                <label class="headers-list-label first-label" for="epBodyAdd">Add params (one per line)</label>
                <textarea id="epBodyAdd" class="headers-input" bind:value={fBodyParamsAdd} rows="4" placeholder={"reasoning_effort: high\nstop: [\"\\n\\n\", \"END\"]\nsafety_settings: {\"threshold\": \"BLOCK_NONE\"}"}></textarea>
                <label class="headers-list-label" for="epBodyStrip">Strip params (one per line)</label>
                <textarea id="epBodyStrip" class="headers-input" bind:value={fBodyParamsStrip} rows="3" placeholder={"frequency_penalty\npresence_penalty"}></textarea>
              </div>
            {/if}
          </div>

          <div class="disclosure" class:open={openSection === "keys"}>
            <button class="disclosure-head" type="button" aria-expanded={openSection === "keys"} aria-controls="epKeySettings" onclick={() => toggleSection("keys")}>
              <i class="fa-solid fa-chevron-right disclosure-chevron" class:open={openSection === "keys"}></i>
              <span class="disclosure-title">Key Settings</span>
              <span class="disclosure-summary" class:hidden={openSection === "keys"}>{keySummary}</span>
            </button>
            {#if openSection === "keys"}
              <div class="disclosure-body" id="epKeySettings" transition:slide={{ duration: motionDuration(220) }}>
                <div class="gen-setting-row key-settings-row">
                  <label class="gen-toggle key-toggle">
                    <input type="checkbox" checked={fKeyRotation === "roundrobin"} onchange={(e) => fKeyRotation = e.currentTarget.checked ? "roundrobin" : "sticky"} />
                    <span class="gen-toggle-slider"></span>
                    <span>Round-robin</span>
                  </label>
                  <label class="gen-toggle key-toggle">
                    <input type="checkbox" bind:checked={fKeyHealth} />
                    <span class="gen-toggle-slider"></span>
                    <span>Key health</span>
                  </label>
                  <label class="key-retry-field">
                    <span>Retries</span>
                    <input class="gen-input active key-retry-input" type="number" min="0" max="10" step="1" bind:value={fRetryAttempts} />
                  </label>
                </div>
                <div class="key-hints">
                  <p class="form-hint"><strong>Round-robin</strong> off keeps using the first healthy key until it fails. On starts at a random healthy key, then cycles.</p>
                  <p class="form-hint"><strong>Key health</strong> on benches a failing key: 401/402 marks it invalid, 429 times it out for a while. Off leaves every key in play, which suits short-lived RPM limits.</p>
                  <p class="form-hint"><strong>Retries</strong> are extra attempts on the same key after a 5xx, timeout, or network error; 0 disables them. A 400/401/402/403/429 hops to the next healthy key either way.</p>
                </div>
              </div>
            {/if}
          </div>
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
  /* A fixed height rather than a content-driven one: expanding a section changes
     only the scroll extent inside the body, so the dialog no longer resizes and
     jump the footer around under the cursor. The viewport clamp keeps it usable
     on short screens. */
  :global(.modal-backdrop .endpoint-modal) { display: flex; width: 100%; max-width: 1200px; height: 760px; max-height: calc(100vh - 48px); flex-direction: column; padding: 0; overflow: hidden; border: 1px solid var(--border-color); border-radius: 11px; background: var(--card-bg); box-shadow: 0 24px 70px rgba(25, 15, 35, .24); }
  :global(.endpoint-modal .modal-header) { flex-shrink: 0; margin: 0; padding: 20px 24px; border-bottom: 1px solid var(--border-color); }
  :global(.endpoint-modal .modal-header h2) { color: var(--text-primary); font: 500 18px/1.2 Georgia, "Times New Roman", serif; }
  :global(.endpoint-modal .modal-close) { display: flex; width: 32px; height: 32px; align-items: center; justify-content: center; padding: 0; border-radius: 8px; background: var(--bg-tertiary); color: var(--text-secondary); font-size: 14px; transition: background .2s ease, color .2s ease; }
  :global(.endpoint-modal .modal-close:hover) { background: var(--gray-200); color: var(--text-primary); }
  .modal-body { min-height: 0; flex: 1; padding: 24px; overflow-y: auto; }
  .modal-body-grid { display: grid; grid-template-columns: 1fr 1fr; align-items: start; gap: 24px; }
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
  /* Advanced Settings: one collapsible panel per section, and only one open at a
     time. The header stays a button so keyboard and screen-reader users get the
     expanded state, and the body is removed from the DOM when collapsed rather
     than hidden, so a collapsed textarea is not a tab stop. */
  .advanced-heading { margin-bottom: 12px; color: var(--text-primary); font: 500 15px/1.2 Georgia, "Times New Roman", serif; }
  .disclosure { margin-bottom: 10px; border: 1px solid var(--border-color); border-radius: 10px; background: var(--bg-secondary); overflow: hidden; transition: border-color .2s ease, background .2s ease; }
  .disclosure:last-child { margin-bottom: 0; }
  .disclosure.open { border-color: var(--primary); background: var(--card-bg); }
  .disclosure-head { display: flex; width: 100%; align-items: center; gap: 10px; padding: 12px 14px; border: 0; background: none; color: var(--text-primary); font: 500 13.5px/1.2 Inter, ui-sans-serif, system-ui, sans-serif; text-align: left; cursor: pointer; transition: background .2s ease; }
  .disclosure-head:hover { background: var(--bg-tertiary); }
  .disclosure-head:focus-visible { outline: 3px solid var(--focus); outline-offset: -3px; }
  .disclosure-chevron { flex-shrink: 0; width: 10px; color: var(--text-secondary); font-size: 10px; transition: transform .25s cubic-bezier(.4, 0, .2, 1), color .2s ease; }
  .disclosure-chevron.open { transform: rotate(90deg); color: var(--primary); }
  .disclosure-title { min-width: 0; flex: 1; }
  /* The summary is redundant while the panel is open, so it fades out of the way
     instead of repeating the fields directly under it. */
  .disclosure-summary { flex-shrink: 0; max-width: 45%; overflow: hidden; color: var(--text-secondary); font-family: monospace; font-size: 11px; font-weight: 400; text-overflow: ellipsis; white-space: nowrap; transition: opacity .2s ease; }
  .disclosure-summary.hidden { opacity: 0; }
  .disclosure-body { padding: 4px 14px 14px; border-top: 1px solid var(--border-color); }
  /* The last control in a panel drops the row spacing the stacked layout adds,
     so the panel's own padding sets the bottom gap. */
  .disclosure-body .last-row { margin-bottom: 0; }
  .disclosure-body .key-settings-row { margin-bottom: 0; }
  .disclosure-body .gen-hint { margin-top: 10px; }
  .disclosure-body code { padding: 1px 4px; border-radius: 4px; background: var(--gray-100); font-family: monospace; font-size: 11.5px; }
  .bulk-disclosure { margin-top: 10px; }
  .header-preset-row { align-items: flex-start; margin-bottom: 10px; }
  .header-preset-text { display: flex; min-width: 0; flex-direction: column; gap: 1px; }
  .header-preset-name { font-family: monospace; font-size: 12.5px; overflow-wrap: anywhere; }
  .header-preset-value { color: var(--text-secondary); font: 400 11px monospace; overflow-wrap: anywhere; }
  .header-preset-custom { align-items: center; gap: 10px; }
  /* anthropic-beta and anthropic-version share one row: both are fixed-value
     toggles with no input to place, so pairing them buys back a row of height in
     the panel. They wrap to one per line when the column gets narrow. */
  .header-preset-pair { flex-wrap: wrap; gap: 10px 16px; }
  .header-preset-pair .gen-toggle { flex: 1 1 180px; }
  /* The toggle keeps its natural width so the slider lines up with the rows
     above it, and the value input takes whatever is left of the row. */
  .header-preset-custom .gen-toggle { flex: 0 0 auto; }
  .header-value-input { min-width: 0; flex: 1 1 0; width: auto; box-sizing: border-box; padding: 9px 12px; border: 1px solid var(--input-border); border-radius: 8px; background: var(--input-bg); color: var(--text-primary); font: 12.5px/normal monospace; opacity: .5; pointer-events: none; transition: border-color .2s ease, box-shadow .2s ease, opacity .2s ease; }
  .header-value-input.active { opacity: 1; pointer-events: auto; }
  .header-value-input:focus { outline: none; border-color: var(--primary); background-color: var(--card-bg); box-shadow: 0 0 0 3px var(--primary-alpha-01); }
  .headers-list-label { display: block; margin: 14px 0 8px; color: var(--text-secondary); font-size: 11px; font-weight: 700; letter-spacing: .03em; }
  /* First label in a panel: the panel's own top padding already provides the gap
     the 14px would otherwise double. */
  .headers-list-label.first-label { margin-top: 6px; }
  .headers-input { width: 100%; max-width: 100%; box-sizing: border-box; resize: vertical; font-family: monospace; font-size: 13px; }
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
  .bulk-input { width: 100%; box-sizing: border-box; resize: vertical; overflow-x: auto; font-family: monospace; font-size: 13px; white-space: pre; overflow-wrap: normal; }
  .bulk-actions { display: flex; align-items: center; justify-content: space-between; gap: 8px; margin-top: 6px; }
  .bulk-actions .btn { white-space: nowrap; }
  .gen-hint { margin-bottom: 12px; }
  .gen-setting-row { display: flex; align-items: center; gap: 12px; margin-bottom: 12px; }
  .gen-toggle { position: relative; display: inline-flex; align-items: center; flex: 1; gap: 10px; color: var(--gray-700); font-size: 14px; font-weight: 500; cursor: pointer; user-select: none; }
  /* Hidden but still focusable, so every toggle here stays reachable by keyboard.
     The checkbox itself is invisible, so the ring is drawn on the slider. */
  .gen-toggle input { position: absolute; width: 1px; height: 1px; margin: 0; opacity: 0; }
  .gen-toggle input:focus-visible + .gen-toggle-slider { outline: 3px solid var(--focus); outline-offset: 2px; }
  .gen-toggle-slider { position: relative; width: 40px; height: 22px; flex-shrink: 0; border-radius: 22px; background: var(--gray-300); transition: background .2s ease; }
  .gen-toggle-slider::after { content: ""; position: absolute; top: 2px; left: 2px; width: 18px; height: 18px; border-radius: 50%; background: white; transition: transform .2s ease; }
  .gen-toggle input:checked + .gen-toggle-slider { background: var(--primary-dark); }
  .gen-toggle input:checked + .gen-toggle-slider::after { transform: translateX(18px); }
  .gen-toggle.disabled { opacity: .5; cursor: not-allowed; }
  .cache-ttl-row { margin-top: -4px; }
  .gen-input { width: 120px; flex-shrink: 0; opacity: .5; pointer-events: none; }
  .gen-input.active { opacity: 1; pointer-events: auto; }
  /* Rotation, health, and retries share one row, so the toggles drop the
     stretch that Generation Settings relies on and wrap instead of overflowing
     when the column gets narrow. */
  .key-settings-row { flex-wrap: wrap; gap: 10px 18px; margin-bottom: 0; }
  .key-toggle { flex: 0 0 auto; }
  .key-retry-field { display: inline-flex; align-items: center; gap: 8px; margin-left: auto; color: var(--gray-700); font-size: 14px; font-weight: 500; cursor: pointer; user-select: none; }
  .key-retry-input { width: 72px; }
  /* One hint per control, so each line names the toggle it explains. */
  .key-hints { display: grid; gap: 5px; margin-top: 12px; }
  .key-hints .form-hint { margin: 0; }
  .key-hints strong { color: var(--text-primary); font-weight: 600; }
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
  @media (prefers-reduced-motion: reduce) { .disclosure, .disclosure-head, .disclosure-chevron, .disclosure-summary { transition: none; } }
  @media (max-width: 768px) {
    :global(.endpoint-modal-backdrop) { padding: 2.5vw; }
    /* Stacked to one column the content is much taller than it is wide, so the
       dialog takes the screen and scrolls rather than keeping the desktop height. */
    :global(.modal-backdrop .endpoint-modal) { max-width: 95vw; height: 95vh; max-height: 95vh; }
    .modal-body-grid { grid-template-columns: 1fr; }
  }
  @media (max-width: 720px) { .model-item, .key-state-item { align-items: flex-start; flex-direction: column; gap: 12px; } .model-actions, .key-state-actions { align-self: flex-end; flex-wrap: wrap; } }
</style>
