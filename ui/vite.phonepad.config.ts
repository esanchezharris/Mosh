import { resolve } from "path";
import { defineConfig } from "vite";
import { viteSingleFile } from "vite-plugin-singlefile";

// Builds the Moshi phone recording pad (ui/src/phonepad) into ONE self-contained HTML
// (JS + CSS inlined) that Mosh stages as pad.html and serves at /pad. Separate from the
// main UI build so it can be embedded into the companion server independently. Mirrors
// vite.companion.config.ts.
export default defineConfig({
  root: resolve(__dirname, "src/phonepad"),
  plugins: [viteSingleFile()],
  build: {
    outDir: resolve(__dirname, "phonepad-dist"),
    emptyOutDir: true,
    target: "es2020",
    assetsInlineLimit: 100_000_000,
    cssCodeSplit: false,
    reportCompressedSize: false,
  },
});
