let modelsData = [];
let sortColumn = "total_tokens";
let sortDirection = "desc";

async function loadModelUsage() {
    try {
        const response = await fetch("/api/model-usage");
        const data = await response.json();

        modelsData = data.models.map((model) => ({
            ...model,
            cost: model.cost || 0,
            cache_tokens:
                model.cache_write_tokens + model.cache_read_tokens,
        }));

        sortAndRenderTable();

        document.getElementById("loading").style.display = "none";
        document.getElementById("content").style.display = "block";
    } catch (error) {
        console.error("Error loading model usage:", error);
        document.getElementById("loading").innerHTML =
            '<div class="empty-state"><i class="fa-solid fa-exclamation-triangle"></i><p>Error loading model usage</p></div>';
    }
}

function sortTable(column) {
    if (sortColumn === column) {
        sortDirection = sortDirection === "asc" ? "desc" : "asc";
    } else {
        sortColumn = column;
        sortDirection = "desc";
    }

    // Update header classes
    document.querySelectorAll("th.sortable").forEach((th) => {
        th.classList.remove("sorted-asc", "sorted-desc");
    });

    const header = event.target;
    header.classList.add(
        sortDirection === "asc" ? "sorted-asc" : "sorted-desc",
    );

    sortAndRenderTable();
}

function sortAndRenderTable() {
    // Sort the data
    const sorted = [...modelsData].sort((a, b) => {
        let aVal, bVal;

        switch (sortColumn) {
            case "model":
                aVal = a.model;
                bVal = b.model;
                break;
            case "requests":
                aVal = a.requests;
                bVal = b.requests;
                break;
            case "input_tokens":
                aVal = a.input_tokens;
                bVal = b.input_tokens;
                break;
            case "output_tokens":
                aVal = a.output_tokens;
                bVal = b.output_tokens;
                break;
            case "cache_tokens":
                aVal = a.cache_tokens;
                bVal = b.cache_tokens;
                break;
            case "total_tokens":
                aVal = a.total_tokens;
                bVal = b.total_tokens;
                break;
            case "cost":
                aVal = a.cost;
                bVal = b.cost;
                break;
            case "errors":
                aVal = a.errors;
                bVal = b.errors;
                break;
            default:
                aVal = a.total_tokens;
                bVal = b.total_tokens;
        }

        if (sortColumn === "model") {
            return sortDirection === "asc"
                ? aVal.localeCompare(bVal)
                : bVal.localeCompare(aVal);
        } else {
            return sortDirection === "asc"
                ? aVal - bVal
                : bVal - aVal;
        }
    });

    renderTable(sorted);
}

function renderTable(models) {
    const tbody = document.getElementById("modelsTableBody");

    if (models.length === 0) {
        tbody.innerHTML =
            '<tr><td colspan="9" class="empty-state"><i class="fa-solid fa-inbox"></i><p>No model usage data available</p></td></tr>';
        return;
    }

    tbody.innerHTML = models
        .map((model, index) => {
            const rank = index + 1;
            const rankClass =
                rank === 1
                    ? "top-1"
                    : rank === 2
                      ? "top-2"
                      : rank === 3
                        ? "top-3"
                        : "other";

            return `
            <tr>
                <td>
                    <div class="rank-badge ${rankClass}">${rank}</div>
                </td>
                <td>
                    <div class="model-name">${escapeHtml(model.model)}</div>
                </td>
                <td>
                    <span class="metric-value requests">${model.requests.toLocaleString()}</span>
                </td>
                <td>
                    <span class="metric-value tokens">${formatNumber(model.input_tokens)}</span>
                </td>
                <td>
                    <span class="metric-value tokens">${formatNumber(model.output_tokens)}</span>
                </td>
                <td>
                    <span class="metric-value tokens" title="Write: ${formatNumber(model.cache_write_tokens)}, Read: ${formatNumber(model.cache_read_tokens)}">${formatNumber(model.cache_tokens)}</span>
                </td>
                <td>
                    <span class="metric-value tokens">${formatNumber(model.total_tokens)}</span>
                </td>
                <td>
                    <span class="metric-value">$${model.cost.toFixed(2)}</span>
                </td>
                <td>
                    <span class="metric-value errors">${model.errors.toLocaleString()}</span>
                </td>
            </tr>
        `;
        })
        .join("");
}

// Load model usage on page load
loadModelUsage();
