import { defineConfig } from "vite";
import { resolve } from "node:path";

export default defineConfig({
  root: "src",
  publicDir: "../public",
  build: {
    outDir: "../dist",
    emptyOutDir: true,
    // Wave 4 perf note: route-level lazy imports were evaluated and deferred.
    // The app is a single view (one HTML entry, no router), so there is no
    // trivial split point — manualChunks would only add file:// fetch hops
    // in the Tauri webview without shrinking the initial parse. Revisit if a
    // second heavy route (e.g. a standalone viewer) lands.
    rolldownOptions: {
      input: {
        main: resolve(import.meta.dirname, "src/index.html"),
      },
    },
  },
  server: {
    port: 5173,
    strictPort: true,
  },
});
