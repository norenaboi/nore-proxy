let endpoints = [];
let editingEndpoint = null;
let deletingEndpoint = null;
let keysModalEndpoint = null; // endpoint index currently shown in the keys modal
// pendingTokens holds the current token list being edited in the modal
// Masked tokens (with ****) represent existing server-side tokens the user hasn't replaced.
let pendingTokens = [];
let pendingDeleteConfirm = new Set(); // indices awaiting second-click confirmation

// Load endpoints on page load
document.addEventListener('DOMContentLoaded', () => {
    loadEndpoints();
    // Allow pressing Enter in the token input to add it
    document.getElementById('tokenInput').addEventListener('keydown', (e) => {
        if (e.key === 'Enter') { e.preventDefault(); addTokenFromInput(); }
    });
    // Clicking anywhere outside a confirm-? button cancels the pending confirmation
    document.addEventListener('click', (e) => {
        if (pendingDeleteConfirm.size === 0) return;
        if (e.target.closest('[data-confirm-btn]')) return;
        pendingDeleteConfirm = new Set();
        renderTokenPills();
    });
});

async function loadEndpoints() {
    try {
        const response = await fetch('/api/endpoints', { method: 'GET' });
        if (!response.ok) throw new Error('Failed to load endpoints');
        const data = await response.json();
        endpoints = data.endpoints || [];
        renderEndpoints();
        document.getElementById('loading').style.display = 'none';
        document.getElementById('dashboard').style.display = 'block';
    } catch (error) {
        showError(error.message);
    }
}

function renderEndpoints() {
    const list = document.getElementById('endpointsList');
    const emptyState = document.getElementById('emptyState');
    const countBadge = document.getElementById('endpointCount');

    countBadge.innerHTML = `<i class="fa-solid fa-hexagon-nodes"></i><span>${endpoints.length} endpoint${endpoints.length !== 1 ? 's' : ''}</span>`;

    if (endpoints.length === 0) {
        list.style.display = 'none';
        emptyState.style.display = 'block';
        return;
    }

    list.style.display = 'flex';
    emptyState.style.display = 'none';

    list.innerHTML = endpoints.map((endpoint) => {
        const tokens = endpoint.tokens || [endpoint.token];
        const tokenCount = tokens.length;
        const displayName = escapeHtml(endpoint.name || `Endpoint ${endpoint.index}`);
        const fmt = endpoint.apiFormat || 'openai';
        const fmtLabels = {
            'openai': 'OpenAI',
            'anthropic': 'Anthropic',
            'gemini': 'Gemini',
            'openai-responses': 'OpenAI Responses',
            'openai-codex': 'OpenAI Codex',
        };
        const fmtLabel = fmtLabels[fmt] || fmt;
        const fmtBadge = `<span class="api-format-badge ${escapeHtml(fmt)}"><i class="fa-solid fa-plug"></i>${escapeHtml(fmtLabel)}</span>`;

        const rotation = endpoint.keyRotation || 'sticky';
        const rotationLabel = rotation === 'roundrobin' ? 'Round-robin' : 'Sticky';
        const rotationIcon = rotation === 'roundrobin' ? 'fa-arrows-rotate' : 'fa-thumbtack';
        const rotationBadge = `<span class="gen-badge"><i class="fa-solid ${rotationIcon}"></i>${rotationLabel}</span>`;

        // keyHealth defaults to on when unset (null). Only badge it when explicitly off.
        const healthOff = endpoint.keyHealth === false;
        const healthBadge = healthOff
            ? `<span class="gen-badge" style="background:rgba(220,38,38,0.1);color:#dc2626;"><i class="fa-solid fa-heart-crack"></i>Health off</span>`
            : '';

        const genDefaults = endpoint.generationDefaults || {};
        const genBadges = [];
        if (genDefaults.temperature?.enabled && genDefaults.temperature.value !== null) {
            genBadges.push(`<span class="gen-badge"><i class="fa-solid fa-temperature-half"></i>T=${genDefaults.temperature.value}</span>`);
        }
        if (genDefaults.top_p?.enabled && genDefaults.top_p.value !== null) {
            genBadges.push(`<span class="gen-badge"><i class="fa-solid fa-chart-pie"></i>P=${genDefaults.top_p.value}</span>`);
        }
        if (genDefaults.max_tokens?.enabled && genDefaults.max_tokens.value !== null) {
            genBadges.push(`<span class="gen-badge"><i class="fa-solid fa-stopwatch"></i>Max=${genDefaults.max_tokens.value}</span>`);
        }
        const caching = endpoint.promptCaching;
        if (caching?.enabled) {
            genBadges.push(`<span class="gen-badge" style="background:rgba(217,119,6,0.1);color:#d97706;"><i class="fa-solid fa-bolt"></i>Cache=${caching.depth}</span>`);
        }
        if (Object.keys(endpoint.headers).length !== 0) {
            genBadges.push(`<span class="gen-badge"><i class="fa-solid fa-code"></i>${Object.keys(endpoint.headers).length} custom header${Object.keys(endpoint.headers).length !== 1 ? 's' : ''}`);
        }

        const allBadges = [rotationBadge, healthBadge, ...genBadges].filter(Boolean);
        const genBadgesHtml = `<div style="margin-top:4px;">${allBadges.join('')}</div>`;

        return `
            <div class="model-item">
                <div class="model-info">
                    <div class="model-icon">
                        <i class="fa-solid fa-server"></i>
                    </div>
                    <div style="flex-direction: row; display: flex;">
                        <div>
                          <div class="model-name">${displayName} ${fmtBadge} ${allBadges.join('')}</div>
                          <div class="model-mapping">${escapeHtml(endpoint.url)}</div>
                        </div>
                    </div>
                </div>
                <div class="model-actions">
                    <button class="btn btn-secondary btn-sm" onclick="openKeysModal(${endpoint.index})">
                        <i class="fa-solid fa-key"></i>
                        ${tokenCount} Keys
                    </button>
                    <button class="btn btn-secondary btn-sm" onclick="openEditModal(${endpoint.index})">
                        <i class="fa-solid fa-pen"></i>
                        Edit
                    </button>
                    <button class="btn btn-danger btn-sm" onclick="openDeleteModal(${endpoint.index})">
                        <i class="fa-solid fa-trash"></i>
                    </button>
                </div>
            </div>
        `;
    }).join('');
}

