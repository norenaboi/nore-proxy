<script lang="ts">
  import { onMount, tick } from "svelte";
  import { fade, scale } from "svelte/transition";
  import { requestAdminJson, formatNumber } from "$frontend/lib/api/admin";
  import { motionDuration } from "$frontend/lib/motion";

  interface ModelStats {
    model: string; requests: number; input_tokens: number; output_tokens: number;
    cache_write_tokens: number; cache_read_tokens: number; total_tokens: number;
    cost: number; errors: number; cache_tokens: number;
  }

  type SortCol = "model" | "requests" | "input_tokens" | "output_tokens" | "cache_tokens" | "total_tokens" | "cost" | "errors";
  type DialogMode = "rename" | "conjoin" | "delete-explain" | "delete-confirm";

  let data = $state<ModelStats[]>([]);
  let loading = $state(true);
  let errorMsg = $state("");
  let sortCol = $state<SortCol>("total_tokens");
  let sortDir = $state<"asc" | "desc">("desc");
  let openActions = $state<string | null>(null);
  let actionPopoverStyle = $state("");
  let dialogMode = $state<DialogMode | null>(null);
  let selectedModel = $state("");
  let destination = $state("");
  let deleteConfirmation = $state("");
  let operationError = $state("");
  let submitting = $state(false);
  let dialog = $state<HTMLElement | null>(null);
  let safeInitialButton = $state<HTMLButtonElement | null>(null);
  let renameInput = $state<HTMLInputElement | null>(null);
  const actionTriggers = new Map<string, HTMLButtonElement>();
  let returnFocus: HTMLButtonElement | null = null;

  const sorted = $derived([...data].sort((a, b) => {
    const av = a[sortCol], bv = b[sortCol];
    if (sortCol === "model") return sortDir === "asc" ? String(av).localeCompare(String(bv)) : String(bv).localeCompare(String(av));
    return sortDir === "asc" ? (av as number) - (bv as number) : (bv as number) - (av as number);
  }));
  const maxTotalTokens = $derived(Math.max(0, ...data.map((row) => row.total_tokens)));
  const conjoinTargets = $derived(data.map((row) => row.model).filter((name) => name !== selectedModel).sort((a, b) => a.localeCompare(b)));
  const canSubmit = $derived(
    dialogMode === "rename" ? destination.trim().length > 0 && destination.trim() !== selectedModel
      : dialogMode === "conjoin" ? destination.length > 0 && destination !== selectedModel
        : dialogMode === "delete-confirm" ? deleteConfirmation === selectedModel
          : false,
  );

  function statsPercent(totalTokens: number) {
    if (maxTotalTokens <= 0) return 0;
    return Math.min(100, Math.max(0, totalTokens / maxTotalTokens * 100));
  }

  function sort(col: SortCol) {
    if (sortCol === col) sortDir = sortDir === "asc" ? "desc" : "asc";
    else { sortCol = col; sortDir = "desc"; }
  }

  function rankClass(i: number) { return i === 0 ? "top-1" : i === 1 ? "top-2" : i === 2 ? "top-3" : "other"; }

  function actionPanelId(name: string) {
    let hash = 0;
    for (const char of name) hash = ((hash << 5) - hash + char.charCodeAt(0)) | 0;
    return `stats-actions-${Math.abs(hash)}`;
  }

  async function load() {
    errorMsg = "";
    const response = await requestAdminJson<{ models: ModelStats[] }>("/api/model-stats");
    data = response.models.map((model) => ({
      ...model,
      cost: model.cost || 0,
      cache_tokens: model.cache_write_tokens + model.cache_read_tokens,
    }));
  }

  function closeActions({ restoreFocus = false } = {}) {
    const model = openActions;
    openActions = null;
    if (restoreFocus && model) actionTriggers.get(model)?.focus();
  }

  function toggleActions(name: string, trigger: HTMLButtonElement) {
    actionTriggers.set(name, trigger);
    if (openActions === name) {
      closeActions();
      return;
    }
    const rect = trigger.getBoundingClientRect();
    const popoverWidth = 190;
    const popoverHeight = 132;
    const gap = 7;
    const viewportPadding = 12;
    const left = Math.min(
      window.innerWidth - popoverWidth - viewportPadding,
      Math.max(viewportPadding, rect.right - popoverWidth),
    );
    const top = rect.bottom + gap + popoverHeight <= window.innerHeight - viewportPadding
      ? rect.bottom + gap
      : Math.max(viewportPadding, rect.top - popoverHeight - gap);
    actionPopoverStyle = `top:${top}px;left:${left}px`;
    openActions = name;
  }

  async function openDialog(mode: DialogMode, model: string) {
    returnFocus = actionTriggers.get(model) || null;
    closeActions();
    selectedModel = model;
    destination = "";
    deleteConfirmation = "";
    operationError = "";
    dialogMode = mode;
    await tick();
    if (mode === "rename") renameInput?.focus();
    else safeInitialButton?.focus();
  }

  function closeDialog({ restoreFocus = true } = {}) {
    if (submitting) return;
    dialogMode = null;
    selectedModel = "";
    destination = "";
    deleteConfirmation = "";
    operationError = "";
    if (restoreFocus) {
      const trigger = returnFocus;
      returnFocus = null;
      void tick().then(() => trigger?.focus());
    }
  }

  async function advanceDeleteConfirmation() {
    dialogMode = "delete-confirm";
    operationError = "";
    await tick();
    renameInput?.focus();
  }

  async function submitMutation() {
    if (!canSubmit || submitting || !dialogMode) return;
    submitting = true;
    operationError = "";
    try {
      if (dialogMode === "delete-confirm") {
        await requestAdminJson("/api/model-stats", {
          method: "DELETE",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ source: selectedModel }),
        });
      } else {
        await requestAdminJson(`/api/model-stats/${dialogMode}`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ source: selectedModel, target: destination.trim() }),
        });
      }
      submitting = false;
      closeDialog({ restoreFocus: false });
      await load();
    } catch (error) {
      operationError = error instanceof Error ? error.message : "The database change failed";
    } finally {
      submitting = false;
    }
  }

  function onDocumentClick(event: MouseEvent) {
    if (openActions && !(event.target as Element | null)?.closest("[data-stats-actions]")) closeActions();
  }

  function onDocumentKeydown(event: KeyboardEvent) {
    if (event.key === "Tab" && dialogMode && dialog) {
      const focusable = [...dialog.querySelectorAll<HTMLElement>("button:not(:disabled), [href], input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex='-1'])")];
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
    if (dialogMode) closeDialog();
    else if (openActions) closeActions({ restoreFocus: true });
  }

  onMount(() => {
    document.addEventListener("click", onDocumentClick);
    document.addEventListener("keydown", onDocumentKeydown);
    void load().catch((error) => {
      errorMsg = error instanceof Error ? error.message : "Failed to load";
    }).finally(() => { loading = false; });
    return () => {
      document.removeEventListener("click", onDocumentClick);
      document.removeEventListener("keydown", onDocumentKeydown);
    };
  });
</script>

{#if loading}
  <section class="models-table-card skeleton" aria-hidden="true">
    <div class="skeleton-head">
      <span class="skeleton-block skeleton-eyebrow"></span>
      <span class="skeleton-block skeleton-heading"></span>
    </div>
    <div class="skeleton-rows">
      {#each Array(8) as _}
        <div class="skeleton-row">
          <span class="skeleton-block skeleton-cell narrow"></span>
          <span class="skeleton-block skeleton-cell wide"></span>
          <span class="skeleton-block skeleton-cell"></span>
          <span class="skeleton-block skeleton-cell"></span>
          <span class="skeleton-block skeleton-cell"></span>
        </div>
      {/each}
    </div>
  </section>
  <span class="sr-only" role="status">Loading model stats…</span>
{:else if errorMsg}
  <div class="page-error" role="alert">{errorMsg}</div>
{:else}
  <section class="models-table-card">
    <div class="table-header"><h2><i class="fa-solid fa-chart-bar"></i> Models by Stats</h2></div>
    <div class="table-scroll">
      <table>
        <thead><tr><th class="rank-column">Rank</th>{#each ([['model','Model'],['requests','Requests'],['input_tokens','Input Tokens'],['output_tokens','Output Tokens'],['cache_tokens','Cache Tokens'],['total_tokens','Total Tokens'],['cost','Cost'],['errors','Errors']] as [string,string][]) as [col, label]}<th class="sortable {sortCol === col ? `sorted-${sortDir}` : ''}" onclick={() => sort(col as SortCol)}>{label}</th>{/each}<th class="actions-column"><span class="sr-only">Actions</span></th></tr></thead>
        <tbody>
          {#if sorted.length === 0}
            <tr><td colspan="10"><div class="empty-state"><i class="fa-solid fa-inbox"></i><p>No model stats data available</p></div></td></tr>
          {:else}
            {#each sorted as row, i (row.model)}
              <tr>
                <td><span class="rank-badge {rankClass(i)}">{i + 1}</span></td>
                <td><span class="model-name">{row.model}</span></td>
                <td><span class="metric-value requests">{row.requests.toLocaleString()}</span></td>
                <td><span class="metric-value tokens">{formatNumber(row.input_tokens)}</span></td>
                <td><span class="metric-value tokens">{formatNumber(row.output_tokens)}</span></td>
                <td title="Write: {formatNumber(row.cache_write_tokens)}, Read: {formatNumber(row.cache_read_tokens)}"><span class="metric-value tokens">{formatNumber(row.cache_tokens)}</span></td>
                <td>
                  <div class="total-stats">
                    <span class="metric-value tokens">{formatNumber(row.total_tokens)}</span>
                    <div class="stats-bar" role="progressbar" aria-label={`${row.model} relative token stats`} aria-valuemin="0" aria-valuemax={maxTotalTokens} aria-valuenow={row.total_tokens}>
                      <div class="stats-bar-fill" style:width={`${statsPercent(row.total_tokens)}%`}></div>
                    </div>
                  </div>
                </td>
                <td><span class="metric-value">${row.cost.toFixed(2)}</span></td>
                <td><span class="metric-value errors">{row.errors.toLocaleString()}</span></td>
                <td class="actions-cell">
                  <div class="stats-actions-menu" data-stats-actions>
                    <button class="more-actions" type="button" aria-label={`More actions for ${row.model}`} aria-expanded={openActions === row.model} aria-controls={actionPanelId(row.model)} onclick={(event) => { event.stopPropagation(); toggleActions(row.model, event.currentTarget); }}><i class="fa-solid fa-ellipsis-vertical"></i></button>
                    {#if openActions === row.model}
                      <div class="action-popover" id={actionPanelId(row.model)} style={actionPopoverStyle}>
                        <button type="button" onclick={() => openDialog("rename", row.model)}><i class="fa-solid fa-pen"></i><span>Rename history</span></button>
                        <button type="button" onclick={() => openDialog("conjoin", row.model)} disabled={data.length < 2}><i class="fa-solid fa-code-merge"></i><span>Conjoin into…</span></button>
                        <button class="danger" type="button" onclick={() => openDialog("delete-explain", row.model)}><i class="fa-solid fa-trash"></i><span>Delete data</span></button>
                      </div>
                    {/if}
                  </div>
                </td>
              </tr>
            {/each}
          {/if}
        </tbody>
      </table>
    </div>
  </section>
{/if}

{#if dialogMode}
  <div class="modal-backdrop active" transition:fade={{ duration: motionDuration(300) }} onclick={(event) => { if (event.target === event.currentTarget) closeDialog(); }} role="presentation">
    <div class="modal stats-modal" bind:this={dialog} transition:scale={{ duration: motionDuration(300), start: 0.9 }} role="dialog" aria-modal="true" aria-labelledby="stats-dialog-title">
      <div class="modal-header">
        <h2 id="stats-dialog-title">{dialogMode === "rename" ? "Rename Stats History" : dialogMode === "conjoin" ? "Conjoin Stats History" : dialogMode === "delete-explain" ? "Delete Historical Data" : "Permanently Delete Data"}</h2>
        <button class="modal-close" type="button" aria-label="Close dialog" onclick={() => closeDialog()} disabled={submitting}>✕</button>
      </div>

      {#if dialogMode === "rename"}
        <p>Rename database history for <strong>{selectedModel}</strong>. This changes analytics history only; configured models and live routing are not changed.</p>
        <div class="form-group">
          <label for="stats-destination">New historical name</label>
          <input id="stats-destination" bind:this={renameInput} bind:value={destination} autocomplete="off" onkeydown={(event) => { if (event.key === "Enter") void submitMutation(); }} />
        </div>
      {:else if dialogMode === "conjoin"}
        <p>Move every request attributed to <strong>{selectedModel}</strong> into an existing stats name. Their requests, tokens, costs, and errors will be combined.</p>
        <div class="form-group">
          <label for="stats-target">Existing destination</label>
          <select id="stats-target" bind:value={destination}>
            <option value="">Select a model</option>
            {#each conjoinTargets as target}<option value={target}>{target}</option>{/each}
          </select>
        </div>
      {:else if dialogMode === "delete-explain"}
        <div class="danger-notice">
          <i class="fa-solid fa-triangle-exclamation" aria-hidden="true"></i>
          <div><strong>This permanently changes analytics.</strong><p>All requests attributed to <strong>{selectedModel}</strong> and their related error records will be removed from the database. Stats totals and ranks will decrease. This cannot be undone.</p></div>
        </div>
        <p>Configured models and live routing are not changed.</p>
      {:else}
        <p>Type <strong>{selectedModel}</strong> to confirm permanent deletion of its historical request data.</p>
        <div class="form-group">
          <label for="delete-confirmation">Model name</label>
          <input id="delete-confirmation" bind:this={renameInput} bind:value={deleteConfirmation} autocomplete="off" spellcheck="false" onkeydown={(event) => { if (event.key === "Enter") void submitMutation(); }} />
        </div>
      {/if}

      {#if operationError}<div class="dialog-error" role="alert">{operationError}</div>{/if}

      <div class="modal-footer">
        <button class="btn btn-secondary" type="button" bind:this={safeInitialButton} onclick={() => closeDialog()} disabled={submitting}>Cancel</button>
        {#if dialogMode === "delete-explain"}
          <button class="btn btn-danger" type="button" onclick={advanceDeleteConfirmation}>Continue</button>
        {:else}
          <button class="btn {dialogMode === 'delete-confirm' ? 'btn-danger' : 'btn-primary'}" type="button" onclick={submitMutation} disabled={!canSubmit || submitting} aria-busy={submitting}>{#if submitting}<span class="button-spinner" aria-hidden="true"></span> Saving…{:else if dialogMode === "rename"}Rename history{:else if dialogMode === "conjoin"}Conjoin history{:else}Permanently delete{/if}</button>
        {/if}
      </div>
    </div>
  </div>
{/if}

<style>
  .models-table-card { overflow: visible; border: 1px solid var(--border-color); border-radius: 10px; background: var(--card-bg); box-shadow: none; }
  .table-header { display: flex; align-items: center; justify-content: space-between; padding: 20px 24px; border-bottom: 1px solid var(--border-color); }
  .table-header h2 { display: flex; align-items: center; gap: 10px; margin: 0; color: var(--text-primary); font: 500 18px/1.2 Georgia, "Times New Roman", serif; }
  .table-header i { color: var(--primary-dark); }
  .table-scroll { overflow-x: auto; overflow-y: visible; }
  table { width: 100%; min-width: 940px; border-collapse: collapse; }
  th { padding: 14px 20px; border-bottom: 1px solid var(--border-color); background: var(--bg-secondary); color: var(--text-secondary); text-align: left; font-size: 12px; font-weight: 700; letter-spacing: .05em; text-transform: uppercase; }
  th.sortable { cursor: pointer; user-select: none; } th.sortable::after { content: " ⇅"; opacity: .3; } th.sorted-asc::after { content: " ↑"; opacity: 1; } th.sorted-desc::after { content: " ↓"; opacity: 1; }
  .rank-column { width: 60px; } .actions-column { width: 56px; }
  td { padding: 16px 20px; border-bottom: 1px solid var(--border-color); color: var(--text-secondary); font-size: 14px; } tbody tr:last-child td { border-bottom: 0; } tbody tr:hover { background: var(--bg-secondary); }
  .rank-badge { display: inline-flex; align-items: center; justify-content: center; width: 32px; height: 32px; border-radius: 50%; font-size: 14px; font-weight: 600; }
  .rank-badge.top-1 { background: linear-gradient(135deg, #ffd700, #ffed4e); color: #000; } .rank-badge.top-2 { background: linear-gradient(135deg, #c0c0c0, #e8e8e8); color: #000; } .rank-badge.top-3 { background: linear-gradient(135deg, #cd7f32, #e8a87c); color: #000; } .rank-badge.other { background: var(--bg-secondary); color: var(--text-secondary); }
  .model-name { color: var(--text-primary); font-size: 14px; font-weight: 600; }
  .metric-value { font: 600 14px monospace; font-variant-numeric: tabular-nums; } .metric-value.requests { color: var(--primary); } .metric-value.tokens { color: var(--success); } .metric-value.errors { color: var(--danger); }
  .total-stats { display: grid; min-width: 110px; gap: 6px; }
  .empty-state { padding: 48px 24px; }
  .actions-cell { position: relative; padding-right: 12px; padding-left: 8px; }
  .stats-actions-menu { position: relative; display: flex; justify-content: flex-end; }
  .more-actions { display: inline-flex; width: 34px; height: 34px; align-items: center; justify-content: center; border: 1px solid var(--border-color); border-radius: 8px; background: var(--card-bg); color: var(--text-secondary); cursor: pointer; }
  .more-actions:hover, .more-actions[aria-expanded="true"] { border-color: var(--primary-alpha-035); background: var(--primary-alpha-012); color: var(--primary); }
  .more-actions:focus-visible { outline: 2px solid var(--primary); outline-offset: 2px; }
  .action-popover { position: fixed; z-index: 1000; display: flex; width: 190px; flex-direction: column; gap: 3px; padding: 6px; border: 1px solid var(--border-color); border-radius: 10px; background: var(--card-bg); box-shadow: 0 12px 30px rgba(0,0,0,.15); }
  .action-popover button { display: flex; width: 100%; align-items: center; gap: 9px; padding: 9px 10px; border: 0; border-radius: 7px; background: transparent; color: var(--text-primary); font: inherit; font-size: 12px; text-align: left; cursor: pointer; }
  .action-popover button:hover { background: var(--gray-100); } .action-popover button:focus-visible { outline: 2px solid var(--primary); outline-offset: -1px; } .action-popover button:disabled { opacity: .5; cursor: not-allowed; }
  .action-popover button i { width: 15px; color: var(--text-secondary); text-align: center; } .action-popover button.danger { margin-top: 3px; border-top: 1px solid var(--border-color); border-radius: 0 0 7px 7px; color: var(--danger); } .action-popover button.danger i { color: var(--danger); }
  .stats-modal { max-width: 540px; }
  .stats-modal > p { color: var(--text-secondary); line-height: 1.6; }
  .stats-modal select { width: 100%; }
  .danger-notice { display: flex; align-items: flex-start; gap: 12px; padding: 14px; border: 1px solid var(--danger-alpha-02); border-radius: 10px; background: var(--danger-alpha-01); color: var(--danger-dark); }
  .danger-notice > i { margin-top: 3px; } .danger-notice p { margin: 5px 0 0; color: var(--text-secondary); line-height: 1.55; }
  .dialog-error { margin-top: 14px; padding: 10px 12px; border: 1px solid var(--danger-alpha-02); border-radius: 8px; background: var(--danger-alpha-01); color: var(--danger-dark); font-size: 13px; }
  @media (max-width: 768px) { th, td { padding: 12px 16px; } .stats-modal { max-width: calc(100vw - 32px); } }
</style>
