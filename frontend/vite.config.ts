import { svelte } from "@sveltejs/vite-plugin-svelte";
import { defineConfig } from "vite";
import { fileURLToPath, URL } from "node:url";

export default defineConfig({
  root: fileURLToPath(new URL(".", import.meta.url)),
  base: "/assets/app/",
  appType: "custom",
  plugins: [svelte()],
  resolve: {
    alias: {
      $frontend: fileURLToPath(new URL("./src", import.meta.url)),
      $contracts: fileURLToPath(new URL("../shared/contracts", import.meta.url)),
    },
  },
  build: {
    outDir: fileURLToPath(new URL("../dist/frontend", import.meta.url)),
    emptyOutDir: true,
    rollupOptions: {
      input: {
        public: fileURLToPath(new URL("./public.html", import.meta.url)),
        admin: fileURLToPath(new URL("./admin.html", import.meta.url)),
        login: fileURLToPath(new URL("./login.html", import.meta.url)),
      },
    },
  },
});