// --- Token pill management ---

function renderTokenPills() {
    const list = document.getElementById('tokensList');
    const badge = document.getElementById('tokenCountBadge');
    badge.textContent = pendingTokens.length > 0 ? `(${pendingTokens.length})` : '';

    if (pendingTokens.length === 0) {
        list.innerHTML = '<span style="color:var(--gray-400);font-size:13px;padding:4px;">No tokens added yet</span>';
        return;
    }

    list.innerHTML = pendingTokens.map((tok, idx) => {
        const isMasked = tok.includes('****');
        const display = isMasked ? tok : (tok.length > 20 ? tok.substring(0, 8) + '...' + tok.substring(tok.length - 6) : tok);
        const confirming = pendingDeleteConfirm.has(idx);
        const deleteBtn = confirming
            ? `<button type="button" data-confirm-btn="${idx}" onclick="removeToken(${idx})" style="background:#d97706;border:none;cursor:pointer;padding:4px 10px;line-height:1.4;color:#fff;border-radius:6px;font-size:13px;font-weight:700;font-family:inherit;transition:background 0.15s;flex-shrink:0;" title="Click again to confirm delete">?</button>`
            : `<button type="button" data-confirm-btn="${idx}" onclick="requestRemoveToken(${idx})" style="background:var(--gray-200);border:none;cursor:pointer;padding:4px 8px;line-height:1.4;color:var(--gray-500);border-radius:6px;font-size:13px;flex-shrink:0;transition:background 0.15s,color 0.15s;" title="Remove token" onmouseover="this.style.background='var(--danger)';this.style.color='#fff'" onmouseout="this.style.background='var(--gray-200)';this.style.color='var(--gray-500)'"><i class="fa-solid fa-xmark"></i></button>`;
        return `
            <span style="display:flex;align-items:center;gap:8px;padding:6px 12px;background:var(--gray-100);border:1px solid var(--gray-200);border-radius:10px;font-size:13px;font-family:monospace;color:var(--gray-700);width:100%;box-sizing:border-box;">
                <span style="flex:1;display:flex;align-items:center;gap:6px;min-width:0;">
                    ${isMasked ? '<i class="fa-solid fa-lock" style="color:var(--gray-400);font-size:10px;flex-shrink:0;"></i>' : ''}
                    <span style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${escapeHtml(display)}</span>
                </span>
                ${deleteBtn}
            </span>
        `;
    }).join('');
}

