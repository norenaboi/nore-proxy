let models = [];
let endpoints = {};
let editingModel = null;
let deletingModel = null;
const modelTestResults = new Map();
let availableModels = [];
let upstreamModelsFetched = false;
let selectedTargets = [];

const $ = (id) => document.getElementById(id);
const isAutoModel = (model) => model?.modelType === 'auto';
const naturalSort = (a, b) => String(a).localeCompare(String(b), undefined, { numeric: true, sensitivity: 'base' });

function icon(className) {
    const element = document.createElement('i');
    element.className = className;
    return element;
}

function appendTextElement(parent, tag, className, text) {
    const element = document.createElement(tag);
    if (className) element.className = className;
    element.textContent = text;
    parent.appendChild(element);
    return element;
}

function makeButton(className, title, iconClass, label, handler) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = className;
    button.title = title;
    button.appendChild(icon(iconClass));
    if (label) button.appendChild(document.createTextNode(` ${label}`));
    button.addEventListener('click', () => handler(button));
    return button;
}

document.addEventListener('DOMContentLoaded', () => {
    loadModels();
    $('backendSelect').addEventListener('change', (event) => {
        if (event.target.value) $('backendInput').value = event.target.value;
    });
    $('versionSelect').addEventListener('change', () => {
        availableModels = [];
        upstreamModelsFetched = false;
        populateBackendSelect();
    });
    $('modelTypeSelect').addEventListener('change', () => {
        resetTypeSpecificState($('modelTypeSelect').value);
        updateTypeControls();
    });
});

async function loadModels() {
    try {
        const [modelsRes, endpointsRes] = await Promise.all([
            fetch('/api/models'),
            fetch('/api/endpoints')
        ]);
        if (modelsRes.status === 401 || modelsRes.status === 403) return logout();
        if (!modelsRes.ok) throw new Error('Failed to load models');

        const data = await modelsRes.json();
        models = Array.isArray(data.models) ? data.models : [];
        endpoints = {};
        if (endpointsRes.ok) {
            const epData = await endpointsRes.json();
            for (const ep of epData.endpoints || []) {
                const version = `v${ep.index}`;
                endpoints[version] = { version, ...ep };
            }
        }

        renderModels();
        $('loading').style.display = 'none';
        $('dashboard').style.display = 'block';
    } catch (error) {
        showError(error.message);
    }
}

function renderModels() {
    const list = $('modelsList');
    const emptyState = $('emptyState');
    const countBadge = $('modelCount');
    list.replaceChildren();
    countBadge.replaceChildren(icon('fa-solid fa-cube'));
    appendTextElement(countBadge, 'span', '', `${models.length} model${models.length === 1 ? '' : 's'}`);

    if (!models.length) {
        list.style.display = 'none';
        emptyState.style.display = 'block';
        return;
    }
    list.style.display = 'flex';
    emptyState.style.display = 'none';

    const groups = new Map();
    for (const model of models) {
        const key = isAutoModel(model) ? '__auto__' : (model.version || '__none__');
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key).push(model);
    }
    for (const groupModels of groups.values()) {
        groupModels.sort((a, b) => naturalSort(a.name, b.name));
    }
    const keys = [...groups.keys()].sort((a, b) => {
        if (a === '__auto__') return -1;
        if (b === '__auto__') return 1;
        if (a === '__none__') return 1;
        if (b === '__none__') return -1;
        return (parseInt(a.replace(/\D/g, ''), 10) || 0) - (parseInt(b.replace(/\D/g, ''), 10) || 0);
    });

    for (const key of keys) list.appendChild(renderModelGroup(key, groups.get(key)));
}

function renderModelGroup(key, groupModels) {
    const autoGroup = key === '__auto__';
    const group = document.createElement('section');
    group.className = `endpoint-group${autoGroup ? ' auto-model-group' : ''}`;

    const header = document.createElement('div');
    header.className = 'endpoint-group-header';
    const groupIcon = document.createElement('div');
    groupIcon.className = 'endpoint-icon';
    groupIcon.appendChild(icon(autoGroup ? 'fa-solid fa-shuffle' : 'fa-solid fa-hexagon-nodes'));
    header.appendChild(groupIcon);
    const endpointName = autoGroup
        ? 'Automatic Routing'
        : (endpoints[key]?.name || (key === '__none__' ? 'Unknown Endpoint' : 'Unknown Endpoint'));
    appendTextElement(header, 'span', 'endpoint-name', endpointName);
    appendTextElement(header, 'span', 'endpoint-count', `${groupModels.length} model${groupModels.length === 1 ? '' : 's'}`);
    group.appendChild(header);
    appendTextElement(group, 'div', 'endpoint-group-divider', '');

    const rows = document.createElement('div');
    rows.className = 'endpoint-group-models';
    for (const model of groupModels) rows.appendChild(renderModelRow(model));
    group.appendChild(rows);
    return group;
}

