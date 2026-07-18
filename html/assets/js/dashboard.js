const dashboardState = {
    range: "24h",
    generation: 0,
    data: null,
};

const rangeLabels = {
    "24h": "Last 24 hours",
    "7d": "Last 7 days",
    "30d": "Last 30 days",
    total: "All time",
};

const requestHistory = {
    expanded: false,
    filtersLoaded: false,
    cursor: null,
    hasMore: true,
    loading: false,
    generation: 0,
    seen: new Set(),
    observer: null,
};

function redirectIfUnauthorized(response) {
    if (response.status === 401 || response.status === 403) {
        window.location.href = "/admin/login";
        return true;
    }
    return false;
}

async function loadDashboard() {
    const generation = ++dashboardState.generation;
    try {
        const response = await fetch("/api/logs");
        if (!response.ok) {
            if (redirectIfUnauthorized(response)) return;
            throw new Error("Failed to load dashboard");
        }

        const data = await response.json();
        if (generation !== dashboardState.generation) return;
        dashboardState.data = data;
        const totalCost = data.summary.total_cost || 0;
        const dailyCost = data.summary.daily_cost || 0;
        const values = {
            dailyRequests: data.summary.daily_requests,
            totalRequests: data.summary.total_requests,
            totalInput: data.summary.total_input_tokens,
            totalOutput: data.summary.total_output_tokens,
            totalCacheWrite: data.summary.total_cache_write_tokens || 0,
            totalCacheRead: data.summary.total_cache_read_tokens || 0,
            dailyInput: data.summary.daily_input_tokens,
            dailyOutput: data.summary.daily_output_tokens,
            dailyCacheWrite: data.summary.daily_cache_write_tokens || 0,
            dailyCacheRead: data.summary.daily_cache_read_tokens || 0,
        };
        for (const [id, value] of Object.entries(values)) {
            document.getElementById(id).textContent = value.toLocaleString();
        }
        document.getElementById("keyCount").textContent =
            `${data.summary.total_api_keys.toLocaleString()} keys`;

        const costs = {
            totalInputCost: data.summary.total_input_cost || 0,
            totalOutputCost: data.summary.total_output_cost || 0,
            totalCacheWriteCost: data.summary.total_cache_write_cost || 0,
            totalCacheReadCost: data.summary.total_cache_read_cost || 0,
            dailyInputCost: data.summary.daily_input_cost || 0,
            dailyOutputCost: data.summary.daily_output_cost || 0,
            dailyCacheWriteCost: data.summary.daily_cache_write_cost || 0,
            dailyCacheReadCost: data.summary.daily_cache_read_cost || 0,
        };
        for (const [id, value] of Object.entries(costs)) {
            document.getElementById(id).textContent = `$${value.toFixed(4)}`;
        }
        document.getElementById("totalCost").textContent = `$${totalCost.toFixed(2)}`;
        document.getElementById("dailyCost").textContent = `$${dailyCost.toFixed(2)}`;

        renderDashboardRange(data);

        document.getElementById("loading").style.display = "none";
        document.getElementById("dashboard").style.display = "block";
    } catch (error) {
        document.getElementById("loading").style.display = "none";
        document.getElementById("error").style.display = "block";
        document.getElementById("error").textContent = error.message;
    }
}

