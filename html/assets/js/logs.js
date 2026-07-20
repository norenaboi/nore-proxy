const historyState = { cursor: null, hasMore: true, loading: false, generation: 0, seen: new Set(), observer: null };
const tableBody = document.getElementById("requestsTableBody");
const detailBackdrop = document.getElementById("detailBackdrop");

async function apiFetch(url, options = {}) {
    const response = await fetch(url, options);
    if (response.status === 401 || response.status === 403) {
        window.location.href = "/admin/login";
        throw new Error("Admin session expired");
    }
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || `Request failed (${response.status})`);
    return data;
}

function addOptions(select, values, valueKey = null) {
    for (const item of values || []) {
        const option = document.createElement("option");
        option.value = valueKey ? item[valueKey] : item;
        option.textContent = valueKey ? item.label : item;
        select.appendChild(option);
    }
}

async function loadFilters() {
    const data = await apiFetch("/api/requests/filters");
    addOptions(document.getElementById("apiKeyFilter"), data.apiKeys, "value");
    addOptions(document.getElementById("modelFilter"), data.models);
}

function buildListUrl() {
    const params = new URLSearchParams({ limit: "50" });
    if (historyState.cursor) params.set("cursor", historyState.cursor);
    const filters = [["apiKeyFilter", "apiKey"], ["modelFilter", "model"], ["statusFilter", "status"]];
    for (const [id, key] of filters) {
        const value = document.getElementById(id).value;
        if (value) params.set(key, value);
    }
    const range = document.getElementById("timeFilter").value;
    if (range) {
        const seconds = { "24h": 86400, "7d": 604800, "30d": 2592000 }[range];
        params.set("from", String(Math.floor(Date.now() / 1000) - seconds));
    }
    return `/api/requests?${params}`;
}

function setState(message, kind = "") {
    const element = document.getElementById("requestHistoryState");
    element.textContent = message;
    element.className = `request-history-state ${kind}`.trim();
}

function addCell(row, value, className = "") {
    const cell = document.createElement("td");
    cell.textContent = value ?? "—";
    cell.title = value ?? "";
    if (className) cell.className = className;
    row.appendChild(cell);
}

function formatTime(timestamp) {
    if (!timestamp) return "—";
    const date = new Date(timestamp * 1000);
    return Number.isNaN(date.getTime()) ? String(timestamp) : date.toLocaleString();
}

function renderRequest(request) {
    const row = document.createElement("tr");
    row.tabIndex = 0;
    row.setAttribute("aria-label", `Inspect request ${request.requestId || request.id}`);
    row.addEventListener("click", () => openDetail(request.id));
    row.addEventListener("keydown", (event) => {
        if (event.key === "Enter" || event.key === " ") {
            event.preventDefault();
            openDetail(request.id);
        }
    });
    addCell(row, formatTime(request.timestamp), "timestamp");
    addCell(row, request.name || request.apiKey || "Unknown", "primary-cell");
    addCell(row, request.model || "Unknown", "primary-cell");
    addCell(row, request.endpointName, "secondary-cell");
    addCell(row, Number(request.inputTokens || 0).toLocaleString(), "numeric-cell");
    addCell(row, Number(request.outputTokens || 0).toLocaleString(), "numeric-cell");
    addCell(row, Number(request.cacheWriteTokens || 0).toLocaleString(), "numeric-cell");
    addCell(row, Number(request.cacheReadTokens || 0).toLocaleString(), "numeric-cell");
    addCell(row, `${Number(request.duration || 0).toFixed(2)}s`, "numeric-cell");
    addCell(row, `$${Number(request.estimatedCost || 0).toFixed(6)}`, "numeric-cell");
    const statusCell = document.createElement("td");
    const badge = document.createElement("span");
    const status = ["success", "failed"].includes(request.status) ? request.status : "unknown";
    badge.className = `status-badge ${status}`;
    badge.textContent = status;
    statusCell.appendChild(badge);
    row.appendChild(statusCell);
    tableBody.appendChild(row);
}

async function loadPage({ reset = false } = {}) {
    if (reset) {
        historyState.generation += 1;
        historyState.cursor = null;
        historyState.hasMore = true;
        historyState.seen.clear();
        tableBody.replaceChildren();
    } else if (historyState.loading || !historyState.hasMore) return;
    const generation = historyState.generation;
    historyState.loading = true;
    setState("Loading requests…", "loading");
    try {
        const data = await apiFetch(buildListUrl());
        if (generation !== historyState.generation) return;
        for (const request of data.requests || []) {
            if (historyState.seen.has(request.id)) continue;
            historyState.seen.add(request.id);
            renderRequest(request);
        }
        historyState.cursor = data.nextCursor;
        historyState.hasMore = Boolean(data.hasMore);
        document.getElementById("requestCount").textContent = `${historyState.seen.size.toLocaleString()} loaded`;
        if (!historyState.seen.size) setState("No requests match these filters.");
        else if (!historyState.hasMore) setState("All matching requests are shown.");
        else setState("Scroll to load 50 more requests.");
    } catch (error) {
        if (generation === historyState.generation) setState(error.message, "error");
    } finally {
        if (generation === historyState.generation) historyState.loading = false;
    }
}

