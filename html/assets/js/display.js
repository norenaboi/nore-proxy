let allModels = [];
let searchQuery = "";
let activeFilters = new Set();
const iconCache = new Map();
const MODEL_CACHE_KEY = "nore-proxy:model-catalog:v1";

// Preload icons to prevent delayed loading
function preloadIcon(url) {
    if (iconCache.has(url)) {
        return iconCache.get(url);
    }

    return new Promise((resolve) => {
        const img = new Image();
        img.onload = () => {
            iconCache.set(url, url);
            resolve(url);
        };
        img.onerror = () => {
            iconCache.set(url, null);
            resolve(null);
        };
        img.src = url;
    });
}

async function preloadAllIcons() {
    const providers = [
        "Anthropic",
        "Google",
        "OpenAI",
        "DeepSeek",
        "ZhipuAI",
        "xAI",
        "MoonshotAI",
        "Qwen",
        "Others",
    ];
    const promises = providers.map((provider) =>
        preloadIcon(getProviderIcon(provider)),
    );
    await Promise.all(promises);
}

function getProvider(modelId) {
    const lowerName = modelId.toLowerCase();

    if (
        lowerName.includes("gemini") ||
        lowerName.includes("google") ||
        lowerName.includes("gemma") ||
        lowerName.includes("veo") ||
        lowerName.includes("nanobanana")
    ) {
        return "Google";
    } else if (
        lowerName.includes("claude") ||
        lowerName.includes("sonnet") ||
        lowerName.includes("fable") ||
        lowerName.includes("mythos") ||
        lowerName.includes("kiro") ||
        lowerName.includes("opus")
    ) {
        return "Anthropic";
    } else if (
        lowerName.includes("gpt") ||
        lowerName.includes("chatgpt") ||
        lowerName.startsWith("o")
    ) {
        return "OpenAI";
    } else if (lowerName.includes("deepseek")) {
        return "DeepSeek";
    } else if (lowerName.includes("glm")) {
        return "ZhipuAI";
    } else if (lowerName.includes("grok")) {
        return "xAI";
    } else if (lowerName.includes("kimi")) {
        return "MoonshotAI";
    } else if (lowerName.includes("qwen")) {
        return "Qwen";
    } else {
        return "Others";
    }
}

function getProviderIcon(provider) {
    const icons = {
        Anthropic: "/icons/providers/anthropic.png",
        Google: "/icons/providers/google.png",
        OpenAI: "/icons/providers/openai.png",
        DeepSeek: "/icons/providers/deepseek.png",
        ZhipuAI: "/icons/providers/zhipuai.png",
        xAI: "/icons/providers/xai.png",
        MoonshotAI: "/icons/providers/moonshot.png",
        Qwen: "/icons/providers/qwen.png",
        Others: "/icons/providers/other.png",
    };
    return icons[provider] || icons.Others;
}

function formatPrice(value) {
    const n = Number(value) || 0;
    if (n === 0) return "$0.00";
    if (n >= 0.1) return `$${n.toFixed(2)}`;
    return `$${parseFloat(n.toPrecision(2))}`;
}

function escapeHtml(str) {
    return String(str).replace(/[&<>"']/g, (c) => ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&#39;",
    })[c]);
}

function highlight(text, query) {
    if (!query) return escapeHtml(text);
    const idx = text.toLowerCase().indexOf(query.toLowerCase());
    if (idx === -1) return escapeHtml(text);
    return (
        escapeHtml(text.slice(0, idx)) +
        "<mark>" +
        escapeHtml(text.slice(idx, idx + query.length)) +
        "</mark>" +
        escapeHtml(text.slice(idx + query.length))
    );
}

function getFilteredModels() {
    const query = searchQuery.trim().toLowerCase();
    return allModels.filter(
        (model) =>
            (activeFilters.size === 0 || activeFilters.has(model.provider)) &&
            (!query ||
                model.id.toLowerCase().includes(query) ||
                model.provider.toLowerCase().includes(query)),
    );
}

function renderFilters() {
    const providerCounts = {};
    allModels.forEach((model) => {
        providerCounts[model.provider] =
            (providerCounts[model.provider] || 0) + 1;
    });

    const providers = Object.keys(providerCounts).sort();
    const filtersList = document.getElementById("filters-list");

    filtersList.innerHTML = providers
        .map(
            (provider) => `
        <button class="chip ${activeFilters.has(provider) ? "active" : ""}" data-provider="${escapeHtml(provider)}" type="button">
            <img src="${getProviderIcon(provider)}" class="chip-icon" alt="" onerror="this.style.display='none'" />
            ${escapeHtml(provider)} <span class="count">${providerCounts[provider]}</span>
        </button>
    `,
        )
        .join("");
}

function toggleFilter(provider) {
    if (activeFilters.has(provider)) {
        activeFilters.delete(provider);
    } else {
        activeFilters.add(provider);
    }
    renderFilters();
    renderGrid();
}

function priceItem(label, value) {
    return `
        <div class="price-item">
            <span class="label">${label}</span>
            <span class="value">${formatPrice(value)} <small>/M</small></span>
        </div>
    `;
}