function renderDashboardRange(data) {
    const range = data.ranges?.[dashboardState.range];
    if (!range) {
        const error = document.getElementById("error");
        error.style.display = "block";
        error.textContent = "Dashboard range data is unavailable. Restart the server with the matching frontend and backend update.";
        return false;
    }
    document.getElementById("error").style.display = "none";
    const summary = range.summary;
    const numberValues = {
        rangeRequests: summary.requests,
        rangeInput: summary.input_tokens,
        rangeOutput: summary.output_tokens,
        rangeCacheWrite: summary.cache_write_tokens,
        rangeCacheRead: summary.cache_read_tokens,
        rangeSuccessCount: summary.successes,
        rangeFailureCount: summary.failures,
    };
    for (const [id, value] of Object.entries(numberValues)) {
        document.getElementById(id).textContent = Number(value || 0).toLocaleString();
    }
    document.getElementById("rangeCost").textContent = `$${Number(summary.estimated_cost || 0).toFixed(2)}`;
    document.getElementById("rangeSuccess").textContent = `${Number(summary.success_rate || 0).toFixed(1)}%`;
    document.getElementById("rangeInputCost").textContent = `$${Number(summary.input_cost || 0).toFixed(4)}`;
    document.getElementById("rangeOutputCost").textContent = `$${Number(summary.output_cost || 0).toFixed(4)}`;
    document.getElementById("rangeCacheWriteCost").textContent = `$${Number(summary.cache_write_cost || 0).toFixed(4)}`;
    document.getElementById("rangeCacheReadCost").textContent = `$${Number(summary.cache_read_cost || 0).toFixed(4)}`;
    document.getElementById("rangeLabel").textContent = rangeLabels[dashboardState.range];
    document.getElementById("apiKeyRangeLabel").textContent = rangeLabels[dashboardState.range];

    const tbody = document.getElementById("apiKeysBody");
    tbody.replaceChildren();
    for (const key of range.api_keys) {
        const row = document.createElement("tr");
        [key.name, key.requests, key.input_tokens, key.output_tokens,
            key.cache_write_tokens, key.cache_read_tokens,
            `$${Number(key.estimated_cost || 0).toFixed(2)}`].forEach((value, index) => {
            appendCell(row, typeof value === "number" ? value.toLocaleString() : value,
                index > 0 ? "numeric-cell" : "");
            if (index === 0) {
                const cell = row.lastElementChild;
                const strong = document.createElement("strong");
                strong.textContent = cell.textContent;
                cell.replaceChildren(strong);
            }
        });
        tbody.appendChild(row);
    }
    return true;
}

function initializeDashboardRange() {
    document.querySelectorAll("[data-dashboard-range]").forEach((button) => {
        button.addEventListener("click", () => {
            dashboardState.range = button.dataset.dashboardRange;
            document.querySelectorAll("[data-dashboard-range]").forEach((item) => {
                item.setAttribute("aria-pressed", String(item === button));
            });
            if (dashboardState.data) renderDashboardRange(dashboardState.data);
            loadDashboard();
        });
    });
}

function appendCell(row, value, className = "") {
    const cell = document.createElement("td");
    cell.textContent = value;
    if (className) cell.className = className;
    row.appendChild(cell);
}

function renderRequest(request) {
    const row = document.createElement("tr");
    row.dataset.requestId = String(request.id);
    const date = new Date(request.timestamp * 1000);
    appendCell(row, `${date.toLocaleDateString()} ${date.toLocaleTimeString()}`, "timestamp");
    appendCell(row, request.name || request.apiKey || "Unknown");
    appendCell(row, request.model || "Unknown", "request-model");
    appendCell(row, Number(request.inputTokens || 0).toLocaleString(), "numeric-cell");
    appendCell(row, Number(request.outputTokens || 0).toLocaleString(), "numeric-cell");
    appendCell(row, Number(request.cacheWriteTokens || 0).toLocaleString(), "numeric-cell");
    appendCell(row, Number(request.cacheReadTokens || 0).toLocaleString(), "numeric-cell");
    appendCell(row, `${Number(request.duration || 0).toFixed(2)}s`, "numeric-cell");
    appendCell(row, `$${Number(request.estimatedCost || 0).toFixed(4)}`, "numeric-cell");
    const statusCell = document.createElement("td");
    const badge = document.createElement("span");
    const status = ["success", "failed"].includes(request.status) ? request.status : "unknown";
    badge.className = `request-status ${status}`;
    badge.textContent = status.charAt(0).toUpperCase() + status.slice(1);
    statusCell.appendChild(badge);
    row.appendChild(statusCell);
    document.getElementById("recentLogsBody").appendChild(row);
}

function requestHistoryParams() {
    const params = new URLSearchParams({ limit: "50" });
    if (requestHistory.cursor) params.set("cursor", requestHistory.cursor);
    const mappings = [
        ["requestApiKeyFilter", "apiKey"],
        ["requestModelFilter", "model"],
        ["requestStatusFilter", "status"],
    ];
    for (const [id, name] of mappings) {
        const value = document.getElementById(id).value;
        if (value) params.set(name, value);
    }
    const range = document.getElementById("requestTimeFilter").value;
    if (range) {
        const seconds = { "24h": 86400, "7d": 604800, "30d": 2592000 }[range];
        params.set("from", String(Math.floor(Date.now() / 1000) - seconds));
    }
    return params;
}

