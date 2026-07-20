const state = {
    limit: 25,
    offset: 0,
    total: 0,
    loading: false,
};

const tableBody = document.getElementById("errorsTableBody");
const modelFilter = document.getElementById("modelFilter");
const endpointFilter = document.getElementById("endpointFilter");
const statusFilter = document.getElementById("statusFilter");
const keyFilter = document.getElementById("keyFilter");
const detailBackdrop = document.getElementById("detailBackdrop");

async function apiFetch(url, options = {}) {
    const response = await fetch(url, options);
    if (response.status === 401 || response.status === 403) {
        window.location.href = "/admin/login";
        throw new Error("Admin session expired");
    }

    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
        throw new Error(data.error || `Request failed (${response.status})`);
    }
    return data;
}

function appendOptions(select, values, formatter = (value) => value) {
    for (const value of values) {
        const option = document.createElement("option");
        option.value = String(value);
        option.textContent = formatter(value);
        select.appendChild(option);
    }
}

async function loadFilters() {
    const current = {
        model: modelFilter.value,
        endpoint: endpointFilter.value,
        status: statusFilter.value,
        key: keyFilter.value,
    };
    const data = await apiFetch("/api/errors/filters");

    modelFilter.length = 1;
    endpointFilter.length = 1;
    statusFilter.length = 1;
    keyFilter.length = 1;
    appendOptions(modelFilter, data.models || []);
    appendOptions(endpointFilter, data.endpoints || []);
    appendOptions(statusFilter, data.statuses || [], (value) => `HTTP ${value}`);
    appendOptions(keyFilter, data.keys || []);

    modelFilter.value = current.model;
    endpointFilter.value = current.endpoint;
    statusFilter.value = current.status;
    keyFilter.value = current.key;
}

function buildListUrl() {
    const params = new URLSearchParams({
        limit: String(state.limit),
        offset: String(state.offset),
    });
    if (modelFilter.value) params.set("model", modelFilter.value);
    if (endpointFilter.value) params.set("endpoint", endpointFilter.value);
    if (statusFilter.value) params.set("status", statusFilter.value);
    if (keyFilter.value) params.set("key", keyFilter.value);
    return `/api/errors?${params.toString()}`;
}

function showTableState(type, message) {
    tableBody.replaceChildren();
    const row = document.createElement("tr");
    const cell = document.createElement("td");
    cell.colSpan = 7;
    cell.className = "table-state";

    if (type === "loading") {
        const spinner = document.createElement("div");
        spinner.className = "spinner";
        cell.appendChild(spinner);
    } else {
        const icon = document.createElement("i");
        icon.className =
            type === "error"
                ? "fa-solid fa-circle-exclamation"
                : "fa-solid fa-shield-halved";
        cell.appendChild(icon);
    }

    const text = document.createElement("p");
    text.textContent = message;
    cell.appendChild(text);
    row.appendChild(cell);
    tableBody.appendChild(row);
}

function addTextCell(row, value, className = "") {
    const cell = document.createElement("td");
    if (className) cell.className = className;
    cell.textContent = value ?? "—";
    cell.title = value ?? "";
    row.appendChild(cell);
    return cell;
}

function statusClass(statusCode) {
    if (!statusCode) return "network";
    if (statusCode >= 500) return "server";
    if (statusCode >= 400) return "client";
    return "network";
}

function formatTimestamp(timestamp) {
    if (!timestamp) return "—";
    const date = new Date(timestamp);
    if (Number.isNaN(date.getTime())) return String(timestamp);
    return date.toLocaleString();
}

function renderErrors(errors) {
    tableBody.replaceChildren();
    if (!errors.length) {
        showTableState("empty", "No stored errors match these filters.");
        return;
    }

    for (const error of errors) {
        const row = document.createElement("tr");
        row.tabIndex = 0;
        row.setAttribute("aria-label", `Inspect error ${error.id}`);
        row.addEventListener("click", () => openDetail(error.id));
        row.addEventListener("keydown", (event) => {
            if (event.key === "Enter" || event.key === " ") {
                event.preventDefault();
                openDetail(error.id);
            }
        });

        addTextCell(row, formatTimestamp(error.timestamp), "timestamp");

        const statusCell = document.createElement("td");
        const badge = document.createElement("span");
        badge.className = `status-badge ${statusClass(error.statusCode)}`;
        badge.textContent = error.statusCode || "N/A";
        statusCell.appendChild(badge);
        row.appendChild(statusCell);

        addTextCell(row, error.model, "primary-cell");
        addTextCell(row, error.upstreamModel, "secondary-cell");
        addTextCell(row, error.endpointName, "secondary-cell");

        const typeCell = document.createElement("td");
        const type = document.createElement("span");
        type.className = "type-label";
        type.textContent = error.errorType || error.errorCode || "Error";
        typeCell.appendChild(type);
        row.appendChild(typeCell);

        addTextCell(row, error.errorMessage, "message-cell");
        tableBody.appendChild(row);
    }
}