function requestRemoveToken(idx) {
    pendingDeleteConfirm.add(idx);
    renderTokenPills();
}

// Mask a raw token the same way the server does (first4 + **** + last4),
// so a freshly typed key can be matched against existing masked pills.
function maskTokenLikeServer(tok) {
    return tok.length > 8
        ? tok.substring(0, 4) + '****' + tok.substring(tok.length - 4)
        : '****';
}

// A raw value is a duplicate if it exactly matches a pending token, or if
// it masks to the same form as an existing masked (server-side) token.
function isDuplicateToken(val, list = pendingTokens) {
    if (list.includes(val)) return true;
    const masked = maskTokenLikeServer(val);
    return list.some((t) => t.includes('****') && t === masked);
}

function addTokenFromInput() {
    const input = document.getElementById('tokenInput');
    const val = input.value.trim();
    if (!val) return;
    if (val.includes('****')) {
        showToast('Cannot add a masked token placeholder', 'error');
        return;
    }
    if (isDuplicateToken(val)) {
        showToast('That token is already added', 'error');
        return;
    }
    pendingTokens = [...pendingTokens, val];
    input.value = '';
    pendingDeleteConfirm.clear();
    renderTokenPills();
}

function importBulkTokens() {
    const textarea = document.getElementById('bulkTokenInput');
    const lines = textarea.value.split('\n');
    const running = [...pendingTokens];
    const toAdd = [];
    let skipped = 0;
    for (const line of lines) {
        const val = line.trim();
        if (!val) continue;
        if (val.includes('****') || isDuplicateToken(val, running)) { skipped++; continue; }
        running.push(val);
        toAdd.push(val);
    }
    if (toAdd.length === 0) {
        showToast(skipped > 0 ? 'No new tokens to import' : 'Nothing to import', 'error');
        return;
    }
    pendingTokens = [...pendingTokens, ...toAdd];
    textarea.value = '';
    pendingDeleteConfirm.clear();
    renderTokenPills();
    showToast(`Imported ${toAdd.length} token${toAdd.length !== 1 ? 's' : ''}${skipped > 0 ? ` (${skipped} skipped)` : ''}`, 'success');
}

function removeToken(idx) {
    pendingDeleteConfirm.delete(idx);
    // Remap any confirm indices that shifted due to removal
    const shifted = new Set();
    pendingDeleteConfirm.forEach(i => { if (i > idx) shifted.add(i - 1); else shifted.add(i); });
    pendingDeleteConfirm = shifted;
    pendingTokens = pendingTokens.filter((_, i) => i !== idx);
    renderTokenPills();
}

// --- Modal open/close ---

