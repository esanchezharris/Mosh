import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { viteSingleFile } from "vite-plugin-singlefile";

// Single-file build: viteSingleFile inlines ALL JS + CSS into one self-contained
// index.html (no external <script src>/<link href>). This is load-bearing for the
// JUCE WebView: its resource-provider custom scheme does NOT execute external ES
// module scripts (and crossorigin external CSS doesn't apply), so an external
// bundle silently never runs → blank screen. Inline scripts/styles need no fetch,
// so they always execute/apply. base: "./" keeps any residual refs origin-free.
// 03 / 06 §1.
export default defineConfig({
  plugins: [react(), viteSingleFile()],
  base: "./",
  build: {
    outDir: "dist",
    emptyOutDir: true,
    target: "es2020",
    sourcemap: false,
    // Base64-inline fonts so they survive the single-file WebView bundle (the JUCE
    // resource provider won't reliably serve an external .ttf). Other assets keep the
    // default 4 KB threshold.
    assetsInlineLimit: (filePath: string) => (filePath.endsWith(".ttf") ? true : undefined),
  },
  server: {
    port: 5173,
    strictPort: true,
  },
});
