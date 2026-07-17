let models = [];
let endpoints = {};  // version -> { name, ... }
let editingModel = null;
let deletingModel = null;
const modelTestResults = new Map(); // model name -> { ok, latency_ms, error }
let availableModels = []; // models manually fetched from the selected endpoint's /v1/models
let upstreamModelsFetched = false;

// Load models on page load
document.addEventListener('DOMContentLoaded', () => {
    loadModels();
    // When a public model is selected from the dropdown, pre-fill the backend input
    document.getElementById('backendSelect').addEventListener('change', (e) => {
        if (e.target.value) {
            document.getElementById('backendInput').value = e.target.value;
        }
    });
    // Changing endpoints clears any list fetched for the previous endpoint.
    document.getElementById('versionSelect').addEventListener('change', () => {
        availableModels = [];
        upstreamModelsFetched = false;
        populateBackendSelect();
    });
});

async function loadModels() {
    try {
        const [modelsRes, endpointsRes] = await Promise.all([
            fetch('/api/models'),
            fetch('/api/endpoints')
        ]);

        if (!modelsRes.ok) throw new Error('Failed to load models');

        const data = await modelsRes.json();
        models = data.models || [];

        // Build endpoints map: version -> endpoint info
        if (endpointsRes.ok) {
            const epData = await endpointsRes.json();
            // API returns { endpoints: [ {index, name, url, ...} ] }
            const epList = epData.endpoints || [];
            epList.forEach(ep => {
                const ver = `v${ep.index}`;
                endpoints[ver] = { version: ver, ...ep };
            });
        }

        renderModels();

        document.getElementById('loading').style.display = 'none';
        document.getElementById('dashboard').style.display = 'block';
    } catch (error) {
        showError(error.message);
    }
}

