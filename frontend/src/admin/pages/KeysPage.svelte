<script lang="ts">
  import { onMount } from "svelte";
  import { requestAdminJson } from "$frontend/lib/api/admin";
  import { toast } from "$frontend/lib/stores";

  interface Key {
    api_key: string; name: string; active: boolean;
    rpd: number; rpm: number; max_context_size: number; usage_today: number;
  }

  interface EditState { name: string; rpd: string; rpm: string; max_context_size: string; active: boolean; }

  let keys = $state<Key[]>([]);
  let loading = $state(true);
  let editingKey = $state<string | null>(null);
  let editState = $state<EditState>({ name: "", rpd: "", rpm: "", max_context_size: "", active: true });
  let deletingKey = $state<Key | null>(null);
  let addName = $state("");
  let addKey = $state("");
  let addLoading = $state(false);

  async function load() {
    try {
      const d = await requestAdminJson<{ keys: Key[] }>("/api/keys");
      keys = d.keys;
    } catch (e) {
      toast.show(e instanceof Error ? e.message : "Failed to load keys", "error");
    } finally {
      loading = false;
    }
  }

  function startEdit(key: Key) {
    editingKey = key.api_key;
    editState = { name: key.name, rpd: String(key.rpd), rpm: String(key.rpm), max_context_size: String(key.max_context_size ?? 0), active: key.active };
  }

  async function saveEdit() {
    if (!editingKey) return;
    try {
      await requestAdminJson("/api/keys", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ api_key: editingKey, name: editState.name, rpd: editState.rpd, rpm: editState.rpm, max_context_size: parseInt(editState.max_context_size, 10) || 0, active: editState.active }),
      });
      toast.show("Key updated successfully");
      editingKey = null;
      await load();
    } catch (e) {
      toast.show(e instanceof Error ? e.message : "Failed to update key", "error");
    }
  }

  async function deleteKey() {
    if (!deletingKey) return;
    try {
      await requestAdminJson("/api/keys", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ api_key: deletingKey.api_key }),
      });
      toast.show("API key deleted successfully");
      deletingKey = null;
      await load();
    } catch (e) {
      toast.show(e instanceof Error ? e.message : "Failed to delete key", "error");
    }
  }

  async function addNewKey() {
    if (!addName.trim() || !addKey.trim()) {
      toast.show("Please enter a name and API key", "error");
      return;
    }
    addLoading = true;
    try {
      await requestAdminJson("/api/keys", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: addName.trim(), api_key: addKey.trim() }),
      });
      toast.show("API key added successfully");
      addName = ""; addKey = "";
      await load();
    } catch (e) {
      toast.show(e instanceof Error ? e.message : "Failed to add key", "error");
    } finally {
      addLoading = false;
    }
  }

  function generateKey() {
    const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
    let key = "sk-";
    for (let i = 0; i < 48; i++) key += chars.charAt(Math.floor(Math.random() * chars.length));
    addKey = key;
  }

  function maskKey(k: string) { return k.substring(0, 10) + "..." + k.substring(k.length - 4); }

  onMount(load);
</script>

<section class="card add-key-card">
  <div class="card-header">
    <h2><i class="fa-solid fa-plus"></i> Add New API Key</h2>
  </div>
  <div class="card-body">
    <div class="add-key-form">
      <div class="form-group">
        <label for="addName">Key Name</label>
        <input id="addName" type="text" bind:value={addName} placeholder="e.g., Production Key" />
      </div>
      <div class="form-group">
        <label for="addKey">API Key</label>
        <input id="addKey" class="key-input" type="text" bind:value={addKey} placeholder="Leave empty to generate" />
      </div>
      <button class="btn btn-secondary" type="button" onclick={generateKey}><i class="fa-solid fa-arrow-rotate-right"></i> Generate</button>
      <button class="btn btn-primary" type="button" onclick={addNewKey} disabled={addLoading}>
        <i class="fa-solid fa-plus"></i> {addLoading ? "Adding…" : "Add Key"}
      </button>
    </div>
  </div>
