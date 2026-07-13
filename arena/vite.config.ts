import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";
import { arenaBrain } from "./server/arenaBrain";

// The Designer Arena is a DEV-ONLY taste bench. It is a separate Vite app that the
// shipped Mosh UI (ui/) never imports, so it can never leak into Mosh.app's single-file
// bundle or --selftest. Runs on :5273 to stay clear of Mosh's dev server (:5173).
//
// arenaBrain is a Vite middleware that proxies model calls (Claude/GPT/Gemini/Grok)
// through the same-origin /api/arena/* — keys live ONLY server-side in arena/.env.local
// and are never sent to the browser. It meters every call and enforces a hard spend cap.
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), ""); // "" → load ALL keys; SERVER-SIDE only, never bundled
  return {
    plugins: [react(), arenaBrain(env)],
    // host:true binds 0.0.0.0 so an iPhone on the SAME Wi-Fi can open http://<mac-lan-ip>:5273.
    // Keys stay server-side (the phone hits the same-origin proxy); the $50 cap still bounds spend.
    server: { port: 5273, strictPort: true, host: true },
    build: { outDir: "dist", emptyOutDir: true, target: "es2020" },
  };
});
