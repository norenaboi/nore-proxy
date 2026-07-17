async function checkUsage() {
    const apiKey = document.getElementById("apiKey").value;
    const loading = document.getElementById("loading");
    const error = document.getElementById("error");
    const stats = document.getElementById("stats-section");

    // Reset displays
    error.classList.remove("show");
    stats.classList.remove("show");

    if (!apiKey) {
        error.textContent = "Error: Can't find API Key";
        error.classList.add("show");
        return;
    }

    loading.classList.add("show");

    try {
        const response = await fetch("/api/usage", {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                Authorization: "Bearer " + apiKey,
            },
        });

        loading.classList.remove("show");

        if (!response.ok) {
            const data = await response.json();
            if (response.status === 429) {
                throw new Error(
                    data.detail ||
                        "Too many requests. Please wait and try again.",
                );
            }
            throw new Error(data.detail || "Error: Request Denied");
        }

        const data = await response.json();

        // Update stats display
        document.getElementById("name").textContent =
            data.usage.name.toLocaleString();
        document.getElementById("total_requests").textContent =
            data.usage.total_requests.toLocaleString();
        document.getElementById("quota").textContent =
            data.usage.daily_requests.toLocaleString() +
            " / " +
            data.usage.rate_limit.toLocaleString();
        document.getElementById("input_total").textContent =
            data.usage.total_input_tokens.toLocaleString();
        document.getElementById("output_total").textContent =
            data.usage.total_output_tokens.toLocaleString();
        document.getElementById("input_24h").textContent =
            data.usage.daily_input_tokens.toLocaleString();
        document.getElementById("output_24h").textContent =
            data.usage.daily_output_tokens.toLocaleString();

        statDiv = document.getElementById("status");

        if (data.usage.active.toLocaleString() == "true") {
            statDiv.className = "stat-value active";
            statDiv.textContent = "Active";
        } else {
            statDiv.className = "stat-value inactive";
            statDiv.textContent = "Inactive";
        }

        stats.classList.add("show");
    } catch (err) {
        loading.classList.remove("show");
        error.textContent = err.message;
        error.classList.add("show");
    }
}

// Allow checking with Enter key
document
    .getElementById("apiKey")
    .addEventListener("keypress", function (e) {
        if (e.key === "Enter") {
            checkUsage();
        }
    });