function renderGrid() {
    const grid = document.getElementById("model-grid");
    const models = getFilteredModels().sort((a, b) =>
        a.id.localeCompare(b.id),
    );
    const query = searchQuery.trim();

    document.getElementById("result-meta").textContent =
        `${models.length} of ${allModels.length} models`;

    if (models.length === 0) {
        grid.innerHTML = `
            <div class="no-results">
                <i class="fa-solid fa-filter fa-2x" style="color: #ccc"></i>
                <p style="margin-top: 15px">No models match ${query ? `<strong>${escapeHtml(query)}</strong>` : "your filters"}</p>
            </div>
        `;
        return;
    }

    grid.innerHTML = models
        .map(
            (model) => `
        <article class="model-card panel" data-model="${escapeHtml(model.id)}" tabindex="0" role="button" aria-label="Copy ${escapeHtml(model.id)}">
            <div class="card-top">
                <img src="${getProviderIcon(model.provider)}" class="model-icon" alt="${escapeHtml(model.provider)}" onerror="this.style.display='none'" />
                <div class="card-id">
                    <span class="model-name" title="${escapeHtml(model.id)}">${highlight(model.id, query)}</span>
                    <span class="provider">${escapeHtml(model.provider)}</span>
                </div>
            </div>
            <button class="card-copy" type="button">Copy</button>
            <div class="price-grid">
                ${priceItem("Input", model.pricing?.input)}
                ${priceItem("Output", model.pricing?.output)}
                ${priceItem("Cache Write", model.pricing?.cache_write)}
                ${priceItem("Cache Read", model.pricing?.cache_read)}
            </div>
        </article>
    `,
        )
        .join("");
}

function copyModelName(modelId) {
    navigator.clipboard.writeText(modelId);
    showNotification();
}

function showNotification() {
    const notif = document.getElementById("notification");
    notif.classList.add("show");
    setTimeout(() => {
        notif.classList.remove("show");
    }, 2000);
}

function normalizeModels(models) {
    if (!Array.isArray(models)) return [];

    return models
        .map((model) => {
            const modelId =
                typeof model === "string"
                    ? model
                    : model?.id || model?.name || model?.model;
            if (typeof modelId !== "string" || !modelId) return null;

            const sourcePricing =
                typeof model === "object" && model?.pricing
                    ? model.pricing
                    : {};
            return {
                id: modelId,
                pricing: {
                    input: Number(sourcePricing.input) || 0,
                    output: Number(sourcePricing.output) || 0,
                    cache_write: Number(sourcePricing.cache_write) || 0,
                    cache_read: Number(sourcePricing.cache_read) || 0,
                },
            };
        })
        .filter(Boolean)
        .sort((a, b) => a.id.localeCompare(b.id));
}

function readModelCache() {
    try {
        const cached = JSON.parse(localStorage.getItem(MODEL_CACHE_KEY));
        if (cached?.version !== 1) return null;
        const models = normalizeModels(cached.models);
        return models.length ? models : null;
    } catch {
        return null;
    }
}

function writeModelCache(models) {
    try {
        localStorage.setItem(
            MODEL_CACHE_KEY,
            JSON.stringify({ version: 1, models }),
        );
    } catch (error) {
        console.warn("Could not cache model catalog", error);
    }
}

function applyModels(models) {
    allModels = models.map((model) => ({
        ...model,
        provider: getProvider(model.id),
    }));

    const availableProviders = new Set(
        allModels.map((model) => model.provider),
    );
    activeFilters = new Set(
        [...activeFilters].filter((provider) =>
            availableProviders.has(provider),
        ),
    );

    renderFilters();
    renderGrid();
    preloadAllIcons();
}

function renderModelLoadError() {
    document.getElementById("model-grid").innerHTML = `
        <div class="no-results">
            <i class="fa-solid fa-triangle-exclamation fa-2x" style="color: #e74c3c"></i>
            <p style="margin-top: 15px">Failed to load models</p>
        </div>
    `;
}

async function loadModels() {
    const cachedModels = readModelCache();
    if (cachedModels) applyModels(cachedModels);

    try {
        const response = await fetch("/v1/models", { cache: "no-store" });
        if (!response.ok) throw new Error(`Model request failed: ${response.status}`);

        const data = await response.json();
        const freshModels = normalizeModels(data.data || data.models || data);

        if (freshModels.length === 0) {
            if (!cachedModels) {
                document.getElementById("model-grid").innerHTML = `
                    <div class="no-results">
                        <i class="fa-solid fa-skull-crossbones fa-2x" style="color: #ccc"></i>
                        <p style="margin-top: 15px">No models found</p>
                    </div>
                `;
            }
            return;
        }

        if (JSON.stringify(freshModels) !== JSON.stringify(cachedModels)) {
            writeModelCache(freshModels);
            applyModels(freshModels);
        }
    } catch (error) {
        console.error("Failed to fetch models", error);
        if (!cachedModels) renderModelLoadError();
    }
}

function setupInteractions() {
    const searchEl = document.getElementById("model-search");
    const searchWrap = document.getElementById("search-wrap");

    searchEl.addEventListener("input", () => {
        searchQuery = searchEl.value;
        searchWrap.classList.toggle("has-value", !!searchQuery);
        renderGrid();
    });

    document.getElementById("search-clear").addEventListener("click", () => {
        searchEl.value = "";
        searchEl.dispatchEvent(new Event("input"));
        searchEl.focus();
    });

    document.addEventListener("keydown", (event) => {
        if (event.key === "/" && document.activeElement !== searchEl) {
            event.preventDefault();
            searchEl.focus();
        }
    });

    document.getElementById("filters-list").addEventListener("click", (event) => {
        const chip = event.target.closest(".chip");
        if (chip) toggleFilter(chip.dataset.provider);
    });

    const grid = document.getElementById("model-grid");
    grid.addEventListener("click", (event) => {
        const card = event.target.closest(".model-card");
        if (card) copyModelName(card.dataset.model);
    });
    grid.addEventListener("keydown", (event) => {
        if (event.key !== "Enter") return;
        const card = event.target.closest(".model-card");
        if (card) copyModelName(card.dataset.model);
    });
}

document.addEventListener("DOMContentLoaded", () => {
    setupInteractions();
    loadModels();
});
