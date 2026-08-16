<script lang="ts">
  import { onMount, tick } from "svelte";
  import { fade, scale } from "svelte/transition";
  import { requestAdminJson, naturalSort } from "$frontend/lib/api/admin";
  import { motionDuration } from "$frontend/lib/motion";
  import { pageHeaderActions, toast } from "$frontend/lib/stores";
  import { effectiveModelName, isDuplicateModelName, numericInputValue, type NumericInputValue } from "$frontend/admin/modelForm";

  interface Pricing { input?: number; output?: number; cache_write?: number; cache_read?: number; }
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
  type GroupKind = "auto" | "endpoint" | "unknown";
  type ModelStateFilter = "all" | "enabled" | "disabled";
  type VisibilityFilter = "all" | "public" | "hidden";
  type ModelTypeFilter = "all" | "concrete" | "auto";
  type SortField = "name" | "status";

  let models = $state<Model[]>([]);
  let endpoints = $state<Record<string, Endpoint>>({});
  let loading = $state(true);
  let errorMsg = $state("");
  const testResults = new Map<string, TestResult>();
  let testVersion = $state(0); // bump to re-render after test map mutation
  let testingModels = $state<Set<string>>(new Set());
  let togglingDisabled = $state<Set<string>>(new Set());
  let togglingVisibility = $state<Set<string>>(new Set());

  // Search, filters, disclosures, and row actions
  let query = $state("");
  let filtersOpen = $state(false);
  let endpointFilter = $state("all");
  let typeFilter = $state<ModelTypeFilter>("all");
  let stateFilter = $state<ModelStateFilter>("all");
  let visibilityFilter = $state<VisibilityFilter>("all");
  let sortField = $state<SortField>("name");
  let sortDirection = $state<"asc" | "desc">("asc");
  let expandedGroups = $state<Record<string, boolean>>({});
  let openActions = $state<string | null>(null);
  const actionTriggers = new Map<string, HTMLButtonElement>();

  // Modal state
  let modalOpen = $state(false);
  let modalMode = $state<"add" | "edit" | "clone">("add");
  let editingModel = $state<string | null>(null);
  let deletingModel = $state<string | null>(null);
  let submitting = $state(false);
  let deleting = $state(false);
  let deleteDialog = $state<HTMLDivElement | null>(null);
  let deleteCancelButton = $state<HTMLButtonElement | null>(null);
  let deleteReturnFocus = $state<HTMLButtonElement | null>(null);

  // Form
  let fName = $state("");
  let fType = $state<"concrete" | "auto">("concrete");
  let fDisabled = $state(false);
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

  const activeCriteria = $derived(Boolean(query.trim()) || endpointFilter !== "all" || typeFilter !== "all" || stateFilter !== "all" || visibilityFilter !== "all");
  const activeFilterCount = $derived([endpointFilter !== "all", typeFilter !== "all", stateFilter !== "all", visibilityFilter !== "all"].filter(Boolean).length);

  function groupKey(m: Model) {
    return isAuto(m) ? "__auto__" : (m.version || "__none__");
  }

  function groupKind(key: string): GroupKind {
    if (key === "__auto__") return "auto";
    return key !== "__none__" && endpoints[key] ? "endpoint" : "unknown";
  }

  function groupLabel(key: string) {
    return key === "__auto__" ? "Automatic Routing" : (endpoints[key]?.name || "Unknown Endpoint");
  }

  function modelMatches(m: Model) {
    const key = groupKey(m);
    const needle = query.trim().toLowerCase();
    if (needle) {
      const fields = [m.name, m.backend, m.version, groupLabel(key), m.modelType, m.targetSelection, ...(m.targets || [])];
      if (!fields.some((value) => String(value || "").toLowerCase().includes(needle))) return false;
    }
    if (endpointFilter !== "all" && key !== endpointFilter) return false;
    if (typeFilter !== "all" && (isAuto(m) ? "auto" : "concrete") !== typeFilter) return false;
    if (stateFilter === "enabled" && m.disabled) return false;
    if (stateFilter === "disabled" && !m.disabled) return false;
    if (visibilityFilter === "public" && m.hidden) return false;
    if (visibilityFilter === "hidden" && !m.hidden) return false;
    return true;
  }

  function compareModels(a: Model, b: Model) {
    let comparison = 0;
    if (sortField === "status") {
      const statusRank = (m: Model) => m.disabled ? 2 : m.hidden ? 1 : 0;
      comparison = statusRank(a) - statusRank(b);
    }
    if (comparison === 0) comparison = naturalSort(a.name, b.name);
    return sortDirection === "asc" ? comparison : -comparison;
  }

  const grouped = $derived.by(() => {
    const allGroups = new Map<string, Model[]>();
    for (const m of models) {
      const key = groupKey(m);
      if (!allGroups.has(key)) allGroups.set(key, []);
      allGroups.get(key)!.push(m);
    }
    const keys = [...allGroups.keys()].sort((a, b) => {
      if (a === "__auto__") return -1;
      if (b === "__auto__") return 1;
      const aKind = groupKind(a);
      const bKind = groupKind(b);
      if (aKind === "unknown" && bKind !== "unknown") return 1;
      if (bKind === "unknown" && aKind !== "unknown") return -1;
      return (parseInt(a.replace(/\D/g, ""), 10) || 0) - (parseInt(b.replace(/\D/g, ""), 10) || 0);
    });
    return keys.map((key) => {
      const allItems = allGroups.get(key)!;
      const items = allItems.filter(modelMatches).sort(compareModels);
      return {
        key,
        kind: groupKind(key),
        label: groupLabel(key),
        auto: key === "__auto__",
        items,
        total: allItems.length,
        disabled: items.filter((m) => m.disabled).length,
        hidden: items.filter((m) => m.hidden).length,
      };
    }).filter((group) => group.items.length > 0);
  });

  const visibleCount = $derived(grouped.reduce((total, group) => total + group.items.length, 0));
  const endpointFilterOptions = $derived.by(() => {
    const keys = [...new Set(models.map(groupKey))];
    return keys.sort((a, b) => naturalSort(groupLabel(a), groupLabel(b)));
  });

  function clearCriteria() {
    query = "";
    endpointFilter = "all";
    typeFilter = "all";
    stateFilter = "all";
    visibilityFilter = "all";
  }

  function isGroupExpanded(group: { key: string; kind: GroupKind }) {
    if (activeCriteria) return true;
    return expandedGroups[group.key] ?? group.kind !== "endpoint";
  }

  function toggleGroup(group: { key: string; kind: GroupKind }) {
    if (activeCriteria) return;
    expandedGroups = { ...expandedGroups, [group.key]: !isGroupExpanded(group) };
  }

  function groupBodyId(key: string) {
    return `models-group-${key.replace(/[^a-zA-Z0-9_-]/g, "-")}`;
  }

  function actionPanelId(name: string) {
    let hash = 0;
    for (const char of name) hash = ((hash << 5) - hash + char.charCodeAt(0)) | 0;
    return `model-actions-${Math.abs(hash)}`;
  }

  function closeActions({ restoreFocus = false } = {}) {
    const name = openActions;
    openActions = null;
    if (restoreFocus && name) actionTriggers.get(name)?.focus();
  }

  function toggleActions(name: string, trigger: HTMLButtonElement) {
    actionTriggers.set(name, trigger);
    openActions = openActions === name ? null : name;
  }

  function onDocumentClick(event: MouseEvent) {
    if (openActions && !(event.target as Element | null)?.closest("[data-model-actions]")) closeActions();
  }

  function closeDeleteModal({ restoreFocus = true } = {}) {
    deletingModel = null;
    if (restoreFocus) {
      const trigger = deleteReturnFocus;
      deleteReturnFocus = null;
      void tick().then(() => trigger?.focus());
    }
  }

  async function openDeleteModal(name: string) {
    deleteReturnFocus = actionTriggers.get(name) || null;
    closeActions();
    deletingModel = name;
    await tick();
    deleteCancelButton?.focus();
  }

  function onDocumentKeydown(event: KeyboardEvent) {
    if (event.key === "Tab" && deletingModel && deleteDialog) {
      const focusable = [...deleteDialog.querySelectorAll<HTMLElement>("button:not(:disabled), [href], input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex='-1'])")];
      const first = focusable[0];
      const last = focusable.at(-1);
      if (first && last && event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (first && last && !event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
      return;
    }
    if (event.key !== "Escape") return;
    if (deletingModel) closeDeleteModal();
    else if (openActions) closeActions({ restoreFocus: true });
  }

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
    editingModel = null; modalMode = "add"; fName = ""; fType = "concrete"; fDisabled = false; fHidden = false;
    fVersion = ""; fBackend = ""; fPricing = { input: "", output: "", cache_write: "", cache_read: "" };
    fTargets = []; fTargetSelection = "sticky"; fMaxAttempts = ""; fTargetCandidate = "";
    availableModels = []; upstreamFetched = false;
  }

  function openAdd() { resetForm(); modalMode = "add"; modalOpen = true; }

  function populateForm(m: Model) {
    fName = m.name;
    fType = isAuto(m) ? "auto" : "concrete";
    fDisabled = m.disabled === true;
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
  }

  function openEdit(name: string) {
    const m = models.find((e) => e.name === name);
    if (!m) return toast.show("Model not found", "error");
    resetForm();
    editingModel = name;
    modalMode = "edit";
    populateForm(m);
    modalOpen = true;
  }

  function openClone(name: string) {
    const m = models.find((e) => e.name === name);
    if (!m) return toast.show("Model not found", "error");
    resetForm();
    modalMode = "clone";
    populateForm(m);
    fName = `${m.name} Copy`;
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
    if (submitting) return;
    const backend = fBackend.trim();
    if (fType === "concrete" && !backend) return toast.show("Please enter a backend name", "error");
    const name = effectiveModelName(fName, fType, backend);
    if (!name) return toast.show("Please enter a display name", "error");
    if (isDuplicateModelName(name, models, modalMode === "edit" ? editingModel : null)) {
      return toast.show("A model with that name already exists", "error");
    }
    const payload: Record<string, unknown> = { name, modelType: fType, disabled: fDisabled, hidden: fHidden, pricing: pricingPayload() };

    if (fType === "auto") {
      const unique = [...new Set(fTargets)];
      if (unique.length !== fTargets.length) return toast.show("Targets must be unique", "error");
      const maxAttempts = numericInputValue(fMaxAttempts);
      if (maxAttempts !== null && (!Number.isInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > 20)) return toast.show("Maximum target attempts must be an integer from 1 to 20", "error");
      payload.targets = unique;
      payload.targetSelection = fTargetSelection;
      payload.maxTargetAttempts = maxAttempts;
    } else {
      if (!fVersion) return toast.show("Please select an endpoint version", "error");
      payload.backend = backend;
      payload.version = fVersion;
    }

    submitting = true;
    try {
      const editing = modalMode === "edit" && editingModel;
      const res = await fetch("/api/models", {
        method: editing ? "PUT" : "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(editing ? { oldName: editingModel, ...payload } : payload),
      });
      if (res.status === 401 || res.status === 403) { window.location.href = "/admin/login"; return; }
      const data = await res.json().catch(() => ({})) as { error?: string; dependents?: string[]; blockers?: string[] };
      if (!res.ok) throw new Error(res.status === 409 ? depMessage(data, "Model has active dependencies") : (data.error || `Failed to ${editing ? "update" : "add"} model`));
      toast.show(`Model ${modalMode === "clone" ? "cloned" : editing ? "updated" : "added"} successfully`);
      closeModal();
      await load();
    } catch (e) {
      toast.show(e instanceof Error ? e.message : "Failed", "error");
    } finally {
      submitting = false;
    }
  }

  async function toggleDisabled(name: string) {
    if (togglingDisabled.has(name)) return;
    togglingDisabled = new Set(togglingDisabled).add(name);
    try {
      const res = await fetch("/api/models/toggle", { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name }) });
      if (res.status === 401 || res.status === 403) { window.location.href = "/admin/login"; return; }
      const data = await res.json().catch(() => ({})) as { error?: string; message?: string; dependents?: string[]; blockers?: string[] };
      if (!res.ok) throw new Error(res.status === 409 ? depMessage(data, "Model has active dependencies") : (data.error || "Failed to toggle model"));
      toast.show(data.message || "Model updated");
      await load();
    } catch (e) {
      toast.show(e instanceof Error ? e.message : "Failed", "error");
    } finally {
      const next = new Set(togglingDisabled);
      next.delete(name);
      togglingDisabled = next;
    }
  }

  async function toggleVisibility(name: string) {
    if (togglingVisibility.has(name)) return;
    togglingVisibility = new Set(togglingVisibility).add(name);
    try {
      const res = await fetch("/api/models/visibility", { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name }) });
      if (res.status === 401 || res.status === 403) { window.location.href = "/admin/login"; return; }
      const data = await res.json().catch(() => ({})) as { error?: string; message?: string };
      if (!res.ok) throw new Error(data.error || "Failed to update model visibility");
      toast.show(data.message || "Model visibility updated");
      await load();
    } catch (e) {
      toast.show(e instanceof Error ? e.message : "Failed", "error");
    } finally {
      const next = new Set(togglingVisibility);
      next.delete(name);
      togglingVisibility = next;
    }
  }

  async function testModel(name: string) {
    if (testingModels.has(name)) return;
    testingModels = new Set(testingModels).add(name);
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
    } finally {
      const next = new Set(testingModels);
      next.delete(name);
      testingModels = next;
    }
  }

  async function confirmDelete() {
    if (!deletingModel || deleting) return;
    deleting = true;
    try {
      const res = await fetch("/api/models", { method: "DELETE", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name: deletingModel }) });
      if (res.status === 401 || res.status === 403) { window.location.href = "/admin/login"; return; }
      const data = await res.json().catch(() => ({})) as { error?: string; dependents?: string[]; blockers?: string[] };
      if (!res.ok) throw new Error(res.status === 409 ? depMessage(data, "Model has active dependencies") : (data.error || "Failed to delete model"));
      toast.show("Model deleted successfully");
      closeDeleteModal({ restoreFocus: false });
      await load();
    } catch (e) {
      toast.show(e instanceof Error ? e.message : "Failed", "error");
    } finally {
      deleting = false;
    }
  }

  $effect(() => {
    pageHeaderActions.set({ count: models.length, noun: "model", icon: "fa-solid fa-cube", addLabel: "Add Model", onAdd: openAdd });
  });

  onMount(() => {
    void load();
    document.addEventListener("click", onDocumentClick);
    document.addEventListener("keydown", onDocumentKeydown);
    return () => {
      document.removeEventListener("click", onDocumentClick);
      document.removeEventListener("keydown", onDocumentKeydown);
      pageHeaderActions.set(null);
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
      {#each Array(6) as _}
        <div class="skeleton-row">
          <span class="skeleton-block skeleton-cell wide"></span>
          <span class="skeleton-block skeleton-cell"></span>
          <span class="skeleton-block skeleton-cell"></span>
          <span class="skeleton-block skeleton-cell narrow"></span>
        </div>
      {/each}
    </div>
  </div>
  <span class="sr-only" role="status">Loading models…</span>
{:else if errorMsg}
  <div class="page-error" role="alert">{errorMsg}</div>
{:else if models.length === 0}
  <div class="empty-state"><i class="fa-solid fa-cube"></i><p>No models configured. Add one to get started!</p></div>
{:else}
  {#key testVersion}
  <div class="card models-card">
    <div class="models-toolbar">
      <label class="model-search" aria-label="Search models">
        <i class="fa-solid fa-magnifying-glass" aria-hidden="true"></i>
        <input type="search" bind:value={query} placeholder="Search models, backends, endpoints, or targets…" />
        {#if query}<button type="button" aria-label="Clear search" onclick={() => query = ""}><i class="fa-solid fa-xmark"></i></button>{/if}
      </label>
      <span class="search-count">{visibleCount} of {models.length}</span>
      <button class="btn btn-secondary filters-toggle" class:active={filtersOpen || activeFilterCount > 0} type="button" aria-expanded={filtersOpen} aria-controls="model-filters" onclick={() => filtersOpen = !filtersOpen}>
        <i class="fa-solid fa-sliders"></i> Filters
        {#if activeFilterCount}<span class="filter-count">{activeFilterCount}</span>{/if}
        <i class="fa-solid fa-chevron-{filtersOpen ? 'up' : 'down'}"></i>
      </button>
    </div>
    {#if filtersOpen}
      <div id="model-filters" class="model-filters">
        <label>Endpoint<select bind:value={endpointFilter} class="form-select"><option value="all">All endpoints</option>{#each endpointFilterOptions as key}<option value={key}>{groupLabel(key)}{key.startsWith("v") ? ` (${key})` : ""}</option>{/each}</select></label>
        <label>Type<select bind:value={typeFilter} class="form-select"><option value="all">All types</option><option value="concrete">Concrete</option><option value="auto">Automatic</option></select></label>
        <label>State<select bind:value={stateFilter} class="form-select"><option value="all">Any state</option><option value="enabled">Enabled</option><option value="disabled">Disabled</option></select></label>
        <label>Visibility<select bind:value={visibilityFilter} class="form-select"><option value="all">Any visibility</option><option value="public">Public</option><option value="hidden">Hidden</option></select></label>
        <label>Sort by<select bind:value={sortField} class="form-select"><option value="name">Name</option><option value="status">Status</option></select></label>
        <label>Direction<select bind:value={sortDirection} class="form-select"><option value="asc">Ascending</option><option value="desc">Descending</option></select></label>
        <button class="btn btn-secondary clear-filters" type="button" onclick={clearCriteria} disabled={!activeCriteria}>Clear</button>
      </div>
    {/if}
    <div class="card-body models-list">
      {#if grouped.length === 0}
        <div class="filtered-empty"><i class="fa-solid fa-magnifying-glass"></i><strong>No models match</strong><span>Try a different search or clear the current filters.</span><button class="btn btn-secondary btn-sm" type="button" onclick={clearCriteria}>Clear search and filters</button></div>
      {:else}
        {#each grouped as group (group.key)}
          {@const expanded = isGroupExpanded(group)}
          <section class="endpoint-group" class:auto-model-group={group.auto}>
            <h2 class="endpoint-group-heading">
              <button class="endpoint-group-header" type="button" aria-expanded={expanded} aria-controls={groupBodyId(group.key)} onclick={() => toggleGroup(group)}>
                <span class="endpoint-icon"><i class="fa-solid {group.auto ? 'fa-shuffle' : group.kind === 'unknown' ? 'fa-triangle-exclamation' : 'fa-hexagon-nodes'}"></i></span>
                <span class="endpoint-title"><span class="endpoint-name">{group.label}</span>{#if group.key.startsWith("v")}<span class="endpoint-key">{group.key}</span>{/if}</span>
                <span class="endpoint-summary">
                  <span>{group.items.length}{activeCriteria && group.items.length !== group.total ? ` of ${group.total}` : ""} model{group.items.length === 1 ? "" : "s"}</span>
                  {#if group.disabled}<span class="summary-flag disabled">{group.disabled} disabled</span>{/if}
                  {#if group.hidden}<span class="summary-flag hidden">{group.hidden} hidden</span>{/if}
                </span>
                <i class="group-chevron fa-solid fa-chevron-{expanded ? 'up' : 'down'}" aria-hidden="true"></i>
              </button>
            </h2>
            {#if expanded}
              <div id={groupBodyId(group.key)} class="endpoint-group-models">
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
                        <button class="btn btn-test btn-sm" type="button" title="Test model (silent — not logged)" aria-label={`Test ${model.name}`} onclick={() => testModel(model.name)} disabled={testingModels.has(model.name)} aria-busy={testingModels.has(model.name)}>{#if testingModels.has(model.name)}<span class="button-spinner" aria-hidden="true"></span>{:else}<i class="fa-solid fa-flask"></i>{/if}</button>
                      {/if}
                      <button class="btn btn-secondary btn-sm" type="button" onclick={() => openEdit(model.name)}><i class="fa-solid fa-pen"></i> Edit</button>
                      <div class="model-actions-menu" data-model-actions>
                        <button class="btn btn-secondary btn-sm more-actions" type="button" aria-label={`More actions for ${model.name}`} aria-expanded={openActions === model.name} aria-controls={actionPanelId(model.name)} onclick={(event) => { event.stopPropagation(); toggleActions(model.name, event.currentTarget); }}><i class="fa-solid fa-ellipsis-vertical"></i></button>
                        {#if openActions === model.name}
                          <div class="action-popover" id={actionPanelId(model.name)}>
                            <button type="button" onclick={() => { closeActions(); openClone(model.name); }}><i class="fa-solid fa-copy"></i><span>Clone</span></button>
                            <button type="button" onclick={() => { closeActions(); void toggleDisabled(model.name); }} disabled={togglingDisabled.has(model.name)}><i class="fa-solid fa-{model.disabled ? 'play' : 'pause'}"></i><span>{model.disabled ? "Enable model" : "Disable model"}</span></button>
                            <button type="button" onclick={() => { closeActions(); void toggleVisibility(model.name); }} disabled={togglingVisibility.has(model.name)}><i class="fa-solid fa-eye{model.hidden ? '' : '-slash'}"></i><span>{model.hidden ? "Show publicly" : "Hide publicly"}</span></button>
                            <button class="danger" type="button" onclick={() => openDeleteModal(model.name)}><i class="fa-solid fa-trash"></i><span>Delete model</span></button>
                          </div>
                        {/if}
                      </div>
                    </div>
                  </div>
                {/each}
              </div>
            {/if}
          </section>
        {/each}
      {/if}
    </div>
  </div>
  {/key}
{/if}

<!-- Add/Edit modal -->
{#if modalOpen}
  <div class="modal-backdrop active" transition:fade={{ duration: motionDuration(300) }} onclick={(e) => { if (e.target === e.currentTarget) closeModal(); }} role="presentation">
    <div class="modal" transition:scale={{ duration: motionDuration(300), start: 0.9 }} role="dialog" aria-modal="true">
      <div class="modal-header"><h2>{modalMode === "edit" ? "Edit Model" : modalMode === "clone" ? "Clone Model" : "Add Model"}</h2><button class="modal-close" type="button" onclick={closeModal}>✕</button></div>

      <div class="form-group">
        <label for="mName">Display Name{fType === "concrete" ? " (optional)" : ""}</label>
        <input id="mName" type="text" bind:value={fName} placeholder={fType === "concrete" ? "Uses backend name when blank" : "automatic-model"} />
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
          <select id="mVersion" bind:value={fVersion} onchange={() => { availableModels = []; upstreamFetched = false; }} class="form-select" style="width:100%;" disabled={fetchingModels}>
            <option value="">Select an endpoint</option>
            {#each versionKeys as v}<option value={v}>{endpoints[v]?.name || v}</option>{/each}
          </select>
        </div>
        <div class="form-group">
          <label for="mBackend">Backend Model</label>
          <div style="display:flex;gap:8px;">
            <input id="mBackend" type="text" bind:value={fBackend} placeholder="Backend model name" style="flex:1;" />
            <button class="btn btn-secondary btn-sm" type="button" onclick={fetchUpstream} disabled={fetchingModels || !fVersion} aria-busy={fetchingModels}>
              {#if fetchingModels}<span class="button-spinner" aria-hidden="true"></span> Fetching…{:else}Fetch{/if}
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
          <p class="form-help">Add any number of concrete model names. Order controls failover priority; unavailable names are skipped at request time.</p>
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
          <input type="checkbox" bind:checked={fDisabled} />
          <div class="toggle-track"></div><div class="toggle-thumb"></div>
          <span style="text-transform:none;letter-spacing:0;font-weight:400;color:var(--text-primary);">Disabled</span>
        </label>
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
        <button class="btn btn-primary" type="button" onclick={submit} disabled={submitting} aria-busy={submitting}>{#if submitting}<span class="button-spinner" aria-hidden="true"></span> Saving…{:else}{modalMode === "edit" ? "Save Changes" : modalMode === "clone" ? "Create Clone" : "Add Model"}{/if}</button>
      </div>
    </div>
  </div>
{/if}

<!-- Delete modal -->
{#if deletingModel}
  <div class="modal-backdrop active" transition:fade={{ duration: motionDuration(300) }} onclick={(e) => { if (e.target === e.currentTarget) closeDeleteModal(); }} role="presentation">
    <div class="modal" bind:this={deleteDialog} transition:scale={{ duration: motionDuration(300), start: 0.9 }} role="dialog" aria-modal="true" aria-labelledby="delete-model-title">
      <div class="modal-header"><h2 id="delete-model-title">Delete Model</h2><button class="modal-close" type="button" aria-label="Close delete confirmation" onclick={() => closeDeleteModal()}>✕</button></div>
      <p>Are you sure you want to delete <strong>{deletingModel}</strong>? This cannot be undone.</p>
      <div class="modal-footer">
        <button class="btn btn-secondary" type="button" bind:this={deleteCancelButton} onclick={() => closeDeleteModal()}>Cancel</button>
        <button class="btn btn-danger" type="button" onclick={confirmDelete} disabled={deleting} aria-busy={deleting}>{#if deleting}<span class="button-spinner" aria-hidden="true"></span> Deleting…{:else}Delete{/if}</button>
      </div>
    </div>
  </div>
{/if}

<style>
  .models-card { overflow: visible; }
  .models-toolbar { display: flex; align-items: center; gap: 12px; padding: 18px 24px; border-bottom: 1px solid var(--border-color); }
  .model-search { display: flex; min-width: 220px; max-width: 680px; height: 42px; align-items: center; flex: 1; gap: 10px; padding: 0 12px; border: 1px solid var(--border-color); border-radius: 10px; background: var(--bg-secondary); color: var(--text-secondary); transition: border-color .2s ease, box-shadow .2s ease; }
  .model-search:focus-within { border-color: var(--primary); box-shadow: 0 0 0 3px var(--primary-alpha-012); }
  .model-search input { width: 100%; min-width: 0; padding: 0; border: 0; outline: 0; background: transparent; box-shadow: none; color: var(--text-primary); }
  .model-search button { display: inline-flex; width: 28px; height: 28px; align-items: center; justify-content: center; flex-shrink: 0; border: 0; background: transparent; color: var(--text-secondary); cursor: pointer; }
  .search-count { flex-shrink: 0; color: var(--text-secondary); font-size: 12px; font-variant-numeric: tabular-nums; }
  .filters-toggle { min-width: 118px; justify-content: center; }
  .filters-toggle.active { border-color: var(--primary-alpha-035); background: var(--primary-alpha-012); color: var(--primary-dark); }
  .filter-count { display: inline-flex; min-width: 18px; height: 18px; align-items: center; justify-content: center; border-radius: 999px; background: var(--primary); color: white; font-size: 10px; }
  .model-filters { display: grid; grid-template-columns: repeat(6, minmax(110px, 1fr)) auto; align-items: end; gap: 12px; padding: 16px 24px; border-bottom: 1px solid var(--border-color); background: var(--bg-tertiary); }
  .model-filters label { display: flex; min-width: 0; flex-direction: column; gap: 6px; color: var(--text-secondary); font-size: 10px; font-weight: 600; letter-spacing: .06em; text-transform: uppercase; }
  .model-filters select { width: 100%; min-width: 0; height: 38px; font-size: 12px; text-transform: none; }
  .clear-filters { height: 38px; }
  .card-body { padding: 18px 24px 24px; }
  .models-list { display: flex; flex-direction: column; gap: 10px; }
  .filtered-empty { display: flex; min-height: 260px; align-items: center; justify-content: center; flex-direction: column; gap: 9px; color: var(--text-secondary); text-align: center; }
  .filtered-empty > i { color: var(--gray-300); font-size: 30px; }
  .filtered-empty strong { color: var(--text-primary); font-size: 16px; }
  .filtered-empty span { font-size: 13px; }
  .endpoint-group { position: relative; border: 1px solid var(--border-color); border-radius: 11px; background: var(--card-bg); }
  .endpoint-group-heading { margin: 0; }
  .endpoint-group-header { display: flex; width: 100%; min-width: 0; align-items: center; gap: 11px; padding: 12px 14px; border: 0; border-radius: 10px; background: transparent; color: inherit; font: inherit; text-align: left; cursor: pointer; transition: background .2s ease, border-color .2s ease; }
  .endpoint-group-header:hover { background: var(--gray-50); }
  .endpoint-group-header:focus-visible { outline: 2px solid var(--primary); outline-offset: 2px; }
  .endpoint-icon { display: flex; width: 32px; height: 32px; align-items: center; justify-content: center; flex-shrink: 0; border-radius: 8px; background: var(--gradient-primary); color: white; font-size: 13px; }
  .endpoint-title { display: flex; min-width: 0; align-items: baseline; gap: 7px; }
  .endpoint-name { overflow: hidden; color: var(--text-primary); font-size: 14px; font-weight: 600; text-overflow: ellipsis; white-space: nowrap; }
  .endpoint-key { flex-shrink: 0; color: var(--text-secondary); font-family: "Courier New", monospace; font-size: 10px; }
  .endpoint-summary { display: flex; align-items: center; justify-content: flex-end; flex: 1; flex-wrap: wrap; gap: 6px; color: var(--text-secondary); font-size: 11px; }
  .summary-flag { padding: 2px 7px; border-radius: 999px; font-weight: 600; }
  .summary-flag.disabled { background: rgba(245,158,11,.12); color: #b45309; }
  .summary-flag.hidden { background: var(--gray-100); color: var(--gray-600); }
  .group-chevron { width: 14px; flex-shrink: 0; color: var(--text-secondary); font-size: 11px; text-align: center; }
  .endpoint-group-models { display: flex; flex-direction: column; gap: 8px; margin: 0 14px 14px 29px; padding: 12px 0 0 13px; border-top: 1px solid var(--border-color); border-left: 2px solid var(--primary-alpha-015); }
  .model-item { position: relative; display: flex; align-items: center; justify-content: space-between; padding: 14px 16px; border: 1px solid var(--border-color); border-radius: 8px; background: var(--bg-secondary); transition: border-color .2s ease; }
  .model-item:hover { border-color: var(--primary); }
  .model-item.disabled-model > .model-info,
  .model-item.disabled-model > .model-actions > :not(.model-actions-menu) { opacity: .5; }
  .model-item.disabled-model .model-icon { background: var(--gray-300); }
  .model-info { display: flex; align-items: center; min-width: 0; flex: 1; gap: 12px; }
  .model-icon { display: flex; width: 40px; height: 40px; align-items: center; justify-content: center; flex-shrink: 0; border-radius: 10px; background: var(--gradient-primary); color: white; }
  .model-meta { display: flex; min-width: 0; flex: 1; flex-direction: row; gap: 6px; }
  .model-meta-row { display: flex; min-width: 0; align-items: center; flex-wrap: wrap; gap: 8px; }
  .model-name { min-width: 0; overflow-wrap: anywhere; color: var(--text-primary); font-weight: 500; }
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
  .model-actions { display: flex; align-items: center; flex-shrink: 0; gap: 8px; }
  .model-actions-menu { position: relative; }
  .more-actions { width: 34px; justify-content: center; padding-right: 0; padding-left: 0; }
  .action-popover { position: absolute; top: calc(100% + 7px); right: 0; z-index: 30; display: flex; width: 210px; flex-direction: column; gap: 3px; padding: 6px; border: 1px solid var(--border-color); border-radius: 10px; background: var(--card-bg); box-shadow: 0 12px 30px rgba(0,0,0,.15); }
  .action-popover button { display: flex; width: 100%; align-items: center; gap: 9px; padding: 9px 10px; border: 0; border-radius: 7px; background: transparent; color: var(--text-primary); font: inherit; font-size: 12px; text-align: left; cursor: pointer; }
  .action-popover button:hover { background: var(--gray-100); }
  .action-popover button:focus-visible { outline: 2px solid var(--primary); outline-offset: -1px; }
  .action-popover button:disabled { opacity: .5; cursor: not-allowed; }
  .action-popover button i { width: 15px; color: var(--text-secondary); text-align: center; }
  .action-popover button.danger { margin-top: 3px; border-top: 1px solid var(--border-color); border-radius: 0 0 7px 7px; color: var(--danger); }
  .action-popover button.danger i { color: var(--danger); }
  .btn-test { border: 1px solid var(--primary-alpha-035); background: var(--primary-alpha-012); color: var(--primary); }
  .test-result-badge { display: inline-flex; align-items: center; gap: 4px; padding: 2px 7px; border-radius: 10px; font-size: 11px; font-weight: 600; white-space: nowrap; }
  .test-result-badge.ok { border: 1px solid var(--success-alpha-04); background: var(--success-alpha-01); color: var(--success-dark); }
  .test-result-badge.fail { border: 1px solid var(--danger-alpha-02); background: var(--danger-alpha-01); color: var(--danger-dark); }
  .auto-model-group { border-color: var(--primary-alpha-035); }
  .auto-model-group .endpoint-group-header { background: var(--primary-alpha-01); }
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
  @media (max-width: 1100px) {
    .model-filters { grid-template-columns: repeat(3, minmax(130px, 1fr)); }
    .clear-filters { justify-self: start; }
  }
  @media (max-width: 760px) {
    .models-toolbar { align-items: stretch; flex-wrap: wrap; padding: 14px 16px; }
    .model-search { max-width: none; flex-basis: 100%; }
    .search-count { align-self: center; }
    .filters-toggle { margin-left: auto; }
    .model-filters { grid-template-columns: repeat(2, minmax(0, 1fr)); padding: 14px 16px; }
    .card-body { padding: 14px 16px 18px; }
    .endpoint-group-header { align-items: center; flex-wrap: wrap; }
    .endpoint-title { flex: 1; }
    .endpoint-summary { order: 3; min-width: 100%; justify-content: flex-start; padding-left: 43px; }
    .endpoint-group-models { margin-right: 10px; margin-left: 16px; padding-left: 8px; }
    .model-item { align-items: flex-start; flex-direction: column; gap: 12px; }
    .model-meta { flex-direction: column; }
    .model-pricing { margin: 6px 0 0; }
    .model-actions { align-self: flex-end; flex-wrap: wrap; }
  }
  @media (max-width: 480px) {
    .model-filters { grid-template-columns: 1fr; }
    .endpoint-summary { padding-left: 0; }
    .model-info { align-items: flex-start; }
    .model-icon { width: 34px; height: 34px; }
    .model-actions { width: 100%; justify-content: flex-end; }
    .action-popover { right: 0; width: min(210px, calc(100vw - 64px)); }
  }
</style>
