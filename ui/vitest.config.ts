import { defineConfig } from "vitest/config";

// Unit tests only. `include` is scoped to src/**/*.test.ts, the single test surface
// on this project (the orphaned Playwright e2e/ harness was removed — it drove an
// HTTP backend that never existed). The scope keeps any future non-unit specs out.
//
// jsdom: the executor contract test drives the REAL agent path through the seam
// (bridge.ts reads window/__JUCE__; the vendored JUCE frontend installs a
// placeholder window.__JUCE__ on import). Vitest sets import.meta.env.DEV = true
// so the dev-mock backs every execute_command. The pure tests run fine under it too.
export default defineConfig({
  test: {
    environment: "jsdom",
    include: ["src/**/*.test.ts"],
    setupFiles: ["src/test/setup.ts"],
  },
});