function renderModelRow(model) {
    const auto = isAutoModel(model);
    const row = document.createElement('div');
    row.className = `model-item${model.disabled ? ' disabled-model' : ''}${auto ? ' auto-model-item' : ''}`;

    const info = document.createElement('div');
    info.className = 'model-info';
    const modelIcon = document.createElement('div');
    modelIcon.className = 'model-icon';
    modelIcon.appendChild(icon(auto ? 'fa-solid fa-shuffle' : 'fa-solid fa-microchip'));
    info.appendChild(modelIcon);

    const meta = document.createElement('div');
    meta.className = 'model-meta';
    const titleRow = document.createElement('div');
    titleRow.className = 'model-meta-row';
    appendTextElement(titleRow, 'span', 'model-name', model.name);
    if (model.disabled) appendTextElement(titleRow, 'span', 'model-badge model-badge-disabled', 'disabled');
    if (model.hidden) appendTextElement(titleRow, 'span', 'model-badge model-badge-hidden', 'hidden');
    if (auto) {
        appendTextElement(titleRow, 'span', 'model-badge model-badge-auto', 'auto');
        appendTextElement(titleRow, 'span', 'model-badge model-badge-selection', model.targetSelection === 'roundrobin' ? 'round-robin' : 'sticky');
        appendTextElement(titleRow, 'span', 'model-badge model-badge-targets', `${(model.targets || []).length} targets`);
        if (model.maxTargetAttempts != null) {
            appendTextElement(titleRow, 'span', 'model-badge model-badge-attempts', `max ${model.maxTargetAttempts}`);
        }
    } else if (model.backend && model.backend !== model.name) {
        appendTextElement(titleRow, 'span', 'model-badge model-badge-backend', model.backend);
    }
    meta.appendChild(titleRow);
    meta.appendChild(renderPricing(model.pricing || {}));
    info.appendChild(meta);
    row.appendChild(info);

    const actions = document.createElement('div');
    actions.className = 'model-actions';
    if (!auto) {
        const result = modelTestResults.get(model.name);
        if (result) {
            const badge = appendTextElement(actions, 'span', `test-result-badge ${result.ok ? 'ok' : 'fail'}`, result.ok ? `${result.latency_ms}ms` : 'fail');
            badge.prepend(icon(result.ok ? 'fa-solid fa-check' : 'fa-solid fa-xmark'));
        }
        actions.appendChild(makeButton('btn btn-test btn-sm', 'Test model (silent — not logged)', 'fa-solid fa-flask', '', (button) => testModel(model.name, button)));
    }
    actions.appendChild(makeButton(
        `btn btn-sm ${model.disabled ? 'btn-warning' : 'btn-success'}`,
        model.disabled ? 'Enable model' : 'Disable model',
        `fa-solid fa-${model.disabled ? 'pause' : 'play'}`,
        '',
        () => toggleModel(model.name)
    ));
    actions.appendChild(makeButton('btn btn-secondary btn-sm', 'Edit model', 'fa-solid fa-pen', 'Edit', () => openEditModal(model.name)));
    actions.appendChild(makeButton('btn btn-danger btn-sm', 'Delete model', 'fa-solid fa-trash', '', () => openDeleteModal(model.name)));
    row.appendChild(actions);
    return row;
}

function renderPricing(pricing) {
    const container = document.createElement('div');
    container.className = 'model-pricing';
    const fields = [['in', pricing.input], ['out', pricing.output], ['cw', pricing.cache_write], ['cr', pricing.cache_read]];
    for (const [label, value] of fields) {
        const chip = document.createElement('span');
        chip.className = 'pricing-chip';
        appendTextElement(chip, 'span', 'chip-label', label);
        const amount = value != null && value !== '' && Number.isFinite(Number(value)) ? Number(value).toFixed(2) : '0.00';
        appendTextElement(chip, 'span', 'chip-val', `$${amount}`);
        container.appendChild(chip);
    }
    return container;
}