function field(label, value) {
    const wrapper = document.createElement("div");
    wrapper.className = "detail-field";
    const name = document.createElement("span");
    name.className = "detail-label";
    name.textContent = label;
    const content = document.createElement("span");
    content.className = "detail-value";
    content.textContent = value === null || value === undefined || value === "" ? "Not available" : String(value);
    wrapper.append(name, content);
    return wrapper;
}

function renderFields(id, values) {
    const container = document.getElementById(id);
    container.replaceChildren(...values.map(([label, value]) => field(label, value)));
}

function money(value) { return `$${Number(value || 0).toFixed(8)}`; }

async function openDetail(id) {
    detailBackdrop.classList.add("open");
    document.body.style.overflow = "hidden";
    document.getElementById("detailTitle").textContent = `Request #${id}`;
    document.getElementById("detailSubtitle").textContent = "Loading stored context…";
    try {
        const { request } = await apiFetch(`/api/requests/${id}`);
        const routing = request.routing || {};
        const outcome = request.outcome || {};
        const billing = request.billing || {};
        const rates = billing.pricing_per_million || {};
        const costs = billing.costs || {};
        document.getElementById("detailSubtitle").textContent = request.requestId || request.model;
        renderFields("requestFields", [
            ["Request ID", request.requestId], ["Timestamp", formatTime(request.timestamp)],
            ["Caller", request.name], ["Caller key", request.apiKey],
            ["Client IP", request.request?.clientIp], ["Protocol", request.request?.protocol],
            ["Method and path", [request.request?.method, request.request?.path].filter(Boolean).join(" ")],
            ["Streaming", request.request?.streaming === null ? null : request.request?.streaming ? "Yes" : "No"],
        ]);
        renderFields("routingFields", [
            ["Requested model", routing.requestedModel], ["Target model", routing.targetModel],
            ["Upstream model", routing.upstreamModel], ["Endpoint", routing.endpointName],
            ["API format", routing.apiFormat], ["Upstream URL", routing.upstreamUrl],
            ["Upstream key", routing.maskedUpstreamKey], ["Attempts", routing.attemptCount],
        ]);
        document.getElementById("detailAttempts").textContent = routing.attempts ? JSON.stringify(routing.attempts, null, 2) : "Not available";
        renderFields("outcomeFields", [
            ["Status", request.status], ["Proxy status", outcome.proxyStatus],
            ["Upstream status", outcome.upstreamStatus], ["Duration", `${Number(request.duration || 0).toFixed(3)}s`],
            ["Error", outcome.error],
        ]);
        renderFields("billingFields", [
            ["Cost source", request.costSource === "recorded" ? "Recorded cost" : "Current-price estimate"],
            ["Accounting version", billing.accounting_version], ["Input tokens", billing.input_tokens],
            ["Output tokens", billing.output_tokens], ["Cache write tokens", billing.cache_write_tokens],
            ["Cache read tokens", billing.cache_read_tokens], ["Input rate / 1M", rates.input],
            ["Output rate / 1M", rates.output], ["Cache write rate / 1M", rates.cache_write],
            ["Cache read rate / 1M", rates.cache_read], ["Total cost", money(costs.total)],
        ]);
        document.getElementById("detailCostFormula").textContent = [
            `Input: ${billing.input_tokens || 0} × ${rates.input ?? "current rate"} / 1,000,000 = ${money(costs.input)}`,
            `Output: ${billing.output_tokens || 0} × ${rates.output ?? "current rate"} / 1,000,000 = ${money(costs.output)}`,
            `Cache write: ${billing.cache_write_tokens || 0} × ${rates.cache_write ?? "current rate"} / 1,000,000 = ${money(costs.cache_write)}`,
            `Cache read: ${billing.cache_read_tokens || 0} × ${rates.cache_read ?? "current rate"} / 1,000,000 = ${money(costs.cache_read)}`,
            `Total: ${money(costs.total)}`,
        ].join("\n");
        const section = document.getElementById("relatedErrorSection");
        section.hidden = !request.relatedError;
        if (request.relatedError) {
            const related = request.relatedError;
            document.getElementById("relatedErrorSummary").textContent = related.errorMessage || related.errorType || "Stored upstream error";
            document.getElementById("relatedErrorLink").href = `/admin/errors?error=${encodeURIComponent(related.id)}`;
        }
    } catch (error) {
        document.getElementById("detailSubtitle").textContent = error.message;
    }
}

function closeDetail() { detailBackdrop.classList.remove("open"); document.body.style.overflow = ""; }
function closeDetailFromBackdrop(event) { if (event.target === detailBackdrop) closeDetail(); }

document.addEventListener("keydown", (event) => { if (event.key === "Escape" && detailBackdrop.classList.contains("open")) closeDetail(); });
for (const id of ["apiKeyFilter", "modelFilter", "statusFilter", "timeFilter"]) document.getElementById(id).addEventListener("change", () => loadPage({ reset: true }));
document.getElementById("refreshButton").addEventListener("click", () => loadPage({ reset: true }));
document.getElementById("resetButton").addEventListener("click", () => {
    for (const id of ["apiKeyFilter", "modelFilter", "statusFilter", "timeFilter"]) document.getElementById(id).value = "";
    loadPage({ reset: true });
});
historyState.observer = new IntersectionObserver((entries) => { if (entries.some((entry) => entry.isIntersecting)) loadPage(); }, { rootMargin: "300px" });
historyState.observer.observe(document.getElementById("requestHistorySentinel"));
loadFilters().then(() => loadPage({ reset: true })).catch((error) => setState(error.message, "error"));
