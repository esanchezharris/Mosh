import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// The Vite bundle is loaded by the JUCE 8 WebView from a local file path /
// embedded resource (NOT a web-server root), so all asset URLs must be
// relative. `base: "./"` makes index.html reference ./assets/* relatively.
export default defineConfig({
  base: "./",
  plugins: [react()],
  build: {
    outDir: "dist",
    // Keep the bundle simple and self-contained for WebView loading.
    assetsInlineLimit: 0,
    chunkSizeWarningLimit: 1500,
  },
});