function populateVersionSelect(selectedVersion = '') {
    const select = $('versionSelect');
    select.replaceChildren(new Option('Select an endpoint', ''));
    const versions = Object.keys(endpoints).sort((a, b) => (parseInt(a.slice(1), 10) || 0) - (parseInt(b.slice(1), 10) || 0));
    for (const version of versions) {
        select.add(new Option(endpoints[version]?.name || version, version, false, version === selectedVersion));
    }
}

function populateBackendSelect(selectedBackend = '') {
    const select = $('backendSelect');
    select.replaceChildren();
    if (!$('versionSelect').value) return select.add(new Option('Please select an endpoint first', ''));
    if (!upstreamModelsFetched) return select.add(new Option('Click Fetch to load models', ''));
    if (!availableModels.length) return select.add(new Option('No models returned by endpoint', ''));
    select.add(new Option('Select a model', ''));
    for (const name of availableModels) select.add(new Option(name, name, false, name === selectedBackend));
}

function concreteCandidates() {
    return models
        .filter((model) => !isAutoModel(model) && !model.disabled && model.name !== editingModel)
        .sort((a, b) => naturalSort(a.name, b.name));
}

function populateTargetCandidateSelect() {
    const select = $('targetCandidateSelect');
    const candidates = concreteCandidates().filter((model) => !selectedTargets.includes(model.name));
    select.replaceChildren();
    if (!candidates.length) {
        select.add(new Option('No enabled concrete models available', ''));
        select.disabled = true;
        $('addTargetButton').disabled = true;
        return;
    }
    select.disabled = false;
    $('addTargetButton').disabled = false;
    select.add(new Option('Select a concrete model', ''));
    for (const model of candidates) select.add(new Option(model.name, model.name));
}

function renderSelectedTargets() {
    const container = $('selectedTargets');
    container.replaceChildren();
    if (!selectedTargets.length) {
        appendTextElement(container, 'p', 'targets-empty', 'No targets selected.');
    } else {
        selectedTargets.forEach((name, index) => {
            const row = document.createElement('div');
            row.className = 'selected-target-row';
            appendTextElement(row, 'span', 'target-order', String(index + 1));
            appendTextElement(row, 'span', 'target-name', name);
            const controls = document.createElement('div');
            controls.className = 'target-actions';
            const up = makeButton('target-action', 'Move up', 'fa-solid fa-chevron-up', '', () => moveTarget(index, -1));
            const down = makeButton('target-action', 'Move down', 'fa-solid fa-chevron-down', '', () => moveTarget(index, 1));
            up.disabled = index === 0;
            down.disabled = index === selectedTargets.length - 1;
            controls.append(up, down, makeButton('target-action remove', 'Remove target', 'fa-solid fa-xmark', '', () => removeTarget(index)));
            row.appendChild(controls);
            container.appendChild(row);
        });
    }
    populateTargetCandidateSelect();
    updateMaxAttemptsHelp();
}

function addSelectedTarget() {
    const name = $('targetCandidateSelect').value;
    if (!name || selectedTargets.includes(name)) return;
    selectedTargets.push(name);
    renderSelectedTargets();
}

function moveTarget(index, delta) {
    const next = index + delta;
    if (next < 0 || next >= selectedTargets.length) return;
    [selectedTargets[index], selectedTargets[next]] = [selectedTargets[next], selectedTargets[index]];
    renderSelectedTargets();
}

function removeTarget(index) {
    selectedTargets.splice(index, 1);
    renderSelectedTargets();
}

function updateMaxAttemptsHelp() {
    const suffix = selectedTargets.length ? ` This model currently has ${selectedTargets.length} target${selectedTargets.length === 1 ? '' : 's'}.` : '';
    $('maxTargetAttemptsHelp').textContent = `Leave blank to use the global failover limit.${suffix}`;
}

async function fetchUpstreamModels(version) {
    const res = await fetch(`/api/endpoints/${encodeURIComponent(version)}/models`);
    if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || 'Failed to fetch models from the endpoint');
    }
    const data = await res.json();
    availableModels = (data.models || []).filter((name) => typeof name === 'string' && name).sort(naturalSort);
    upstreamModelsFetched = true;
}