function renderModels() {
    const list = document.getElementById('modelsList');
    const emptyState = document.getElementById('emptyState');
    const countBadge = document.getElementById('modelCount');

    countBadge.innerHTML = `<i class="fa-solid fa-cube"></i><span>${models.length} model${models.length !== 1 ? 's' : ''}</span>`;

    if (models.length === 0) {
        list.style.display = 'none';
        emptyState.style.display = 'block';
        return;
    }

    list.style.display = 'flex';
    emptyState.style.display = 'none';

    const fmt = (v) => (v != null && v !== '') ? `$${parseFloat(v).toFixed(2)}` : '$0.00';

    // Group models by version
    const groups = {};
    const noVersionKey = '__none__';
    for (const model of models) {
        const key = model.version || noVersionKey;
        if (!groups[key]) groups[key] = [];
        groups[key].push(model);
    }

    // Natural-sort models within each group by name
    function naturalSort(a, b) {
        return a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' });
    }
    for (const key of Object.keys(groups)) {
        groups[key].sort(naturalSort);
    }

    // Sort groups: versioned keys (v1, v2 ...) in numeric order, then __none__ last
    const sortedVersions = Object.keys(groups).sort((a, b) => {
        if (a === noVersionKey) return 1;
        if (b === noVersionKey) return -1;
        const numA = parseInt(a.replace(/\D/g, ''), 10) || 0;
        const numB = parseInt(b.replace(/\D/g, ''), 10) || 0;
        return numA - numB;
    });

    list.innerHTML = sortedVersions.map(ver => {
        const groupModels = groups[ver];
        const ep = endpoints[ver];
        const epName = ep ? ep.name : 'Unknown Endpoint';
        const verLabel = ver !== noVersionKey ? ver : '';

        const modelsHtml = groupModels.map(model => {
            const safeModelName = JSON.stringify(model.name).replace(/"/g, '&quot;');
            const p = model.pricing || {};

            const pricingHtml = `
                <div class="model-pricing">
                    <span class="pricing-chip"><span class="chip-label">in</span><span class="chip-val">${fmt(p.input)}</span></span>
                    <span class="pricing-chip"><span class="chip-label">out</span><span class="chip-val">${fmt(p.output)}</span></span>
                    <span class="pricing-chip"><span class="chip-label">cw</span><span class="chip-val">${fmt(p.cache_write)}</span></span>
                    <span class="pricing-chip"><span class="chip-label">cr</span><span class="chip-val">${fmt(p.cache_read)}</span></span>
                </div>`;

            return `
                <div class="model-item${model.disabled ? ' disabled-model' : ''}">
                    <div class="model-info">
                        <div class="model-icon"><i class="fa-solid fa-microchip"></i></div>
                        <div class="model-meta">
                            <div class="model-meta-row">
                                <span class="model-name">${escapeHtml(model.name)}</span>
                                ${model.disabled ? '<span class="model-badge" style="background:var(--warning);color:white;opacity:0.8;">disabled</span>' : ''}
                                ${model.backend && model.backend !== model.name ? `<span class="model-badge model-badge-backend">${escapeHtml(model.backend)}</span>` : ''}
                            </div>
                            ${pricingHtml}
                        </div>
                    </div>
                    <div class="model-actions">
                        ${(() => { const r = modelTestResults.get(model.name); return r ? `<span class="test-result-badge ${r.ok ? 'ok' : 'fail'}">${r.ok ? `<i class="fa-solid fa-check"></i> ${r.latency_ms}ms` : '<i class="fa-solid fa-xmark"></i> fail'}</span>` : ''; })()}
                        <button class="btn btn-test btn-sm" onclick="testModel(${safeModelName}, this)" title="Test model (silent — not logged)">
                            <i class="fa-solid fa-flask"></i>
                        </button>
                        <button class="btn btn-sm ${model.disabled ? 'btn-warning' : 'btn-success'}" onclick="toggleModel(${safeModelName})" title="${model.disabled ? 'Enable model' : 'Disable model'}">
                            <i class="fa-solid fa-${model.disabled ? 'pause' : 'play'}"></i>
                        </button>
                        <button class="btn btn-secondary btn-sm" onclick="openEditModal(${safeModelName})">
                            <i class="fa-solid fa-pen"></i> Edit
                        </button>
                        <button class="btn btn-danger btn-sm" onclick="openDeleteModal(${safeModelName})">
                            <i class="fa-solid fa-trash"></i>
                        </button>
                    </div>
                </div>`;
        }).join('');

        return `
            <div class="endpoint-group">
                <div class="endpoint-group-header">
                    <div class="endpoint-icon"><i class="fa-solid fa-hexagon-nodes"></i></div>
                    <span class="endpoint-name">${escapeHtml(epName)}</span>
                    <span class="endpoint-count">${groupModels.length} model${groupModels.length !== 1 ? 's' : ''}</span>
                </div>
                <div class="endpoint-group-divider"></div>
                <div class="endpoint-group-models">
                    ${modelsHtml}
                </div>
            </div>`;
    }).join('');
}

function populateVersionSelect(selectedVersion = '') {
    const select = document.getElementById('versionSelect');
    const versions = Object.keys(endpoints).sort((a, b) => {
        const numA = parseInt(a.replace(/\D/g, ''), 10) || 0;
        const numB = parseInt(b.replace(/\D/g, ''), 10) || 0;
        return numA - numB;
    });

    select.innerHTML = '<option value="">Select an endpoint</option>' +
        versions.map(ver => {
            const ep = endpoints[ver];
            const label = ep ? `${ep.name}` : ver;
            return `<option value="${escapeHtml(ver)}" ${ver === selectedVersion ? 'selected' : ''}>${escapeHtml(label)}</option>`;
        }).join('');
}

function populateBackendSelect(selectedBackend = '') {
    const select = document.getElementById('backendSelect');
    const version = document.getElementById('versionSelect').value;
    if (!version) {
        select.innerHTML = '<option value="">Please select an endpoint first</option>';
        return;
    }
    if (!upstreamModelsFetched) {
        select.innerHTML = '<option value="">Click Fetch to load models</option>';
        return;
    }
    if (availableModels.length === 0) {
        select.innerHTML = '<option value="">No models returned by endpoint</option>';
        return;
    }
    select.innerHTML = '<option value="">Select a model</option>' +
        availableModels.map(name => `<option value="${escapeHtml(name)}" ${name === selectedBackend ? 'selected' : ''}>${escapeHtml(name)}</option>`).join('');
}

async function fetchUpstreamModels(version) {
    const res = await fetch(`/api/endpoints/${version}/models`);
    if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || `Failed to fetch models from the endpoint`);
    }
    const data = await res.json();
    availableModels = (data.models || [])
        .filter(m => typeof m === 'string' && m.length > 0)
        .sort((a, b) => a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' }));
    upstreamModelsFetched = true;
}