function updatePagination() {
    const start = state.total === 0 ? 0 : state.offset + 1;
    const end = Math.min(state.offset + state.limit, state.total);
    document.getElementById("errorCount").textContent =
        `${state.total.toLocaleString()} ${state.total === 1 ? "error" : "errors"}`;
    document.getElementById("pageSummary").textContent =
        state.total === 0
            ? "Showing 0 errors"
            : `Showing ${start.toLocaleString()}–${end.toLocaleString()} of ${state.total.toLocaleString()}`;
    document.getElementById("previousButton").disabled =
        state.loading || state.offset === 0;
    document.getElementById("nextButton").disabled =
        state.loading || state.offset + state.limit >= state.total;
}

async function loadErrors() {
    if (state.loading) return;
    state.loading = true;
    showTableState("loading", "Loading stored errors…");
    updatePagination();

    try {
        const data = await apiFetch(buildListUrl());
        state.total = data.total || 0;

        if (state.offset >= state.total && state.offset > 0) {
            state.offset = Math.max(
                0,
                Math.floor(Math.max(state.total - 1, 0) / state.limit) *
                    state.limit,
            );
            state.loading = false;
            return loadErrors();
        }

        renderErrors(data.errors || []);
    } catch (error) {
        console.error("Error loading stored errors:", error);
        showTableState("error", error.message || "Could not load errors.");
    } finally {
        state.loading = false;
        updatePagination();
    }
}

async function openDetail(id) {
    detailBackdrop.classList.add("open");
    document.body.style.overflow = "hidden";
    document.getElementById("detailTitle").textContent = `Error #${id}`;
    document.getElementById("detailSubtitle").textContent = "Loading stored context…";

    try {
        const { error } = await apiFetch(`/api/errors/${id}`);
        document.getElementById("detailTitle").textContent =
            `${error.errorType || "Error"} · #${error.id}`;
        document.getElementById("detailSubtitle").textContent =
            error.errorCode || error.errorMessage || "Stored upstream failure";
        setText("detailTimestamp", formatTimestamp(error.timestamp));
        setText("detailRequestId", error.requestId);
        setText("detailStatus", error.statusCode ? `HTTP ${error.statusCode}` : "No response");
        setText("detailApiFormat", error.apiFormat);
        setText("detailApiKey", error.maskedApiKey);
        setText("detailModel", error.model);
        setText("detailUpstreamModel", error.upstreamModel);
        setText("detailAutoModel", error.autoModel);
        setText("detailTargetModel", error.targetModel);
        setText(
            "detailEndpoint",
            [error.endpointName, error.endpointKey]
                .filter(Boolean)
                .join(" · "),
        );
        setText("detailUrl", error.upstreamUrl);
        setText("detailMessage", error.errorMessage);
        setJson("detailRoutingAttempts", error.routingAttempts);
        setJson("detailHeaders", error.requestHeaders);
        setJson("detailResponse", error.responseBody);
        setText("detailStack", error.stackTrace);
    } catch (error) {
        document.getElementById("detailSubtitle").textContent = error.message;
        setText("detailMessage", "Unable to load this stored error.");
    }
}

function setText(id, value) {
    document.getElementById(id).textContent = value || "Not available";
}

function setJson(id, value) {
    document.getElementById(id).textContent =
        value === null || value === undefined
            ? "Not available"
            : JSON.stringify(value, null, 2);
}

function closeDetail() {
    detailBackdrop.classList.remove("open");
    document.body.style.overflow = "";
}

function closeDetailFromBackdrop(event) {
    if (event.target === detailBackdrop) closeDetail();
}

function applyFilters() {
    state.offset = 0;
    loadErrors();
}

async function refreshErrors() {
    await Promise.all([loadFilters(), loadErrors()]);
}

function previousPage() {
    if (state.offset === 0) return;
    state.offset = Math.max(0, state.offset - state.limit);
    loadErrors();
}

function nextPage() {
    if (state.offset + state.limit >= state.total) return;
    state.offset += state.limit;
    loadErrors();
}

async function clearErrors() {
    if (state.total === 0) return;
    const confirmed = window.confirm(
        `Permanently delete ${state.total.toLocaleString()} stored ${state.total === 1 ? "error" : "errors"}?`,
    );
    if (!confirmed) return;

    try {
        await apiFetch("/api/errors", { method: "DELETE" });
        state.offset = 0;
        await Promise.all([loadFilters(), loadErrors()]);
    } catch (error) {
        window.alert(error.message || "Could not clear stored errors.");
    }
}

document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && detailBackdrop.classList.contains("open")) {
        closeDetail();
    }
});

function setKeyFilter(maskedKey) {
    if (!maskedKey) return;
    const exists = Array.from(keyFilter.options).some(
        (option) => option.value === maskedKey,
    );
    if (!exists) {
        appendOptions(keyFilter, [maskedKey]);
    }
    keyFilter.value = maskedKey;
}

async function init() {
    const params = new URLSearchParams(window.location.search);
    const deepLinkKey = params.get("key");
    const deepLinkError = params.get("error");
    await loadFilters();
    if (deepLinkKey) {
        setKeyFilter(deepLinkKey);
        state.offset = 0;
    }
    await loadErrors();
    if (deepLinkError && /^\d+$/.test(deepLinkError)) {
        await openDetail(Number(deepLinkError));
    }
}

init().catch((error) => {
    console.error("Error initializing stored errors page:", error);
});