async function fetchModelsManually(button) {
    const version = $('versionSelect').value;
    if (!version) return showToast('Please select an endpoint first', 'error');
    const currentBackend = $('backendInput').value.trim();
    const originalContent = button.innerHTML;
    button.disabled = true;
    $('versionSelect').disabled = true;
    button.replaceChildren(icon('fa-solid fa-spinner fa-spin'), document.createTextNode(' Fetching'));
    try {
        await fetchUpstreamModels(version);
        populateBackendSelect(currentBackend);
        showToast(`Fetched ${availableModels.length} model${availableModels.length === 1 ? '' : 's'}`, 'success');
    } catch (error) {
        availableModels = [];
        upstreamModelsFetched = false;
        populateBackendSelect();
        showToast(error.message, 'error');
    } finally {
        button.disabled = false;
        $('versionSelect').disabled = false;
        button.innerHTML = originalContent;
    }
}

function resetTypeSpecificState(type = 'concrete') {
    availableModels = [];
    upstreamModelsFetched = false;
    $('backendInput').value = '';
    populateVersionSelect();
    populateBackendSelect();
    selectedTargets = [];
    $('targetSelectionInput').value = 'sticky';
    $('maxTargetAttemptsInput').value = '';
    if (type === 'auto') renderSelectedTargets();
}

function resetModalState() {
    editingModel = null;
    $('nameInput').value = '';
    $('modelTypeSelect').value = 'concrete';
    $('hiddenInput').checked = false;
    resetTypeSpecificState('concrete');
    for (const id of ['pricingInputInput', 'pricingOutputInput', 'pricingCacheWriteInput', 'pricingCacheReadInput']) $(id).value = '';
    updateTypeControls();
}

function updateTypeControls() {
    const auto = $('modelTypeSelect').value === 'auto';
    $('concreteControls').hidden = auto;
    $('autoControls').hidden = !auto;
    if (auto) renderSelectedTargets();
}

function openAddModal() {
    resetModalState();
    $('modalTitle').textContent = 'Add Model';
    $('modalSubmit').textContent = 'Add Model';
    $('modelModal').classList.add('active');
}

function openEditModal(modelName) {
    const model = models.find((entry) => entry.name === modelName);
    if (!model) return showToast('Model not found', 'error');
    resetModalState();
    editingModel = modelName;
    $('modalTitle').textContent = 'Edit Model';
    $('modalSubmit').textContent = 'Save Changes';
    $('nameInput').value = model.name || '';
    $('modelTypeSelect').value = isAutoModel(model) ? 'auto' : 'concrete';
    $('hiddenInput').checked = model.hidden === true;
    if (isAutoModel(model)) {
        selectedTargets = [...new Set(Array.isArray(model.targets) ? model.targets : [])];
        $('targetSelectionInput').value = model.targetSelection === 'roundrobin' ? 'roundrobin' : 'sticky';
        $('maxTargetAttemptsInput').value = model.maxTargetAttempts ?? '';
        renderSelectedTargets();
    } else {
        $('backendInput').value = model.backend || '';
        populateVersionSelect(model.version || '');
        populateBackendSelect();
    }
    $('pricingInputInput').value = model.pricing?.input ?? '';
    $('pricingOutputInput').value = model.pricing?.output ?? '';
    $('pricingCacheWriteInput').value = model.pricing?.cache_write ?? '';
    $('pricingCacheReadInput').value = model.pricing?.cache_read ?? '';
    updateTypeControls();
    $('modelModal').classList.add('active');
}

function closeModal() {
    $('modelModal').classList.remove('active');
    resetModalState();
}

function openDeleteModal(model) {
    deletingModel = model;
    $('deleteModelName').textContent = model;
    $('deleteModal').classList.add('active');
}

function closeDeleteModal() {
    $('deleteModal').classList.remove('active');
    deletingModel = null;
}

function pricingPayload() {
    const numberOrZero = (id) => {
        const value = $(id).value.trim();
        return value === '' ? 0 : parseFloat(value);
    };
    return {
        input: numberOrZero('pricingInputInput'),
        output: numberOrZero('pricingOutputInput'),
        cache_write: numberOrZero('pricingCacheWriteInput'),
        cache_read: numberOrZero('pricingCacheReadInput')
    };
}

