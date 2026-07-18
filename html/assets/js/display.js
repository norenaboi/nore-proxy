let allModels = [];
let filteredModels = [];
let currentSort = { column: "name", direction: "asc" };
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
    if (value == null || value === "" || value === 0) {
        return "$0.00";
    }
    const n = parseFloat(value);
    if (n === 0) return "$0.00";
    return `$${n.toFixed(3)}`;
}

function sortModels(models, column, direction) {
    return [...models].sort((a, b) => {
        let aVal, bVal;

        if (column === "name") {
            aVal = a.id.toLowerCase();
            bVal = b.id.toLowerCase();
        } else if (column === "provider") {
            aVal = a.provider.toLowerCase();
            bVal = b.provider.toLowerCase();
        } else if (column === "price") {
            // Sort by input price
            aVal = a.pricing?.input || 0;
            bVal = b.pricing?.input || 0;
        }

        if (aVal < bVal) return direction === "asc" ? -1 : 1;
        if (aVal > bVal) return direction === "asc" ? 1 : -1;
        return 0;
    });
}

function filterModels() {
    if (activeFilters.size === 0) {
        filteredModels = allModels;
    } else {
        filteredModels = allModels.filter((model) =>
            activeFilters.has(model.provider),
        );
    }
    renderTable();
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
        <div class="filter-item" onclick="toggleFilter('${provider}')">
            <input
                type="checkbox"
                class="filter-checkbox"
                id="filter-${provider}"
                ${activeFilters.has(provider) ? "checked" : ""}
            />
            <img src="${getProviderIcon(provider)}" class="filter-icon" alt="${provider}" onerror="this.style.display='none'" />
            <span class="filter-label">${provider}</span>
            <span class="filter-count">${providerCounts[provider]}</span>
        </div>
    `,
        )
        .join("");
}

function toggleFilter(provider) {
    const checkbox = document.getElementById(`filter-${provider}`);

    if (activeFilters.has(provider)) {
        activeFilters.delete(provider);
        checkbox.checked = false;
    } else {
        activeFilters.add(provider);
        checkbox.checked = true;
    }

    filterModels();
}

function renderTable() {
    const container = document.getElementById("table-container");
    const sorted = sortModels(
        filteredModels,
        currentSort.column,
        currentSort.direction,
    );

    if (sorted.length === 0) {
        container.innerHTML = `
            <div class="no-results">
                <i class="fa-solid fa-filter fa-2x" style="color: #ccc"></i>
                <p style="margin-top: 15px">No models match your filters</p>
            </div>
        `;
        return;
    }

    const tableHTML = `
        <table class="models-table">
            <thead>
                <tr>
                    <th onclick="sortBy('name')" class="${currentSort.column === "name" ? "sorted-" + currentSort.direction : ""}">
                        Model <span class="sort-icon"></span>
                    </th>
                    <th onclick="sortBy('provider')" class="${currentSort.column === "provider" ? "sorted-" + currentSort.direction : ""}">
                        Provider <span class="sort-icon"></span>
                    </th>
                    <th onclick="sortBy('price')" class="${currentSort.column === "price" ? "sorted-" + currentSort.direction : ""}">
                        Pricing <span class="sort-icon"></span>
                    </th>
                    <th style="width: 50px;"></th>
                </tr>
            </thead>
            <tbody>
                ${sorted
                    .map(
                        (model) => `
                    <tr onclick="copyModelName('${model.id}', event)">
                        <td>
                            <div class="model-name-cell">
                                <img src="${getProviderIcon(model.provider)}" class="model-icon" alt="${model.provider}" onerror="this.style.display='none'" />
                                <span class="model-name">${model.id}</span>
                            </div>
                        </td>
                        <td class="provider-cell">${model.provider}</td>
                        <td>
                            <div class="pricing-cell">
                                <div class="price-item">
                                    <span class="price-label">Input</span>
                                    <span class="price-value">${formatPrice(model.pricing?.input)}/M tokens</span>
                                </div>
                                <div class="price-item">
                                    <span class="price-label">Output</span>
                                    <span class="price-value">${formatPrice(model.pricing?.output)}/M tokens</span>
                                </div>
                                ${
                                    model.pricing?.cache_write !=
                                        null &&
                                    model.pricing.cache_write !== 0
                                        ? `
                                <div class="price-item">
                                    <span class="price-label">Cache Write</span>
                                    <span class="price-value">${formatPrice(model.pricing.cache_write)}/M tokens</span>
                                </div>`
                                        : ""
                                }
                                ${
                                    model.pricing?.cache_read !=
                                        null &&
                                    model.pricing.cache_read !== 0
                                        ? `
                                <div class="price-item">
                                    <span class="price-label">Cache Read</span>
                                    <span class="price-value">${formatPrice(model.pricing.cache_read)}/M tokens</span>
                                </div>`
                                        : ""
                                }
                            </div>
                        </td>
                        <td style="text-align: center;">
                            <i class="fa-regular fa-copy copy-icon"></i>
                        </td>
                    </tr>
                `,
                    )
                    .join("")}
            </tbody>
        </table>
    `;

    container.innerHTML = tableHTML;
}

function sortBy(column) {
    if (currentSort.column === column) {
        currentSort.direction =
            currentSort.direction === "asc" ? "desc" : "asc";
    } else {
        currentSort.column = column;
        currentSort.direction = "asc";
    }
    renderTable();
}

function copyModelName(modelId, event) {
    navigator.clipboard.writeText(modelId);
    showNotification();

    const row = event.currentTarget;
    row.style.background = "rgba(212, 175, 55, 0.2)";
    setTimeout(() => {
        row.style.background = "";
    }, 300);
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
    filterModels();
    preloadAllIcons();
}

function renderModelLoadError() {
    document.getElementById("table-container").innerHTML = `
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
                document.getElementById("table-container").innerHTML = `
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

document.addEventListener("DOMContentLoaded", loadModels);
