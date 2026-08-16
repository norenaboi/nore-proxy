import { writable } from "svelte/store";

type ToastType = "success" | "error";
interface Toast { id: number; message: string; type: ToastType }

function createToastStore() {
  const { subscribe, update } = writable<Toast[]>([]);
  let next = 0;
  return {
    subscribe,
    show(message: string, type: ToastType = "success") {
      const id = ++next;
      update((toasts) => [...toasts, { id, message, type }]);
      setTimeout(() => update((toasts) => toasts.filter((t) => t.id !== id)), 3500);
    },
  };
}

export const toast = createToastStore();

export type DashboardRange = "24h" | "7d" | "30d" | "total";
export const dashboardRange = writable<DashboardRange>("24h");

export interface PageHeaderActions {
  count: number;
  noun: string;
  icon: string;
  addLabel: string;
  onAdd: () => void;
}
export const pageHeaderActions = writable<PageHeaderActions | null>(null);

function createThemeStore() {
  const saved = typeof localStorage !== "undefined" ? (localStorage.getItem("admin-theme") ?? "light") : "light";
  if (typeof document !== "undefined") document.documentElement.setAttribute("data-theme", saved);
  const { subscribe, set } = writable<string>(saved);
  return {
    subscribe,
    // The segmented toggle picks a theme outright rather than flipping the
    // current one.
    select(next: string) {
      const value = next === "dark" ? "dark" : "light";
      if (typeof document !== "undefined") document.documentElement.setAttribute("data-theme", value);
      try {
        localStorage.setItem("admin-theme", value);
      } catch {
        // The selected appearance still applies when browser storage is unavailable.
      }
      set(value);
    },
    init() {
      const t = localStorage.getItem("admin-theme") ?? "light";
      document.documentElement.setAttribute("data-theme", t);
      set(t);
    },
  };
}

export const theme = createThemeStore();
