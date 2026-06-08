import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// base: "./" → relative asset URLs so the bundle is self-contained when served
// by the JUCE WebView resource provider (no fixed origin). 03 / 06 §1.
export default defineConfig({
  plugins: [react()],
  base: "./",
  build: {
    outDir: "dist",
    emptyOutDir: true,
    target: "es2020",
    sourcemap: false,
  },
  server: {
    port: 5173,
    strictPort: true,
  },
});
