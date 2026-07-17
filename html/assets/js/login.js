async function login(event) {
    event.preventDefault();
    const masterKey = document.getElementById("masterKey").value;
    const errorEl = document.getElementById("error");
    errorEl.style.display = "none";

    try {
        const res = await fetch("/admin/login", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ masterKey }),
        });

        if (res.ok) {
            window.location.href = "/admin/dashboard";
        } else {
            const data = await res.json().catch(() => ({}));
            errorEl.textContent =
                data.error || "Invalid master key";
            errorEl.style.display = "block";
        }
    } catch (err) {
        errorEl.textContent = "Network error. Please try again.";
        errorEl.style.display = "block";
    }
}
