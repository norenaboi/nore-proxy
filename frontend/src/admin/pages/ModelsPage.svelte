<script lang="ts">
  import { onMount } from "svelte";
  import { requestAdminJson, naturalSort } from "$frontend/lib/api/admin";
  import { pageHeaderActions, toast } from "$frontend/lib/stores";

  interface Pricing { input?: number; output?: number; cache_write?: number; cache_read?: number; }
  type NumericInputValue = string | number | undefined;
  interface PricingForm {
    input: NumericInputValue;
    output: NumericInputValue;
    cache_write: NumericInputValue;
    cache_read: NumericInputValue;
  }
  interface Model {
    name: string; modelType?: "auto" | "concrete"; version?: string; backend?: string;
    pricing?: Pricing; disabled?: boolean; hidden?: boolean;
    targets?: string[]; targetSelection?: "sticky" | "roundrobin"; maxTargetAttempts?: number | null;
  }
  interface Endpoint { index: number; name?: string; }
  interface TestResult { ok: boolean; latency_ms?: number; error?: string; }

  let models = $state<Model[]>([]);
  let endpoints = $state<Record<string, Endpoint>>({});
  let loading = $state(true);
  let errorMsg = $state("");
  const testResults = new Map<string, TestResult>();
  let testVersion = $state(0); // bump to re-render after test map mutation

  // Modal state
  let modalOpen = $state(false);
  let editingModel = $state<string | null>(null);
  let deletingModel = $state<string | null>(null);

  // Form
  let fName = $state("");
  let fType = $state<"concrete" | "auto">("concrete");
  let fHidden = $state(false);
  let fVersion = $state("");
  let fBackend = $state("");
  let fPricing = $state<PricingForm>({ input: "", output: "", cache_write: "", cache_read: "" });
  let fTargets = $state<string[]>([]);
  let fTargetSelection = $state<"sticky" | "roundrobin">("sticky");
  let fMaxAttempts = $state("");
  let fTargetCandidate = $state("");

  // Upstream model fetching
  let availableModels = $state<string[]>([]);
  let upstreamFetched = $state(false);
  let fetchingModels = $state(false);

  const isAuto = (m: Model) => m.modelType === "auto";

  async function load() {
    try {
      const [modelsData, endpointData] = await Promise.all([
        requestAdminJson<{ models: Model[] }>("/api/models"),
        requestAdminJson<{ endpoints?: Endpoint[] }>("/api/endpoints"),
      ]);
      models = Array.isArray(modelsData.models) ? modelsData.models : [];
      endpoints = {};
      for (const endpoint of endpointData.endpoints ?? []) {
        endpoints[`v${endpoint.index}`] = { ...endpoint };
      }
    } catch (e) {
      errorMsg = e instanceof Error ? e.message : "Failed to load models";
    } finally {
      loading = false;
    }
  }

  const grouped = $derived.by(() => {
    const groups = new Map<string, Model[]>();
    for (const m of models) {
      const key = isAuto(m) ? "__auto__" : (m.version || "__none__");
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key)!.push(m);
    }
    for (const arr of groups.values()) arr.sort((a, b) => naturalSort(a.name, b.name));
    const keys = [...groups.keys()].sort((a, b) => {
      if (a === "__auto__") return -1;
      if (b === "__auto__") return 1;
      if (a === "__none__") return 1;
      if (b === "__none__") return -1;
      return (parseInt(a.replace(/\D/g, ""), 10) || 0) - (parseInt(b.replace(/\D/g, ""), 10) || 0);
    });
    return keys.map((key) => ({ key, label: key === "__auto__" ? "Automatic Routing" : (endpoints[key]?.name || "Unknown Endpoint"), auto: key === "__auto__", items: groups.get(key)! }));
  });

  const concreteCandidates = $derived(
    models.filter((m) => !isAuto(m) && !m.disabled && m.name !== editingModel)
      .map((m) => m.name).sort(naturalSort),
  );
  const availableTargets = $derived(concreteCandidates.filter((n) => !fTargets.includes(n)));
  const versionKeys = $derived(Object.keys(endpoints).sort((a, b) => (parseInt(a.slice(1), 10) || 0) - (parseInt(b.slice(1), 10) || 0)));

  function priceChip(v: number | undefined) {
    return v != null && Number.isFinite(Number(v)) ? Number(v).toFixed(2) : "0.00";
  }

  function resetForm() {
    editingModel = null; fName = ""; fType = "concrete"; fHidden = false;
    fVersion = ""; fBackend = ""; fPricing = { input: "", output: "", cache_write: "", cache_read: "" };
    fTargets = []; fTargetSelection = "sticky"; fMaxAttempts = ""; fTargetCandidate = "";
    availableModels = []; upstreamFetched = false;
  }

  function openAdd() { resetForm(); modalOpen = true; }

  function openEdit(name: string) {
    const m = models.find((e) => e.name === name);
    if (!m) return toast.show("Model not found", "error");
    resetForm();
    editingModel = name;
    fName = m.name;
    fType = isAuto(m) ? "auto" : "concrete";
    fHidden = m.hidden === true;
    if (isAuto(m)) {
      fTargets = [...new Set(Array.isArray(m.targets) ? m.targets : [])];
      fTargetSelection = m.targetSelection === "roundrobin" ? "roundrobin" : "sticky";
      fMaxAttempts = m.maxTargetAttempts != null ? String(m.maxTargetAttempts) : "";
    } else {
      fBackend = m.backend || "";
      fVersion = m.version || "";
    }
    fPricing = {
      input: m.pricing?.input != null ? String(m.pricing.input) : "",
      output: m.pricing?.output != null ? String(m.pricing.output) : "",
      cache_write: m.pricing?.cache_write != null ? String(m.pricing.cache_write) : "",
      cache_read: m.pricing?.cache_read != null ? String(m.pricing.cache_read) : "",
    };
    modalOpen = true;
  }

  function closeModal() { modalOpen = false; resetForm(); }

  function addTarget() {
    if (!fTargetCandidate || fTargets.includes(fTargetCandidate)) return;
    fTargets = [...fTargets, fTargetCandidate];
    fTargetCandidate = "";
  }
  function moveTarget(i: number, delta: number) {
    const j = i + delta;
    if (j < 0 || j >= fTargets.length) return;
    const next = [...fTargets];
    [next[i], next[j]] = [next[j], next[i]];
    fTargets = next;
  }
  function removeTarget(i: number) { fTargets = fTargets.filter((_, idx) => idx !== i); }

  async function fetchUpstream() {
    if (!fVersion) return toast.show("Please select an endpoint first", "error");
    fetchingModels = true;
    try {
      const res = await fetch(`/api/endpoints/${encodeURIComponent(fVersion)}/models`);
      if (!res.ok) {
        const d = await res.json().catch(() => ({})) as { error?: string };
        throw new Error(d.error || "Failed to fetch models from the endpoint");
      }
      const d = await res.json() as { models?: string[] };
      availableModels = (d.models ?? []).filter((n): n is string => typeof n === "string" && !!n).sort(naturalSort);
      upstreamFetched = true;
      toast.show(`Fetched ${availableModels.length} model${availableModels.length === 1 ? "" : "s"}`);
    } catch (e) {
      availableModels = []; upstreamFetched = false;
      toast.show(e instanceof Error ? e.message : "Failed to fetch", "error");
    } finally {
      fetchingModels = false;
    }
  }

  function numericInputValue(value: NumericInputValue) {
    if (value === undefined || value === "") return null;
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }

  function pricingPayload() {
    const num = (value: NumericInputValue) => numericInputValue(value) ?? 0;
    return { input: num(fPricing.input), output: num(fPricing.output), cache_write: num(fPricing.cache_write), cache_read: num(fPricing.cache_read) };
  }

  function depMessage(data: { error?: string; dependents?: string[]; blockers?: string[] }, fallback: string) {
    const deps = data.dependents || data.blockers;
    if (!Array.isArray(deps) || !deps.length) return data.error || fallback;
    return `${data.error || fallback}: ${deps.join(", ")}`;
  }

  async function submit() {
    const name = fName.trim();
    if (!name) return toast.show("Please enter a display name", "error");
    const payload: Record<string, unknown> = { name, modelType: fType, hidden: fHidden, pricing: pricingPayload() };

    if (fType === "auto") {
      const unique = [...new Set(fTargets)];
      if (unique.length < 2 || unique.length !== fTargets.length) return toast.show("Select at least two unique concrete targets", "error");
      const maxAttempts = numericInputValue(fMaxAttempts);
      if (maxAttempts !== null && (!Number.isInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > 20)) return toast.show("Maximum target attempts must be an integer from 1 to 20", "error");
      if (maxAttempts !== null && maxAttempts > unique.length) return toast.show("Maximum target attempts cannot exceed the number of targets", "error");
      payload.targets = unique;
      payload.targetSelection = fTargetSelection;
      payload.maxTargetAttempts = maxAttempts;
    } else {
      const backend = fBackend.trim();
      if (!backend) return toast.show("Please enter a backend name", "error");
      if (!fVersion) return toast.show("Please select an endpoint version", "error");
      payload.backend = backend;
      payload.version = fVersion;
    }

    try {
      const res = await fetch("/api/models", {
        method: editingModel ? "PUT" : "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(editingModel ? { oldName: editingModel, ...payload } : payload),
      });
      if (res.status === 401 || res.status === 403) { window.location.href = "/admin/login"; return; }
      const data = await res.json().catch(() => ({})) as { error?: string; dependents?: string[]; blockers?: string[] };
      if (!res.ok) throw new Error(res.status === 409 ? depMessage(data, "Model has active dependencies") : (data.error || `Failed to ${editingModel ? "update" : "add"} model`));
      toast.show(`Model ${editingModel ? "updated" : "added"} successfully`);
      closeModal();
      await load();
    } catch (e) {
      toast.show(e instanceof Error ? e.message : "Failed", "error");
    }
  }

  async function toggleDisabled(name: string) {
    try {
      const res = await fetch("/api/models/toggle", { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name }) });
      if (res.status === 401 || res.status === 403) { window.location.href = "/admin/login"; return; }
      const data = await res.json().catch(() => ({})) as { error?: string; message?: string; dependents?: string[]; blockers?: string[] };
      if (!res.ok) throw new Error(res.status === 409 ? depMessage(data, "Model has active dependencies") : (data.error || "Failed to toggle model"));
      toast.show(data.message || "Model updated");
      await load();
    } catch (e) {
      toast.show(e instanceof Error ? e.message : "Failed", "error");
    }
  }

  async function toggleVisibility(name: string) {
    try {
      const res = await fetch("/api/models/visibility", { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name }) });
      if (res.status === 401 || res.status === 403) { window.location.href = "/admin/login"; return; }
      const data = await res.json().catch(() => ({})) as { error?: string; message?: string };
      if (!res.ok) throw new Error(data.error || "Failed to update model visibility");
      toast.show(data.message || "Model visibility updated");
      await load();
    } catch (e) {
      toast.show(e instanceof Error ? e.message : "Failed", "error");
    }
  }

  async function testModel(name: string) {
    try {
      const res = await fetch("/api/models/test", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name }) });
      const data = await res.json() as TestResult;
      testResults.set(name, data);
      testVersion++;
      toast.show(data.ok ? `${name}: OK (${data.latency_ms}ms)` : `${name}: ${data.error}`, data.ok ? "success" : "error");
    } catch (e) {
      testResults.set(name, { ok: false, error: e instanceof Error ? e.message : "error" });
      testVersion++;
      toast.show(e instanceof Error ? e.message : "Failed", "error");
    }
  }

  async function confirmDelete() {
    if (!deletingModel) return;
    try {
      const res = await fetch("/api/models", { method: "DELETE", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name: deletingModel }) });
      if (res.status === 401 || res.status === 403) { window.location.href = "/admin/login"; return; }
      const data = await res.json().catch(() => ({})) as { error?: string; dependents?: string[]; blockers?: string[] };
      if (!res.ok) throw new Error(res.status === 409 ? depMessage(data, "Model has active dependencies") : (data.error || "Failed to delete model"));
      toast.show("Model deleted successfully");
      deletingModel = null;
      await load();
    } catch (e) {
      toast.show(e instanceof Error ? e.message : "Failed", "error");
    }
  }

  $effect(() => {
    pageHeaderActions.set({ count: models.length, noun: "model", icon: "fa-solid fa-cube", addLabel: "Add Model", onAdd: openAdd });
  });

  onMount(() => {
    void load();
    return () => pageHeaderActions.set(null);
  });