async function fetchModelsManually(button) {
    const version = document.getElementById('versionSelect').value;
    if (!version) {
        showToast('Please select an endpoint first', 'error');
        return;
    }

    const currentBackend = document.getElementById('backendInput').value.trim();
    const endpointSelect = document.getElementById('versionSelect');
    const originalContent = button.innerHTML;
    button.disabled = true;
    endpointSelect.disabled = true;
    button.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Fetching';

    try {
        await fetchUpstreamModels(version);
        populateBackendSelect(currentBackend);
        showToast(`Fetched ${availableModels.length} model${availableModels.length !== 1 ? 's' : ''}`, 'success');
    } catch (error) {
        console.error('fetchUpstreamModels error:', error);
        availableModels = [];
        upstreamModelsFetched = false;
        populateBackendSelect();
        showToast(error.message, 'error');
    } finally {
        button.disabled = false;
        endpointSelect.disabled = false;
        button.innerHTML = originalContent;
    }
}

function openAddModal() {
    editingModel = null;
    document.getElementById('modalTitle').textContent = 'Add Model';
    document.getElementById('modalSubmit').textContent = 'Add Model';
    document.getElementById('nameInput').value = '';
    document.getElementById('backendInput').value = '';
    availableModels = [];
    upstreamModelsFetched = false;
    populateVersionSelect();
    populateBackendSelect();
    document.getElementById('pricingInputInput').value = '';
    document.getElementById('pricingOutputInput').value = '';
    document.getElementById('pricingCacheWriteInput').value = '';
    document.getElementById('pricingCacheReadInput').value = '';
    document.getElementById('modelModal').classList.add('active');
}

function openEditModal(modelName) {
    // Find the model object by name
    const model = models.find(m => m.name === modelName);
    if (!model) {
        showToast('Model not found', 'error');
        return;
    }

    editingModel = modelName;
    console.log('Opening edit modal for:', model);
    document.getElementById('modalTitle').textContent = 'Edit Model';
    document.getElementById('modalSubmit').textContent = 'Save Changes';
    document.getElementById('nameInput').value = model.name || '';
    document.getElementById('backendInput').value = model.backend || '';
    populateVersionSelect(model.version || '');

    // Upstream model discovery is manual; editing never contacts the endpoint.
    availableModels = [];
    upstreamModelsFetched = false;
    populateBackendSelect();

    document.getElementById('pricingInputInput').value = model.pricing?.input || '';
    document.getElementById('pricingOutputInput').value = model.pricing?.output || '';
    document.getElementById('pricingCacheWriteInput').value = model.pricing?.cache_write || '';
    document.getElementById('pricingCacheReadInput').value = model.pricing?.cache_read || '';
    document.getElementById('modelModal').classList.add('active');
}

function closeModal() {
    document.getElementById('modelModal').classList.remove('active');
    editingModel = null;
}

function openDeleteModal(model) {
    deletingModel = model;
    document.getElementById('deleteModelName').textContent = model;
    document.getElementById('deleteModal').classList.add('active');
}

function closeDeleteModal() {
    document.getElementById('deleteModal').classList.remove('active');
    deletingModel = null;
}

