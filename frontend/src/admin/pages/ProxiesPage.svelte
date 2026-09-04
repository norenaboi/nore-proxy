<script lang="ts">
  import { onMount } from "svelte";
  import { fade, scale } from "svelte/transition";
  import { requestAdminJson } from "$frontend/lib/api/admin";
  import { motionDuration } from "$frontend/lib/motion";
  import { pageHeaderActions, toast } from "$frontend/lib/stores";

  interface ProxyItem {
    id: string; name: string; type: string; host: string; port: number;
    username: string | null; password: string | null;
  }
  interface EndpointRef { index: number; name?: string; proxyId?: string | null; }

  const typeLabels: Record<string, string> = { http: "HTTP", socks4: "SOCKS4", socks5: "SOCKS5" };

  let proxies = $state<ProxyItem[]>([]);
  let endpoints = $state<EndpointRef[]>([]);
  let loading = $state(true);
  let errorMsg = $state("");

  // Add/Edit modal
  let modalOpen = $state(false);
  let editingId = $state<string | null>(null);
  let fName = $state("");
  let fType = $state("http");
  let fHost = $state("");
  let fPort = $state("");
  let fUsername = $state("");
  let fPassword = $state("");

  // Delete modal
  let deletingId = $state<string | null>(null);

  // Endpoints referencing each proxy, so the list states the blast radius of a
  // delete before the server refuses it.
  const usageByProxy = $derived.by(() => {
    const usage = new Map<string, string[]>();
    for (const endpoint of endpoints) {
      if (!endpoint.proxyId) continue;
      const names = usage.get(endpoint.proxyId) ?? [];
      names.push(endpoint.name || `Endpoint ${endpoint.index}`);
      usage.set(endpoint.proxyId, names);
    }
    return usage;
  });

  async function load() {
    // Usage is advisory; an endpoints failure must not take the page down.
    const endpointsRequest = requestAdminJson<{ endpoints: EndpointRef[] }>("/api/endpoints")
      .then((e) => e.endpoints ?? [])
      .catch(() => [] as EndpointRef[]);
    try {
      const d = await requestAdminJson<{ proxies: ProxyItem[] }>("/api/proxies");
      proxies = d.proxies ?? [];
      endpoints = await endpointsRequest;
    } catch (e) {
      errorMsg = e instanceof Error ? e.message : "Failed to load proxies";
    } finally {
      loading = false;
    }
  }

  function openAdd() {
    editingId = null;
    fName = ""; fType = "http"; fHost = ""; fPort = ""; fUsername = ""; fPassword = "";
    modalOpen = true;
  }

  function openEdit(id: string) {
    const proxy = proxies.find((p) => p.id === id);
    if (!proxy) return;
    editingId = id;
    fName = proxy.name; fType = proxy.type; fHost = proxy.host; fPort = String(proxy.port);
    fUsername = proxy.username ?? "";
    // The masked value round-trips: sending it back unchanged keeps the stored
    // secret, and clearing the field removes the password.
    fPassword = proxy.password ?? "";
    modalOpen = true;
  }

  function closeModal() {
    modalOpen = false;
    editingId = null;
  }

  async function submit() {
    const host = fHost.trim();
    // The port input binds type="number", so Svelte hands back a number (and
    // undefined when cleared) rather than the string the state is typed as.
    const port = Number(String(fPort ?? "").trim());
    if (!host) return toast.show("Please enter a proxy host", "error");
    if (!Number.isInteger(port) || port < 1 || port > 65535) return toast.show("Port must be an integer from 1 to 65535", "error");

    const payload: Record<string, unknown> = {
      name: fName.trim(),
      type: fType,
      host,
      port,
      username: fUsername.trim(),
      password: fPassword,
    };
    if (editingId !== null) payload.id = editingId;

    try {
      await requestAdminJson("/api/proxies", {
        method: editingId !== null ? "PUT" : "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      toast.show(`Proxy ${editingId !== null ? "updated" : "added"} successfully`);
      closeModal();
      await load();
    } catch (e) {
      toast.show(e instanceof Error ? e.message : "Failed", "error");
    }
  }

  async function confirmDelete() {
    if (deletingId === null) return;
    try {
      await requestAdminJson("/api/proxies", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: deletingId }),
      });
      toast.show("Proxy deleted successfully");
      deletingId = null;
      await load();
    } catch (e) {
      toast.show(e instanceof Error ? e.message : "Failed", "error");
    }
  }

  $effect(() => {
    pageHeaderActions.set({ count: proxies.length, noun: "proxy", icon: "fa-solid fa-network-wired", addLabel: "Add Proxy", onAdd: openAdd });
  });

  onMount(() => {
    const onKeydown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      if (deletingId !== null) deletingId = null;
      else if (modalOpen) closeModal();
    };
    document.addEventListener("keydown", onKeydown);
    void load();

    return () => {
      pageHeaderActions.set(null);
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
  <span class="sr-only" role="status">Loading proxies…</span>
{:else if errorMsg}
  <div class="page-error" role="alert">{errorMsg}</div>
{:else if proxies.length === 0}
  <div class="empty-state"><i class="fa-solid fa-network-wired"></i><p>No proxies configured yet</p><button class="btn btn-primary empty-state-action" type="button" onclick={openAdd}>Add Your First Proxy</button></div>
{:else}
  <div class="card proxies-card">
    <div class="card-header"><span class="card-title">Outbound Proxies</span></div>
    <div class="card-body proxies-list">
      {#each proxies as proxy (proxy.id)}
        {@const usedBy = usageByProxy.get(proxy.id) ?? []}
        <div class="model-item proxy-item">
          <div class="model-info">
            <div class="model-icon"><i class="fa-solid fa-network-wired"></i></div>
            <div class="proxy-meta">
              <div class="model-name">
                <span>{proxy.name || proxy.id}</span>
                <span class="proxy-type-badge {proxy.type}"><i class="fa-solid {proxy.type === 'http' ? 'fa-arrow-right-arrow-left' : 'fa-socks'}"></i>{typeLabels[proxy.type] || proxy.type}</span>
                {#if proxy.username}<span class="gen-badge"><i class="fa-solid fa-user"></i>{proxy.username}</span>{/if}
                {#if proxy.password}<span class="gen-badge"><i class="fa-solid fa-lock"></i>{proxy.password}</span>{/if}
                {#if usedBy.length}<span class="gen-badge"><i class="fa-solid fa-link"></i>{usedBy.length} endpoint{usedBy.length !== 1 ? "s" : ""}</span>{/if}
              </div>
              <div class="model-mapping">{proxy.host}:{proxy.port}</div>
              {#if usedBy.length}<div class="proxy-usage">{usedBy.join(", ")}</div>{/if}
            </div>
          </div>
          <div class="model-actions">
            <button class="btn btn-secondary btn-sm" type="button" onclick={() => openEdit(proxy.id)}><i class="fa-solid fa-pen"></i>Edit</button>
            <button class="btn btn-danger btn-sm" type="button" aria-label={`Delete ${proxy.name || proxy.id}`} onclick={() => deletingId = proxy.id}><i class="fa-solid fa-trash"></i></button>
          </div>
        </div>
      {/each}
    </div>
  </div>
{/if}

<!-- Add/Edit modal -->
{#if modalOpen}
  <div class="modal-backdrop active" transition:fade={{ duration: motionDuration(300) }} onclick={(e) => { if (e.target === e.currentTarget) closeModal(); }} role="presentation">
    <div class="modal proxy-modal" transition:scale={{ duration: motionDuration(300), start: 0.9 }} role="dialog" aria-modal="true">
      <div class="modal-header"><h2>{editingId !== null ? "Edit Proxy" : "Add Proxy"}</h2><button class="modal-close" type="button" aria-label="Close proxy editor" onclick={closeModal}><i class="fa-solid fa-xmark"></i></button></div>
      <div class="modal-body">
        <div class="form-group"><label for="pxName">Name</label><input id="pxName" type="text" bind:value={fName} placeholder="e.g., Residential EU" /></div>
        <div class="form-row">
          <div class="form-group"><label for="pxType">Proxy Type</label>
            <select id="pxType" bind:value={fType} class="form-select">
              <option value="http">HTTP</option>
              <option value="socks5">SOCKS5</option>
              <option value="socks4">SOCKS4</option>
            </select>
          </div>
          <div class="form-group"><label for="pxPort">Port</label><input id="pxPort" type="number" min="1" max="65535" bind:value={fPort} placeholder="8080" /></div>
        </div>
        <div class="form-group"><label for="pxHost">Host</label><input id="pxHost" type="text" bind:value={fHost} placeholder="proxy.example.com or 127.0.0.1" /></div>
        <div class="form-group"><label for="pxUser">Username <span class="optional">(optional)</span></label><input id="pxUser" type="text" autocomplete="off" bind:value={fUsername} placeholder="Proxy username" /></div>
        <div class="form-group">
          <label for="pxPassword">Password <span class="optional">(optional)</span></label>
          <input id="pxPassword" type="password" autocomplete="new-password" bind:value={fPassword} placeholder={editingId !== null && fPassword ? "Masked — leave as is to keep, clear to remove" : "Proxy password"} />
          {#if editingId !== null && fPassword}<p class="form-hint">The masked value keeps the stored password. Clear the field to remove it, or type a new one to replace it.</p>{/if}
        </div>
        <p class="form-hint">Endpoints reference a proxy from their editor's "Outbound Proxy" setting; traffic for those endpoints then flows through it.</p>
      </div>
      <div class="modal-footer">
        <button class="btn btn-secondary" type="button" onclick={closeModal}>Cancel</button>
        <button class="btn btn-primary" type="button" onclick={submit}>{editingId !== null ? "Save Changes" : "Add Proxy"}</button>
      </div>
    </div>
  </div>
{/if}

<!-- Delete proxy modal -->
{#if deletingId !== null}
  {@const proxy = proxies.find((p) => p.id === deletingId)}
  {@const usedBy = usageByProxy.get(deletingId) ?? []}
  <div class="modal-backdrop active" transition:fade={{ duration: motionDuration(300) }} onclick={(e) => { if (e.target === e.currentTarget) deletingId = null; }} role="presentation">
    <div class="modal delete-modal" transition:scale={{ duration: motionDuration(300), start: 0.9 }} role="dialog" aria-modal="true">
      <div class="modal-header"><h2>Delete Proxy</h2><button class="modal-close" type="button" onclick={() => deletingId = null}>✕</button></div>
      <div class="modal-body">
        <p>Are you sure you want to delete <strong>{proxy?.name || deletingId}</strong> ({proxy?.host}:{proxy?.port})? This cannot be undone.</p>
        {#if usedBy.length}
          <p class="delete-warning"><i class="fa-solid fa-triangle-exclamation"></i> Still used by {usedBy.length} endpoint{usedBy.length !== 1 ? "s" : ""}: {usedBy.join(", ")}. Reassign or clear those endpoints first.</p>
        {/if}
      </div>
      <div class="modal-footer">
        <button class="btn btn-secondary" type="button" onclick={() => deletingId = null}>Cancel</button>
        <button class="btn btn-danger" type="button" onclick={confirmDelete}>Delete</button>
      </div>
    </div>
  </div>
{/if}

<style>
  .empty-state-action { margin-top: 16px; }
  .proxies-card { overflow: hidden; }
  .card-header { padding: 20px 24px; border-bottom: 1px solid var(--border-color); }
  .card-title { color: var(--text-primary); font-family: Georgia, "Times New Roman", serif; font-size: 16px; font-weight: 500; }
  .card-body { padding: 24px; }
  .proxies-list { display: flex; flex-direction: column; gap: 10px; }
  .model-item { display: flex; align-items: center; justify-content: space-between; padding: 16px 20px; border: 1px solid var(--border-color); border-radius: 8px; background: var(--bg-secondary); transition: border-color .2s ease; }
  .model-item:hover { border-color: var(--primary); }
  .model-info { display: flex; align-items: center; min-width: 0; flex: 1; gap: 12px; }
  .model-icon { display: flex; width: 40px; height: 40px; align-items: center; justify-content: center; flex-shrink: 0; border-radius: 10px; background: var(--gradient-primary); color: white; }
  .proxy-meta { min-width: 0; flex: 1; }
  .model-name { display: flex; align-items: center; flex-wrap: wrap; gap: 6px; color: var(--text-primary); font-weight: 500; }
  .model-mapping { margin-top: 2px; overflow-wrap: anywhere; color: var(--text-secondary); font-size: 12px; font-family: monospace; }
  .proxy-usage { margin-top: 2px; overflow-wrap: anywhere; color: var(--text-secondary); font-size: 11px; }
  .model-actions { display: flex; flex-shrink: 0; gap: 8px; }
  .proxy-type-badge, .gen-badge { display: inline-flex; align-items: center; gap: 4px; padding: 2px 8px; border-radius: 6px; font-family: monospace; font-size: 11px; font-weight: 500; }
  .proxy-type-badge.http { background: var(--primary-alpha-01); color: var(--primary); }
  .proxy-type-badge.socks5, .proxy-type-badge.socks4 { background: rgba(99,102,241,.1); color: #6366f1; }
  .gen-badge { background: var(--gray-100); color: var(--gray-600); }
  .proxy-modal { max-width: 480px; }
  .modal-body { padding: 22px 24px; }
  .form-group { display: flex; flex-direction: column; gap: 8px; margin-bottom: 18px; }
  .form-group label { color: var(--text-secondary); font-size: 11px; font-weight: 700; letter-spacing: .03em; }
  .form-group .optional { font-weight: 400; }
  .form-group input, .form-group select { width: 100%; box-sizing: border-box; padding: 12px 16px; border: 1px solid var(--input-border); border-radius: 8px; background: var(--input-bg); color: var(--text-primary); font: 14px/normal Inter, ui-sans-serif, system-ui, sans-serif; }
  .form-group input:focus, .form-group select:focus { outline: none; border-color: var(--primary); background-color: var(--card-bg); box-shadow: 0 0 0 3px var(--primary-alpha-01); }
  .form-row { display: grid; grid-template-columns: 1fr 130px; gap: 14px; }
  .form-hint { margin: 6px 0 0; color: var(--text-secondary); font-size: 12px; line-height: 1.45; }
  .modal-body > .form-hint { margin: 4px 0 0; }
  .delete-modal { max-width: 460px; }
  .delete-warning { display: flex; align-items: flex-start; gap: 8px; margin: 12px 0 0; color: #b45309; font-size: 13px; line-height: 1.45; }
  @media (max-width: 560px) { .form-row { grid-template-columns: 1fr; } .model-item { align-items: flex-start; flex-direction: column; gap: 12px; } .model-actions { align-self: flex-end; } }
</style>