</script>

{#if loading}
  <div class="loading"><div class="loading-spinner"></div><span>Loading models…</span></div>
{:else if errorMsg}
  <div class="page-error" role="alert">{errorMsg}</div>
{:else if models.length === 0}
  <div class="empty-state"><i class="fa-solid fa-cube"></i><p>No models configured. Add one to get started!</p></div>
{:else}
  {#key testVersion}
  <div class="card models-card">
    <div class="card-header"><span class="card-title">Allowed Models</span></div>
    <div class="card-body models-list">
      {#each grouped as group (group.key)}
        <section class="endpoint-group" class:auto-model-group={group.auto}>
          <div class="endpoint-group-header">
            <div class="endpoint-icon"><i class="fa-solid {group.auto ? 'fa-shuffle' : 'fa-hexagon-nodes'}"></i></div>
            <span class="endpoint-name">{group.label}</span>
            <span class="endpoint-count">{group.items.length} model{group.items.length === 1 ? "" : "s"}</span>
          </div>
          <div class="endpoint-group-divider"></div>
          <div class="endpoint-group-models">
            {#each group.items as model (model.name)}
              {@const result = testResults.get(model.name)}
              <div class="model-item" class:disabled-model={model.disabled} class:auto-model-item={group.auto}>
                <div class="model-info">
                  <div class="model-icon"><i class="fa-solid {group.auto ? 'fa-shuffle' : 'fa-microchip'}"></i></div>
                  <div class="model-meta">
                    <div class="model-meta-row">
                      <span class="model-name">{model.name}</span>
                      {#if model.disabled}<span class="model-badge model-badge-disabled">disabled</span>{/if}
                      {#if model.hidden}<span class="model-badge model-badge-hidden">hidden</span>{/if}
                      {#if group.auto}
                        <span class="model-badge model-badge-auto">auto</span>
                        <span class="model-badge model-badge-selection">{model.targetSelection === "roundrobin" ? "round-robin" : "sticky"}</span>
                        <span class="model-badge model-badge-targets">{(model.targets || []).length} targets</span>
                        {#if model.maxTargetAttempts != null}<span class="model-badge model-badge-attempts">max {model.maxTargetAttempts}</span>{/if}
                      {:else if model.backend && model.backend !== model.name}
                        <span class="model-badge model-badge-backend">{model.backend}</span>
                      {/if}
                    </div>
                    <div class="model-pricing">
                      {#each [["in", model.pricing?.input], ["out", model.pricing?.output], ["cw", model.pricing?.cache_write], ["cr", model.pricing?.cache_read]] as [label, val]}
                        <span class="pricing-chip"><span class="chip-label">{label}</span><span class="chip-val">${priceChip(val as number | undefined)}</span></span>
                      {/each}
                    </div>
                  </div>
                </div>
                <div class="model-actions">
                  {#if !group.auto}
                    {#if result}<span class="test-result-badge {result.ok ? 'ok' : 'fail'}"><i class="fa-solid {result.ok ? 'fa-check' : 'fa-xmark'}"></i>{result.ok ? `${result.latency_ms}ms` : "fail"}</span>{/if}
                    <button class="btn btn-test btn-sm" type="button" title="Test model (silent — not logged)" onclick={() => testModel(model.name)}><i class="fa-solid fa-flask"></i></button>
                  {/if}
                  <button class="btn btn-sm {model.disabled ? 'btn-warning' : 'btn-success'}" type="button" title={model.disabled ? "Enable model" : "Disable model"} onclick={() => toggleDisabled(model.name)}><i class="fa-solid fa-{model.disabled ? 'pause' : 'play'}"></i></button>
                  <button class="btn btn-sm {model.hidden ? 'btn-warning' : 'btn-secondary'}" type="button" title={model.hidden ? "Show in public model discovery" : "Hide from public model discovery"} onclick={() => toggleVisibility(model.name)}><i class="fa-solid fa-eye{model.hidden ? '' : '-slash'}"></i></button>
                  <button class="btn btn-secondary btn-sm" type="button" onclick={() => openEdit(model.name)}><i class="fa-solid fa-pen"></i> Edit</button>
                  <button class="btn btn-danger btn-sm" type="button" aria-label={`Delete ${model.name}`} onclick={() => deletingModel = model.name}><i class="fa-solid fa-trash"></i></button>
                </div>
              </div>
            {/each}
          </div>
        </section>
      {/each}
    </div>
  </div>
  {/key}
{/if}

<!-- Add/Edit modal -->
{#if modalOpen}
  <div class="modal-backdrop active" onclick={(e) => { if (e.target === e.currentTarget) closeModal(); }} role="presentation">
    <div class="modal" role="dialog" aria-modal="true">
      <div class="modal-header"><h2>{editingModel ? "Edit Model" : "Add Model"}</h2><button class="modal-close" type="button" onclick={closeModal}>✕</button></div>

      <div class="form-group">
        <label for="mName">Display Name</label>
        <input id="mName" type="text" bind:value={fName} placeholder="gpt-5" />
      </div>

      <div class="form-group">
        <label for="mType">Model Type</label>
        <select id="mType" bind:value={fType} class="form-select" style="width:100%;">
          <option value="concrete">Concrete (single backend)</option>
          <option value="auto">Automatic (routes across targets)</option>
        </select>
      </div>

      {#if fType === "concrete"}
        <div class="form-group">
          <label for="mVersion">Endpoint</label>
          <select id="mVersion" bind:value={fVersion} onchange={() => { availableModels = []; upstreamFetched = false; }} class="form-select" style="width:100%;">
            <option value="">Select an endpoint</option>
            {#each versionKeys as v}<option value={v}>{endpoints[v]?.name || v}</option>{/each}
          </select>
        </div>
        <div class="form-group">
          <label for="mBackend">Backend Model</label>
          <div style="display:flex;gap:8px;">
            <input id="mBackend" type="text" bind:value={fBackend} placeholder="Backend model name" style="flex:1;" />
            <button class="btn btn-secondary btn-sm" type="button" onclick={fetchUpstream} disabled={fetchingModels || !fVersion}>
              {fetchingModels ? "Fetching…" : "Fetch"}
            </button>
          </div>
          {#if upstreamFetched && availableModels.length}
            <select onchange={(e) => { const v = (e.currentTarget as HTMLSelectElement).value; if (v) fBackend = v; }} class="form-select" style="width:100%;margin-top:8px;">
              <option value="">Select a fetched model</option>
              {#each availableModels as m}<option value={m}>{m}</option>{/each}
            </select>
          {/if}
        </div>
      {:else}
        <div class="form-group auto-controls">
          <div class="form-section-label">Targets (ordered)</div>
          <div class="backend-select-row target-picker">
            <select bind:value={fTargetCandidate} class="form-select" style="flex:1;" disabled={availableTargets.length === 0}>
              {#if availableTargets.length === 0}
                <option value="">No enabled concrete models available</option>
              {:else}
                <option value="">Select a concrete model</option>
                {#each availableTargets as t}<option value={t}>{t}</option>{/each}
              {/if}
            </select>
            <button class="btn btn-secondary btn-sm" type="button" onclick={addTarget} disabled={!fTargetCandidate}>Add</button>
          </div>
          <p class="form-help">Choose at least two unique, enabled concrete models. Order controls failover priority.</p>
          <div class="selected-targets">
            {#if fTargets.length === 0}
              <p class="targets-empty">No targets selected.</p>
            {:else}
              {#each fTargets as t, i (t)}
                <div class="selected-target-row">
                  <span class="target-order">{i + 1}</span>
                  <span class="target-name">{t}</span>
                  <div class="target-actions">
                    <button class="target-action" type="button" onclick={() => moveTarget(i, -1)} disabled={i === 0} aria-label="Move up"><i class="fa-solid fa-chevron-up"></i></button>
                    <button class="target-action" type="button" onclick={() => moveTarget(i, 1)} disabled={i === fTargets.length - 1} aria-label="Move down"><i class="fa-solid fa-chevron-down"></i></button>
                    <button class="target-action remove" type="button" onclick={() => removeTarget(i)} aria-label="Remove"><i class="fa-solid fa-xmark"></i></button>
                  </div>
                </div>
              {/each}
            {/if}
          </div>
        </div>
        <div style="display:flex;gap:12px;">
          <div class="form-group" style="flex:1;">
            <label for="mSel">Target Selection</label>
            <select id="mSel" bind:value={fTargetSelection} class="form-select" style="width:100%;">
              <option value="sticky">Sticky</option>
              <option value="roundrobin">Round-robin</option>
            </select>
          </div>
          <div class="form-group" style="flex:1;">
            <label for="mMax">Max Target Attempts</label>
            <input id="mMax" type="number" bind:value={fMaxAttempts} min="1" max="20" step="1" placeholder="global default" />
          </div>
        </div>
        <p style="font-size:12px;color:var(--text-secondary);margin-top:-8px;">Leave blank to use the global failover limit.{fTargets.length ? ` This model currently has ${fTargets.length} target${fTargets.length === 1 ? "" : "s"}.` : ""}</p>
      {/if}

      <div class="form-group">
        <div class="form-section-label">Pricing (per 1M tokens)</div>
        <div style="display:grid;grid-template-columns:repeat(2,1fr);gap:8px;">
          {#each [["Input", "input"], ["Output", "output"], ["Cache Write", "cache_write"], ["Cache Read", "cache_read"]] as [label, key]}
            <div>
              <span style="font-size:11px;color:var(--text-secondary);">{label}</span>
              <input type="number" step="0.01" min="0" bind:value={fPricing[key as keyof PricingForm]} placeholder="0.00" style="width:100%;" />
            </div>
          {/each}
        </div>
      </div>

      <div class="form-group">
        <label class="toggle" style="display:inline-flex;align-items:center;gap:8px;">
          <input type="checkbox" bind:checked={fHidden} />
          <div class="toggle-track"></div><div class="toggle-thumb"></div>
          <span style="text-transform:none;letter-spacing:0;font-weight:400;color:var(--text-primary);">Hidden from public model discovery</span>
        </label>
      </div>

      <div class="modal-footer">
        <button class="btn btn-secondary" type="button" onclick={closeModal}>Cancel</button>
        <button class="btn btn-primary" type="button" onclick={submit}>{editingModel ? "Save Changes" : "Add Model"}</button>
      </div>
    </div>
  </div>
{/if}

<!-- Delete modal -->
{#if deletingModel}
  <div class="modal-backdrop active" onclick={(e) => { if (e.target === e.currentTarget) deletingModel = null; }} role="presentation">
    <div class="modal" role="dialog" aria-modal="true">
      <div class="modal-header"><h2>Delete Model</h2><button class="modal-close" type="button" onclick={() => deletingModel = null}>✕</button></div>
      <p>Are you sure you want to delete <strong>{deletingModel}</strong>? This cannot be undone.</p>
      <div class="modal-footer">
        <button class="btn btn-secondary" type="button" onclick={() => deletingModel = null}>Cancel</button>
        <button class="btn btn-danger" type="button" onclick={confirmDelete}>Delete</button>
      </div>
    </div>
  </div>
{/if}

<style>
  .models-card { overflow: hidden; }
  .card-header { display: flex; align-items: center; justify-content: space-between; padding: 20px 24px; border-bottom: 1px solid var(--border-color); }
  .card-title { color: var(--text-primary); font-family: Georgia, "Times New Roman", serif; font-size: 16px; font-weight: 500; }
  .card-body { padding: 24px; }
  .models-list { display: flex; flex-direction: column; gap: 10px; }
  .endpoint-group { margin-bottom: 8px; }
  .endpoint-group + .endpoint-group { margin-top: 18px; }
  .endpoint-group-header { display: flex; align-items: center; gap: 10px; padding: 10px 4px 8px; margin-bottom: 2px; }
  .endpoint-icon { display: flex; width: 30px; height: 30px; align-items: center; justify-content: center; flex-shrink: 0; border-radius: 8px; background: var(--gradient-primary); color: white; font-size: 13px; }
  .endpoint-name { color: var(--text-primary); font-size: 15px; font-weight: 600; }
  .endpoint-count { margin-left: auto; color: var(--text-secondary); font-size: 12px; }
  .endpoint-group-divider { height: 1px; margin-bottom: 10px; background: var(--border-color); }
  .endpoint-group-models { display: flex; flex-direction: column; gap: 8px; margin-left: 15px; padding-left: 8px; border-left: 2px solid var(--primary-alpha-015); }
  .model-item { display: flex; align-items: center; justify-content: space-between; padding: 16px 20px; border: 1px solid var(--border-color); border-radius: 8px; background: var(--bg-secondary); transition: border-color .2s ease; }
  .model-item:hover { border-color: var(--primary); }
  .model-item.disabled-model { opacity: .5; }
  .model-item.disabled-model .model-icon { background: var(--gray-300); }
  .model-info { display: flex; align-items: center; min-width: 0; flex: 1; gap: 12px; }
  .model-icon { display: flex; width: 40px; height: 40px; align-items: center; justify-content: center; flex-shrink: 0; border-radius: 10px; background: var(--gradient-primary); color: white; }
  .model-meta { display: flex; min-width: 0; flex: 1; flex-direction: row; gap: 6px; }
  .model-meta-row { display: flex; align-items: center; flex-wrap: wrap; gap: 8px; }
  .model-name { color: var(--text-primary); font-weight: 500; }
  .model-badge { display: inline-flex; align-items: center; gap: 4px; padding: 2px 8px; border-radius: 6px; font-family: "Courier New", monospace; font-size: 11px; font-weight: 500; }
  .model-badge-backend { background: var(--gray-100); color: var(--gray-600); }
  .model-badge-disabled { background: var(--warning); color: white; opacity: .8; }
  .model-badge-hidden { background: var(--gray-200); color: var(--gray-700); }
  .model-badge-auto { background: var(--primary); color: white; }
  .model-badge-selection { background: var(--primary-alpha-015); color: var(--primary-dark); }
  .model-badge-targets { background: var(--success-alpha-01); color: var(--success-dark); }
  .model-badge-attempts { background: rgba(245,158,11,.12); color: #b45309; }
  .model-pricing { display: flex; flex-wrap: wrap; gap: 10px; margin-right: 10px; margin-left: auto; }
  .pricing-chip { display: inline-flex; align-items: baseline; gap: 3px; padding: 2px 8px; border-radius: 20px; background: var(--gray-100); color: var(--gray-600); font-size: 11px; }
  .chip-label { color: var(--gray-500); font-size: 10px; font-weight: 600; letter-spacing: .03em; text-transform: uppercase; }
  .chip-val { color: var(--gray-800); font-family: "Courier New", monospace; font-weight: 500; }
  .model-actions { display: flex; gap: 8px; }
  .btn-test { border: 1px solid var(--primary-alpha-035); background: var(--primary-alpha-012); color: var(--primary); }
  .test-result-badge { display: inline-flex; align-items: center; gap: 4px; padding: 2px 7px; border-radius: 10px; font-size: 11px; font-weight: 600; white-space: nowrap; }
  .test-result-badge.ok { border: 1px solid var(--success-alpha-04); background: var(--success-alpha-01); color: var(--success-dark); }
  .test-result-badge.fail { border: 1px solid var(--danger-alpha-02); background: var(--danger-alpha-01); color: var(--danger-dark); }
  .auto-model-group .endpoint-icon, .auto-model-item .model-icon { background: linear-gradient(135deg, var(--primary) 0%, var(--warning) 140%); }
  .auto-model-item { border-color: var(--primary-alpha-035); background: var(--primary-alpha-01); }
  .form-section-label { display: flex; align-items: center; gap: 6px; margin: 4px 0 8px; padding-top: 12px; border-top: 1px solid var(--border-color); color: var(--text-secondary); font-size: 11px; font-weight: 600; letter-spacing: .08em; text-transform: uppercase; }
  .form-help { margin: 7px 0 0; color: var(--text-secondary); font-size: 12px; line-height: 1.5; }
  .backend-select-row { display: flex; align-items: stretch; gap: 8px; }
  .target-picker { margin-bottom: 0; }
  .auto-controls { padding: 18px; border: 1px solid var(--primary-alpha-035); border-radius: 12px; background: var(--primary-alpha-01); }
  .selected-targets { display: flex; min-height: 48px; flex-direction: column; gap: 7px; margin-top: 10px; padding: 8px; border: 1px solid var(--border-color); border-radius: 10px; background: var(--card-bg); }
  .targets-empty { margin: auto; padding: 6px; color: var(--text-secondary); font-size: 12px; text-align: center; }
  .selected-target-row { display: flex; align-items: center; gap: 10px; padding: 8px 9px; border: 1px solid var(--border-color); border-radius: 9px; background: var(--bg-secondary); }
  .target-order { display: inline-flex; width: 24px; height: 24px; align-items: center; justify-content: center; flex-shrink: 0; border-radius: 7px; background: var(--primary-alpha-015); color: var(--primary-dark); font-size: 11px; font-weight: 700; }
  .target-name { min-width: 0; flex: 1; overflow: hidden; color: var(--gray-700); font-family: "Courier New", monospace; font-size: 12px; text-overflow: ellipsis; white-space: nowrap; }
  .target-actions { display: flex; gap: 4px; }
  .target-action { display: inline-flex; width: 28px; height: 28px; align-items: center; justify-content: center; border: 0; border-radius: 7px; background: var(--gray-200); color: var(--gray-600); cursor: pointer; }
  .target-action.remove { color: var(--danger); }
  .target-action:disabled { opacity: .35; cursor: not-allowed; }
  @media (max-width: 760px) {
    .model-item { align-items: flex-start; flex-direction: column; gap: 12px; }
    .model-meta { flex-direction: column; }
    .model-pricing { margin: 6px 0 0; }
    .model-actions { align-self: flex-end; flex-wrap: wrap; }
  }
</style>