async function openAddModal() {
    editingEndpoint = null;
    pendingTokens = [];
    pendingDeleteConfirm = new Set();
    document.getElementById('modalTitle').textContent = 'Add Endpoint';
    document.getElementById('modalSubmit').textContent = 'Add Endpoint';
    document.getElementById('nameInput').value = '';
    document.getElementById('urlInput').value = '';
    document.getElementById('appendApiSuffixInput').checked = true;
    document.getElementById('tokenInput').value = '';
    document.getElementById('bulkTokenInput').value = '';
    document.getElementById('tokenInput').placeholder = 'Paste a token and press Add';
    document.getElementById('tokenHint').textContent = 'Add one or more tokens. Requests will be round-robined across all tokens.';
    document.getElementById('headersInput').value = '';
    resetPromptCaching();

    // Apply configured defaults for new endpoints only
    let defaults;
    try {
        const res = await fetch('/api/settings');
        if (res.ok) {
            const data = await res.json();
            defaults = data.settings;
        }
    } catch (err) {
        console.error('Failed to load endpoint defaults:', err);
    }

    document.getElementById('apiFormatInput').value = defaults?.defaultEndpointApiFormat || 'openai';
    document.getElementById('keyRotationInput').value = defaults?.defaultEndpointKeyRotation || 'sticky';
    document.getElementById('keyHealthInput').value = (defaults?.defaultEndpointKeyHealth === false) ? 'false' : 'true';
    if (defaults) {
        setGenerationDefaults({
            temperature: { enabled: defaults.defaultEndpointTemperatureEnabled, value: defaults.defaultEndpointTemperature },
            top_p: { enabled: defaults.defaultEndpointTopPEnabled, value: defaults.defaultEndpointTopP },
            max_tokens: { enabled: defaults.defaultEndpointMaxTokensEnabled, value: defaults.defaultEndpointMaxTokens },
        });
        setPromptCaching({
            enabled: defaults.defaultEndpointPromptCachingEnabled,
            depth: defaults.defaultEndpointPromptCachingDepth,
        });
    } else {
        resetGenerationDefaults();
        resetPromptCaching();
    }

    renderTokenPills();
    document.getElementById('endpointModal').classList.add('active');
}

function openEditModal(index) {
    const endpoint = endpoints.find(e => e.index === index);
    if (!endpoint) return;

    editingEndpoint = index;
    // Seed with masked existing tokens so they show in the pills
    pendingTokens = [...(endpoint.tokens || [endpoint.token])];
    pendingDeleteConfirm = new Set();

    document.getElementById('modalTitle').textContent = 'Edit Endpoint';
    document.getElementById('modalSubmit').textContent = 'Save Changes';
    document.getElementById('nameInput').value = endpoint.name || '';
    document.getElementById('urlInput').value = endpoint.url;
    document.getElementById('appendApiSuffixInput').checked = endpoint.appendApiSuffix !== false;
    document.getElementById('tokenInput').value = '';
    document.getElementById('bulkTokenInput').value = '';
    document.getElementById('tokenInput').placeholder = 'Add a new token (optional)';
    const headersObj = endpoint.headers || {};
    document.getElementById('headersInput').value = Object.keys(headersObj).length > 0 ? JSON.stringify(headersObj, null, 2) : '';
    document.getElementById('apiFormatInput').value = endpoint.apiFormat || 'openai';
    document.getElementById('keyRotationInput').value = endpoint.keyRotation || 'sticky';
    document.getElementById('keyHealthInput').value = endpoint.keyHealth === false ? 'false' : 'true';
    setGenerationDefaults(endpoint.generationDefaults || {});
    setPromptCaching(endpoint.promptCaching || { enabled: false, depth: 2 });
    renderTokenPills();
    document.getElementById('endpointModal').classList.add('active');
}

function closeModal() {
    document.getElementById('endpointModal').classList.remove('active');
    editingEndpoint = null;
    pendingTokens = [];
    pendingDeleteConfirm = new Set();
    resetPromptCaching();
}

function openDeleteModal(index) {
    deletingEndpoint = index;
    const endpoint = endpoints.find(e => e.index === index);
    const displayName = endpoint && endpoint.name ? endpoint.name : `Endpoint ${index}`;
    document.getElementById('deleteEndpointName').textContent = displayName;
    document.getElementById('deleteModal').classList.add('active');
}

function closeDeleteModal() {
    document.getElementById('deleteModal').classList.remove('active');
    deletingEndpoint = null;
}

// --- Key health modal ---

function openKeysModal(index) {
    keysModalEndpoint = index;
    const endpoint = endpoints.find(e => e.index === index);
    const name = endpoint && endpoint.name ? endpoint.name : `Endpoint ${index}`;
    document.getElementById('keysModalTitle').textContent = `Key Health — ${name}`;
    document.getElementById('keysList').innerHTML =
        '<div class="loading" style="padding:40px;"><div class="loading-spinner"></div><span>Loading keys...</span></div>';
    document.getElementById('keysModal').classList.add('active');
    loadKeyStates(index);
}

function closeKeysModal() {
    document.getElementById('keysModal').classList.remove('active');
    keysModalEndpoint = null;
}