function dependencyMessage(data, fallback) {
    const dependencies = data.dependents || data.blockers;
    if (!Array.isArray(dependencies) || !dependencies.length) return data.error || fallback;
    return `${data.error || fallback}: ${dependencies.join(', ')}`;
}

async function submitModel() {
    const name = $('nameInput').value.trim();
    const modelType = $('modelTypeSelect').value;
    if (!name) return showToast('Please enter a display name', 'error');

    const modelData = {
        name,
        modelType,
        hidden: $('hiddenInput').checked,
        pricing: pricingPayload()
    };
    if (modelType === 'auto') {
        const uniqueTargets = [...new Set(selectedTargets)];
        if (uniqueTargets.length < 2 || uniqueTargets.length !== selectedTargets.length) {
            return showToast('Select at least two unique concrete targets', 'error');
        }
        const rawAttempts = $('maxTargetAttemptsInput').value.trim();
        const maxTargetAttempts = rawAttempts === '' ? null : Number(rawAttempts);
        if (maxTargetAttempts !== null && (!Number.isInteger(maxTargetAttempts) || maxTargetAttempts < 1 || maxTargetAttempts > 20)) {
            return showToast('Maximum target attempts must be an integer from 1 to 20', 'error');
        }
        if (maxTargetAttempts !== null && maxTargetAttempts > uniqueTargets.length) {
            return showToast('Maximum target attempts cannot exceed the number of targets', 'error');
        }
        modelData.targets = uniqueTargets;
        modelData.targetSelection = $('targetSelectionInput').value;
        modelData.maxTargetAttempts = maxTargetAttempts;
    } else {
        const backend = $('backendInput').value.trim() || $('backendSelect').value.trim();
        const version = $('versionSelect').value.trim();
        if (!backend) return showToast('Please enter a backend name', 'error');
        if (!version) return showToast('Please select an endpoint version', 'error');
        modelData.backend = backend;
        modelData.version = version;
    }

    try {
        const response = await fetch('/api/models', {
            method: editingModel ? 'PUT' : 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(editingModel ? { oldName: editingModel, ...modelData } : modelData)
        });
        if (response.status === 401 || response.status === 403) return logout();
        const data = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(response.status === 409
            ? dependencyMessage(data, 'Model has active dependencies')
            : (data.error || `Failed to ${editingModel ? 'update' : 'add'} model`));
        showToast(`Model ${editingModel ? 'updated' : 'added'} successfully`, 'success');
        closeModal();
        await loadModels();
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
        if (response.status === 401 || response.status === 403) return logout();
        const data = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(response.status === 409
            ? dependencyMessage(data, 'Model has active dependencies')
            : (data.error || 'Failed to toggle model'));
        showToast(data.message || 'Model updated', 'success');
        await loadModels();
    } catch (error) {
        showToast(error.message, 'error');
    }
}

async function testModel(modelName, button) {
    if (button) {
        button.disabled = true;
        button.replaceChildren(icon('fa-solid fa-spinner fa-spin'));
    }
    try {
        const response = await fetch('/api/models/test', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name: modelName })
        });
        const data = await response.json();
        modelTestResults.set(modelName, data);
        showToast(data.ok ? `${modelName}: OK (${data.latency_ms}ms)` : `${modelName}: ${data.error}`, data.ok ? 'success' : 'error');
    } catch (error) {
        modelTestResults.set(modelName, { ok: false, error: error.message });
        showToast(error.message, 'error');
    }
    renderModels();
}

async function confirmDelete() {
    if (!deletingModel) return;
    try {
        const response = await fetch('/api/models', {
            method: 'DELETE',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name: deletingModel })
        });
        if (response.status === 401 || response.status === 403) return logout();
        const data = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(response.status === 409
            ? dependencyMessage(data, 'Model has active dependencies')
            : (data.error || 'Failed to delete model'));
        showToast('Model deleted successfully', 'success');
        closeDeleteModal();
        await loadModels();
    } catch (error) {
        showToast(error.message, 'error');
    }
}

function showError(message) {
    $('loading').style.display = 'none';
    $('error').style.display = 'flex';
    $('errorText').textContent = message;
}
