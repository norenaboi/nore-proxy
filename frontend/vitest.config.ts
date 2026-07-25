import { svelte } from "@sveltejs/vite-plugin-svelte";
import { defineConfig } from "vitest/config";
import { fileURLToPath, URL } from "node:url";

export default defineConfig({
  plugins: [svelte()],
  resolve: {
    alias: {
      $frontend: fileURLToPath(new URL("./src", import.meta.url)),
      $contracts: fileURLToPath(new URL("../shared/contracts", import.meta.url)),
    },
  },
  test: {
    environment: "node",
  },
});
