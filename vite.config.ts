import { defineConfig } from "vite";
import { resolve } from "node:path";

export default defineConfig({
  root: "src",
  publicDir: "../public",
  build: {
    outDir: "../dist",
    emptyOutDir: true,
    // Tauri's macOS deployment target is 13.3, the first Ventura release with
    // Safari 16.4. The UI uses `@container` and `color-mix()`, so keep this
    // aligned with bundle.macOS.minimumSystemVersion in tauri.conf.json.
    target: ["safari16.4"],
    cssTarget: ["safari16.4"],
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