async function loadKeyStates(index) {
    try {
        const res = await fetch(`/api/endpoints/${index}/keys`);
        if (!res.ok) {
            const data = await res.json().catch(() => ({}));
            throw new Error(data.error || `Failed to load keys (HTTP ${res.status})`);
        }
        const data = await res.json();
        renderKeyStates(data.keys || []);
    } catch (error) {
        document.getElementById('keysList').innerHTML =
            `<div class="empty-state" style="padding:32px;"><p>${escapeHtml(error.message)}</p></div>`;
    }
}

function renderKeyStates(keys) {
    const list = document.getElementById('keysList');
    if (keys.length === 0) {
        list.innerHTML = '<div class="empty-state" style="padding:32px;"><p>No keys configured for this endpoint.</p></div>';
        return;
    }

    list.innerHTML = keys.map((k) => {
        const status = k.status || 'active';
        const statusLabels = { active: 'Active', invalid: 'Invalid', timeout: 'Timed out', disabled: 'Disabled' };
        const statusIcons = { active: 'fa-circle-check', invalid: 'fa-circle-xmark', timeout: 'fa-clock', disabled: 'fa-ban' };
        let statusText = statusLabels[status] || status;
        if (status === 'timeout' && k.disabledUntil) {
            const mins = Math.max(0, Math.round((k.disabledUntil - Date.now()) / 60000));
            statusText = `Timed out (${mins}m left)`;
        }
        const statusPill = `<span class="key-status-pill ${escapeHtml(status)}"><i class="fa-solid ${statusIcons[status] || 'fa-circle'}"></i>${escapeHtml(statusText)}</span>`;

        const total = k.totalRequests || 0;
        const failed = k.failedRequests || 0;
        const rate = total > 0 ? Math.round((failed / total) * 100) : 0;
        const stats = [
            `<span class="gen-badge"><i class="fa-solid fa-paper-plane"></i>${total} req</span>`,
            `<span class="gen-badge"><i class="fa-solid fa-circle-exclamation"></i>${failed} fail (${rate}%)</span>`,
        ];
        const codeCounts = k.codeCounts || {};
        for (const code of Object.keys(codeCounts).sort()) {
            stats.push(`<span class="gen-badge" style="background:rgba(217,119,6,0.1);color:#d97706;">${escapeHtml(code)}×${codeCounts[code]}</span>`);
        }

        const canReset = status !== 'active';
        const hash = escapeHtml(k.tokenHash || '');
        const toggleBtn = canReset
            ? `<button class="btn btn-secondary btn-sm" onclick="resetKey('${hash}')" title="Re-enable this key"><i class="fa-solid fa-rotate-left"></i></button>`
            : `<button class="btn btn-secondary btn-sm" onclick="disableKey('${hash}')" title="Disable this key"><i class="fa-solid fa-ban"></i></button>`;
        return `
            <div class="key-state-item">
                <div class="key-state-main">
                    <div style="display:flex;align-items:center;gap:10px;">
                        <span class="key-state-code">${escapeHtml(k.maskedKey || 'unknown')}</span>
                        ${statusPill}
                    </div>
                    <div class="key-state-stats">${stats.join('')}</div>
                </div>
                <div class="key-state-actions">
                    ${toggleBtn}
                    <button class="btn btn-secondary btn-sm" onclick="resetKeyStats('${hash}')" title="Reset stats for this key"><i class="fa-solid fa-eraser"></i></button>
                </div>
            </div>
        `;
    }).join('');
}

async function resetKey(tokenHash) {
    if (keysModalEndpoint === null) return;
    await postKeyAction(`/api/endpoints/${keysModalEndpoint}/keys/reset`, { tokenHash }, 'Key re-enabled');
}

async function disableKey(tokenHash) {
    if (keysModalEndpoint === null) return;
    await postKeyAction(`/api/endpoints/${keysModalEndpoint}/keys/disable`, { tokenHash }, 'Key disabled');
}

async function resetKeyStats(tokenHash) {
    if (keysModalEndpoint === null) return;
    await postKeyAction(`/api/endpoints/${keysModalEndpoint}/keys/reset-stats`, { tokenHash }, 'Stats reset');
}

