// Shared helpers used across admin and public pages.
// Load before the per-page script: <script src="shared.js"></script>
// Note: settings.html defines its own showToast (different toast markup) which
// intentionally overrides the one below.

async function logout() {
  await fetch("/admin/logout", { method: "POST" }).catch(() => {});
  window.location.href = "/admin/login";
}

function escapeHtml(text) {
  const div = document.createElement("div");
  div.textContent = text;
  return div.innerHTML;
}

function formatNumber(num) {
  if (num >= 1000000000) return (num / 1000000000).toFixed(1) + "B";
  if (num >= 1000000) return (num / 1000000).toFixed(1) + "M";
  if (num >= 1000) return (num / 1000).toFixed(1) + "K";
  return num.toLocaleString();
}

function showToast(message, type = "success") {
  const toast = document.getElementById("toast");
  if (!toast) return;
  toast.className = `toast ${type}`;
  toast.innerHTML = `
    <i class="fa-solid fa-${type === "success" ? "check-circle" : "exclamation-circle"}"></i>
    ${message}
  `;
  toast.classList.add("show");

  setTimeout(() => {
    toast.classList.remove("show");
  }, 3000);
}