</section>

<section class="card keys-card">
  <div class="card-header">
    <h2><i class="fa-solid fa-key"></i> Existing API Keys</h2>
    <span class="badge">{keys.length} {keys.length === 1 ? "key" : "keys"}</span>
  </div>
  <div class="keys-table-container">
    {#if loading}
      <div class="loading"><div class="loading-spinner"></div><span>Loading keys…</span></div>
    {:else if keys.length === 0}
      <div class="empty-state"><i class="fa-solid fa-key"></i><p>No API keys found. Add one to get started!</p></div>
    {:else}
      <div class="table-scroll">
        <table class="keys-table">
          <thead><tr><th>Status</th><th>Name</th><th>API Key</th><th>RPD Quota</th><th>RPM Limit</th><th>Max Context</th><th>Actions</th></tr></thead>
          <tbody>
            {#each keys as key (key.api_key)}
              {#if editingKey === key.api_key}
                <tr class="editing-row">
                  <td class="status-cell"><label class="toggle" title="Active"><input type="checkbox" bind:checked={editState.active} /><div class="toggle-track"></div><div class="toggle-thumb"></div></label></td>
                  <td><input class="edit-input" type="text" bind:value={editState.name} /></td>
                  <td><span class="key-display">{maskKey(key.api_key)}</span></td>
                  <td><input class="edit-input numeric-input" type="number" bind:value={editState.rpd} /></td>
                  <td><input class="edit-input numeric-input" type="number" bind:value={editState.rpm} /></td>
                  <td><input class="edit-input context-input" type="number" min="0" bind:value={editState.max_context_size} /></td>
                  <td><div class="actions"><button class="btn btn-success btn-sm" type="button" onclick={saveEdit}>Save</button><button class="btn btn-secondary btn-sm" type="button" onclick={() => editingKey = null}>Cancel</button></div></td>
                </tr>
              {:else}
                <tr>
                  <td class="status-cell"><span class="status-dot" class:inactive={!key.active} title={key.active ? "Active" : "Inactive"}></span></td>
                  <td><span class="name-text">{key.name}</span></td>
                  <td><span class="key-display">{maskKey(key.api_key)}</span></td>
                  <td><span class="metric-value">{key.usage_today}/{key.rpd}</span></td>
                  <td><span class="metric-value">{key.rpm}</span></td>
                  <td><span class="metric-value">{key.max_context_size > 0 ? key.max_context_size.toLocaleString() : "∞"}</span></td>
                  <td><div class="actions"><button class="btn btn-primary btn-sm" type="button" onclick={() => startEdit(key)}>Edit</button><button class="btn btn-danger btn-sm" type="button" onclick={() => deletingKey = key}>Delete</button></div></td>
                </tr>
              {/if}
            {/each}
          </tbody>
        </table>
      </div>
    {/if}
  </div>
</section>

{#if deletingKey}
  <div class="modal-backdrop active" onclick={(e) => { if (e.target === e.currentTarget) deletingKey = null; }} role="presentation">
    <div class="modal delete-modal" role="dialog" aria-modal="true" aria-labelledby="delete-title">
      <div class="modal-header"><h2 id="delete-title">Delete API Key</h2><button class="modal-close" type="button" onclick={() => deletingKey = null}>✕</button></div>
      <div class="modal-body"><p>Are you sure you want to delete <strong>{deletingKey.name}</strong>? This action cannot be undone.</p></div>
      <div class="modal-footer"><button class="btn btn-secondary" type="button" onclick={() => deletingKey = null}>Cancel</button><button class="btn btn-danger" type="button" onclick={deleteKey}>Delete Key</button></div>
    </div>
  </div>
{/if}

<style>
  .card { overflow: hidden; margin-bottom: 18px; border: 1px solid var(--border-color); border-radius: 10px; background: var(--card-bg); box-shadow: none; }
  .card-header { display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 20px 24px; border-bottom: 1px solid var(--border-color); }
  .card-header h2 { display: flex; align-items: center; gap: 10px; margin: 0; color: var(--text-primary); font: 500 18px/1.2 Georgia, "Times New Roman", serif; }
  .card-header h2 i { color: var(--primary-dark); font-size: 17px; }
  .card-body { padding: 24px; }
  .add-key-form { display: grid; grid-template-columns: 1fr 1fr auto auto; gap: 16px; align-items: end; }
  .form-group { display: flex; flex-direction: column; gap: 8px; margin: 0; }
  .form-group label { color: var(--text-secondary); font-size: 11px; font-weight: 700; letter-spacing: .03em; }
  .form-group input { width: 100%; padding: 12px 16px; border: 1px solid var(--input-border); border-radius: 8px; background: var(--input-bg); color: var(--text-primary); font: 14px/1.2 inherit; }
  .key-input { font-family: "Monaco", "Menlo", monospace !important; }
  .keys-table-container { min-height: 100px; }
  .table-scroll { overflow-x: auto; }
  .keys-table { width: 100%; min-width: 900px; table-layout: fixed; border-collapse: collapse; }
  .keys-table th { padding: 14px 20px; border-bottom: 1px solid var(--border-color); background: var(--bg-secondary); color: var(--text-secondary); text-align: left; font-size: 12px; font-weight: 700; letter-spacing: .05em; text-transform: uppercase; }
  .keys-table th:nth-child(1) { width: 7%; } .keys-table th:nth-child(2) { width: 14%; } .keys-table th:nth-child(3) { width: 30%; } .keys-table th:nth-child(4) { width: 10%; } .keys-table th:nth-child(5) { width: 9%; } .keys-table th:nth-child(6) { width: 12%; } .keys-table th:nth-child(7) { width: 18%; }
  .keys-table td { padding: 16px 20px; overflow: hidden; border-bottom: 1px solid var(--border-color); color: var(--text-secondary); font-size: 14px; text-overflow: ellipsis; }
  .keys-table tbody tr:last-child td { border-bottom: 0; } .keys-table tbody tr:hover { background: var(--bg-secondary); }
  .status-cell { text-align: center; }
  .status-dot { display: inline-block; width: 11px; height: 11px; border-radius: 50%; background: var(--success); box-shadow: 0 0 0 3px var(--success-alpha-01); }
  .status-dot.inactive { background: var(--danger); box-shadow: 0 0 0 3px var(--danger-alpha-01); }
  .name-text { color: var(--text-primary); font-weight: 600; }
  .key-display { display: inline-block; max-width: 100%; overflow: hidden; padding: 8px 14px; border: 1px solid var(--border-color); border-radius: 8px; background: var(--bg-secondary); color: var(--text-secondary); font: 12px/1.2 "Monaco", "Menlo", monospace; text-overflow: ellipsis; white-space: nowrap; }
  .metric-value { color: var(--text-primary); font-family: monospace; font-variant-numeric: tabular-nums; font-weight: 600; }
  .actions { display: flex; gap: 8px; white-space: nowrap; }
  .edit-input { width: 100%; padding: 9px 10px; border: 1px solid var(--primary); border-radius: 8px; background: var(--input-bg); color: var(--text-primary); }
  .numeric-input { width: 72px; } .context-input { width: 90px; }
  .badge { padding: 4px 12px; border-radius: 999px; background: var(--primary-light); color: var(--primary-dark); font-size: 12px; font-weight: 600; }
  .loading { min-height: 170px; }
  .empty-state { padding: 60px 24px; }
  .delete-modal { max-width: 420px; }
  .modal-body { padding: 22px 24px; color: var(--text-secondary); line-height: 1.6; }
  .modal-body p { margin: 0; }
  @media (max-width: 1200px) { .add-key-form { grid-template-columns: 1fr 1fr; } }
  @media (max-width: 768px) { .add-key-form { grid-template-columns: 1fr; } .card-header, .card-body { padding-left: 18px; padding-right: 18px; } }
</style>