async function resetAllKeys(stats) {
    if (keysModalEndpoint === null) return;
    const path = stats ? 'reset-stats' : 'reset';
    const msg = stats ? 'All stats reset' : 'All keys re-enabled';
    await postKeyAction(`/api/endpoints/${keysModalEndpoint}/keys/${path}`, { all: true }, msg);
}

async function postKeyAction(url, body, successMsg) {
    try {
        const res = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
        });
        if (!res.ok) {
            const data = await res.json().catch(() => ({}));
            throw new Error(data.error || `Request failed (HTTP ${res.status})`);
        }
        showToast(successMsg, 'success');
        if (keysModalEndpoint !== null) loadKeyStates(keysModalEndpoint);
    } catch (error) {
        showToast(error.message, 'error');
    }
}

// --- Submit ---

async function submitEndpoint() {
    const name = document.getElementById('nameInput').value.trim();
    const url = document.getElementById('urlInput').value.trim();
    const headersRaw = document.getElementById('headersInput').value.trim();
    const apiFormat = document.getElementById('apiFormatInput').value;
    const appendApiSuffix = document.getElementById('appendApiSuffixInput').checked;
    const keyRotation = document.getElementById('keyRotationInput').value;
    const keyHealth = document.getElementById('keyHealthInput').value === 'true';
    const generationDefaults = collectGenerationDefaults();
    const promptCaching = collectPromptCaching();

    // Flush any unsaved text in the token input field
    const pendingInput = document.getElementById('tokenInput').value.trim();
    let finalTokens = [...pendingTokens];
    if (pendingInput && !pendingInput.includes('****') && !isDuplicateToken(pendingInput, finalTokens)) {
        finalTokens = [...finalTokens, pendingInput];
    }

    // Flush any unsaved lines left in the bulk import textarea
    const bulkRaw = document.getElementById('bulkTokenInput').value;
    if (bulkRaw.trim()) {
        for (const line of bulkRaw.split('\n')) {
            const val = line.trim();
            if (!val || val.includes('****') || isDuplicateToken(val, finalTokens)) continue;
            finalTokens.push(val);
        }
    }

    if (!url) {
        showToast('Please enter a URL', 'error');
        return;
    }

    // On add: require at least one non-masked token
    // On edit: allow keeping existing masked tokens (server retains them)
    const hasRealToken = finalTokens.some(t => !t.includes('****'));
    const hasMaskedToken = finalTokens.some(t => t.includes('****'));

    if (finalTokens.length === 0) {
        showToast('Please add at least one API token', 'error');
        return;
    }

    if (!editingEndpoint && !hasRealToken) {
        showToast('Please add at least one API token', 'error');
        return;
    }

    let headers = {};
    if (headersRaw) {
        let parsed;
        try {
            parsed = JSON.parse(headersRaw);
        } catch (_) {
            showToast('Invalid JSON in custom headers', 'error');
            return;
        }
        if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
            showToast('Custom headers must be a JSON object', 'error');
            return;
        }
        headers = parsed;
    }

    try {
        if (editingEndpoint) {
            // Split into real (new) tokens and masked (existing) ones.
            // server will replace only if new tokens are provided.
            // We send the full array; server uses non-masked ones as replacements,
            // masked ones signal "keep existing" only when ALL tokens are masked.
            const payload = { index: editingEndpoint, name, url, tokens: finalTokens, headers, apiFormat, appendApiSuffix, keyRotation, keyHealth, generationDefaults, promptCaching };

            const response = await fetch('/api/endpoints', {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload),
            });

            if (!response.ok) {
                const data = await response.json();
                throw new Error(data.error || 'Failed to update endpoint');
            }

            showToast('Endpoint updated successfully', 'success');
        } else {
            const response = await fetch('/api/endpoints', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ name, url, tokens: finalTokens, headers, apiFormat, appendApiSuffix, keyRotation, keyHealth, generationDefaults, promptCaching }),
            });

            if (!response.ok) {
                const data = await response.json();
                throw new Error(data.error || 'Failed to add endpoint');
            }

            showToast('Endpoint added successfully', 'success');
        }

        closeModal();
        loadEndpoints();
    } catch (error) {
        showToast(error.message, 'error');
    }
}

