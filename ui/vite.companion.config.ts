import { resolve } from "path";
import { defineConfig } from "vite";
import { viteSingleFile } from "vite-plugin-singlefile";

// Builds the phone companion controller (ui/src/companion) into ONE self-contained HTML
// (JS + CSS inlined) that RemoteCompanionServer serves at /web. Separate from the main UI
// build so it can be embedded into the companion server independently.
export default defineConfig({
  root: resolve(__dirname, "src/companion"),
  plugins: [viteSingleFile()],
  build: {
    outDir: resolve(__dirname, "companion-dist"),
    emptyOutDir: true,
    target: "es2019",
    assetsInlineLimit: 100_000_000,
    cssCodeSplit: false,
    reportCompressedSize: false,
  },
});