function setRequestState(message, kind = "") {
    const state = document.getElementById("requestHistoryState");
    state.textContent = message;
    state.className = `request-history-state ${kind}`.trim();
}

async function loadRequestPage({ reset = false } = {}) {
    if (reset) {
        requestHistory.generation += 1;
        requestHistory.cursor = null;
        requestHistory.hasMore = true;
        requestHistory.seen.clear();
        document.getElementById("recentLogsBody").replaceChildren();
    } else if (requestHistory.loading || !requestHistory.hasMore) {
        return;
    }
    const generation = requestHistory.generation;
    requestHistory.loading = true;
    setRequestState("Loading requests…", "loading");

    try {
        const response = await fetch(`/api/requests?${requestHistoryParams()}`);
        if (!response.ok) {
            if (redirectIfUnauthorized(response)) return;
            throw new Error("Could not load request history");
        }
        const data = await response.json();
        if (generation !== requestHistory.generation) return;
        for (const request of data.requests) {
            if (requestHistory.seen.has(request.id)) continue;
            requestHistory.seen.add(request.id);
            renderRequest(request);
        }
        requestHistory.cursor = data.nextCursor;
        requestHistory.hasMore = Boolean(data.hasMore);
        if (!requestHistory.seen.size) setRequestState("No requests match these filters.");
        else if (!requestHistory.hasMore) setRequestState("All matching requests are shown.");
        else if (requestHistory.expanded) setRequestState("Scroll to load 50 more requests.");
        else setRequestState("Showing the latest 50 requests.");
    } catch (error) {
        if (generation === requestHistory.generation) setRequestState(error.message, "error");
    } finally {
        if (generation === requestHistory.generation) requestHistory.loading = false;
    }
}

function addOptions(selectId, options, valueKey = null) {
    const select = document.getElementById(selectId);
    for (const optionData of options) {
        const option = document.createElement("option");
        option.value = valueKey ? optionData[valueKey] : optionData;
        option.textContent = valueKey ? optionData.label : optionData;
        select.appendChild(option);
    }
}

async function loadRequestFilters() {
    if (requestHistory.filtersLoaded) return;
    const response = await fetch("/api/requests/filters");
    if (!response.ok) {
        if (redirectIfUnauthorized(response)) return;
        throw new Error("Could not load request filters");
    }
    const filters = await response.json();
    addOptions("requestApiKeyFilter", filters.apiKeys, "value");
    addOptions("requestModelFilter", filters.models);
    requestHistory.filtersLoaded = true;
}

function initializeRequestHistory() {
    const toggle = document.getElementById("requestHistoryToggle");
    const filters = document.getElementById("requestHistoryFilters");
    toggle.addEventListener("click", async () => {
        requestHistory.expanded = !requestHistory.expanded;
        toggle.setAttribute("aria-expanded", String(requestHistory.expanded));
        filters.hidden = !requestHistory.expanded;
        toggle.lastElementChild?.classList.toggle("fa-chevron-up", requestHistory.expanded);
        toggle.lastElementChild?.classList.toggle("fa-chevron-down", !requestHistory.expanded);
        if (requestHistory.expanded) {
            try {
                await loadRequestFilters();
                requestHistory.observer?.observe(document.getElementById("requestHistorySentinel"));
            } catch (error) {
                setRequestState(error.message, "error");
            }
        } else {
            requestHistory.observer?.disconnect();
        }
    });

    ["requestApiKeyFilter", "requestModelFilter", "requestStatusFilter", "requestTimeFilter"]
        .forEach((id) => document.getElementById(id).addEventListener("change", () => loadRequestPage({ reset: true })));
    document.getElementById("requestFiltersReset").addEventListener("click", () => {
        ["requestApiKeyFilter", "requestModelFilter", "requestStatusFilter", "requestTimeFilter"]
            .forEach((id) => { document.getElementById(id).value = ""; });
        loadRequestPage({ reset: true });
    });

    requestHistory.observer = new IntersectionObserver((entries) => {
        if (entries.some((entry) => entry.isIntersecting) && requestHistory.expanded) {
            loadRequestPage();
        }
    }, { rootMargin: "300px" });
    loadRequestPage({ reset: true });
}

initializeDashboardRange();
loadDashboard();
initializeRequestHistory();
setInterval(loadDashboard, 30000);