async function confirmDelete() {
    if (!deletingEndpoint) return;

    try {
        const response = await fetch('/api/endpoints', {
            method: 'DELETE',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ index: deletingEndpoint })
        });

        if (!response.ok) {
            const data = await response.json();
            throw new Error(data.error || 'Failed to delete endpoint');
        }

        showToast('Endpoint deleted successfully', 'success');
        closeDeleteModal();
        loadEndpoints();
    } catch (error) {
        showToast(error.message, 'error');
    }
}

function showError(message) {
    document.getElementById('loading').style.display = 'none';
    document.getElementById('error').style.display = 'flex';
    document.getElementById('errorText').textContent = message;
}

// --- Generation defaults helpers ---

function updateGenInputState(param) {
    const enabled = document.getElementById(`${param}Enabled`).checked;
    const input = document.getElementById(`${param}Value`);
    if (enabled) {
        input.classList.add('active');
    } else {
        input.classList.remove('active');
    }
}

function resetGenerationDefaults() {
    for (const param of ['temperature', 'topP', 'maxTokens']) {
        const key = param === 'topP' ? 'top_p' : (param === 'maxTokens' ? 'max_tokens' : 'temperature');
        document.getElementById(`${param}Enabled`).checked = false;
        document.getElementById(`${param}Value`).value = '';
        updateGenInputState(param);
    }
}

function setGenerationDefaults(defaults) {
    const map = {
        temperature: 'temperature',
        top_p: 'topP',
        max_tokens: 'maxTokens',
    };
    for (const [key, id] of Object.entries(map)) {
        const entry = defaults[key] || { enabled: false, value: null };
        document.getElementById(`${id}Enabled`).checked = entry.enabled === true;
        document.getElementById(`${id}Value`).value = entry.value !== null && entry.value !== undefined ? entry.value : '';
        updateGenInputState(id);
    }
}

function collectGenerationDefaults() {
    const map = {
        temperature: 'temperature',
        top_p: 'topP',
        max_tokens: 'maxTokens',
    };
    const defaults = {};
    for (const [key, id] of Object.entries(map)) {
        const enabled = document.getElementById(`${id}Enabled`).checked;
        const rawValue = document.getElementById(`${id}Value`).value.trim();
        const value = enabled && rawValue !== '' ? Number(rawValue) : null;
        defaults[key] = { enabled, value };
    }
    return defaults;
}

// Wire toggle -> input enable/disable
for (const id of ['temperature', 'topP', 'maxTokens']) {
    document.getElementById(`${id}Enabled`).addEventListener('change', () => updateGenInputState(id));
}
document.getElementById('promptCachingEnabled').addEventListener('change', () => {
    const enabled = document.getElementById('promptCachingEnabled').checked;
    const input = document.getElementById('promptCachingDepth');
    input.disabled = !enabled;
    input.classList.toggle('active', enabled);
    if (enabled) input.focus();
});

function resetPromptCaching() {
    document.getElementById('promptCachingEnabled').checked = false;
    document.getElementById('promptCachingDepth').value = '';
    document.getElementById('promptCachingDepth').disabled = true;
    document.getElementById('promptCachingDepth').classList.remove('active');
}

function setPromptCaching(caching) {
    const entry = caching || { enabled: false, depth: null };
    const enabled = entry.enabled === true;
    document.getElementById('promptCachingEnabled').checked = enabled;
    document.getElementById('promptCachingDepth').value = (entry.depth !== null && entry.depth !== undefined) ? entry.depth : '';
    document.getElementById('promptCachingDepth').disabled = !enabled;
    document.getElementById('promptCachingDepth').classList.toggle('active', enabled);
}

function collectPromptCaching() {
    const enabled = document.getElementById('promptCachingEnabled').checked;
    const rawDepth = document.getElementById('promptCachingDepth').value.trim();
    const depth = (enabled && rawDepth !== '') ? Math.max(0, Math.floor(Number(rawDepth))) : 0;
    return { enabled, depth };
}