async function submitModel() {
    const name = document.getElementById('nameInput').value.trim();
    const backendSelect = document.getElementById('backendSelect').value.trim();
    const backendInput = document.getElementById('backendInput').value.trim();
    const backend = backendInput || backendSelect;
    const version = document.getElementById('versionSelect').value.trim();
    const pricingInput = document.getElementById('pricingInputInput').value.trim();
    const pricingOutput = document.getElementById('pricingOutputInput').value.trim();
    const pricingCacheWrite = document.getElementById('pricingCacheWriteInput').value.trim();
    const pricingCacheRead = document.getElementById('pricingCacheReadInput').value.trim();

    console.log('Submitting:', { editingModel, name, backend, version });

    if (!name) {
        showToast('Please enter a display name', 'error');
        return;
    }

    if (!backend) {
        showToast('Please enter a backend name', 'error');
        return;
    }

    if (!version) {
        showToast('Please select an endpoint version', 'error');
        return;
    }

    // Build the model object
    const modelData = {
        name,
        backend,
        version: version || '',
        pricing: {
            input: pricingInput !== '' ? parseFloat(pricingInput) : 0,
            output: pricingOutput !== '' ? parseFloat(pricingOutput) : 0,
            cache_write: pricingCacheWrite !== '' ? parseFloat(pricingCacheWrite) : 0,
            cache_read: pricingCacheRead !== '' ? parseFloat(pricingCacheRead) : 0
        }
    };

    try {
        if (editingModel) {
            // Update existing model
            const response = await fetch('/api/models', {
                method: 'PUT',
                headers: {
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify({ oldName: editingModel, ...modelData })
            });

            if (!response.ok) {
                const data = await response.json();
                throw new Error(data.error || 'Failed to update model');
            }

            showToast('Model updated successfully', 'success');
        } else {
            // Add new model
            const response = await fetch('/api/models', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify(modelData)
            });

            if (!response.ok) {
                const data = await response.json();
                throw new Error(data.error || 'Failed to add model');
            }

            showToast('Model added successfully', 'success');
        }

        closeModal();
        loadModels();
    } catch (error) {
        showToast(error.message, 'error');
    }
}

async function toggleModel(modelName) {
    try {
        const response = await fetch('/api/models/toggle', {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name: modelName })
        });

        if (!response.ok) {
            const data = await response.json();
            throw new Error(data.error || 'Failed to toggle model');
        }

        const data = await response.json();
        showToast(data.message, 'success');
        loadModels();
    } catch (error) {
        showToast(error.message, 'error');
    }
}

async function testModel(modelName, btn) {
    // Show spinner on the button
    if (btn) {
        btn.disabled = true;
        btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i>';
    }

    try {
        const response = await fetch('/api/models/test', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name: modelName })
        });
        const data = await response.json();
        modelTestResults.set(modelName, data);
        if (data.ok) {
            showToast(`${modelName}: OK (${data.latency_ms}ms)`, 'success');
        } else {
            showToast(`${modelName}: ${data.error}`, 'error');
        }
    } catch (error) {
        modelTestResults.set(modelName, { ok: false, error: error.message });
        showToast(error.message, 'error');
    }

    // Re-render to show the result badge (test results are preserved in the Map)
    renderModels();
}

async function confirmDelete() {
    if (!deletingModel) return;

    try {
        const response = await fetch('/api/models', {
            method: 'DELETE',
            headers: {
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({ name: deletingModel })
        });

        if (!response.ok) {
            const data = await response.json();
            throw new Error(data.error || 'Failed to delete model');
        }

        showToast('Model deleted successfully', 'success');
        closeDeleteModal();
        loadModels();
    } catch (error) {
        showToast(error.message, 'error');
    }
}

function showError(message) {
    document.getElementById('loading').style.display = 'none';
    document.getElementById('error').style.display = 'flex';
    document.getElementById('errorText').textContent = message;
}
