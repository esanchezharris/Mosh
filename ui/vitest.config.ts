import { defineConfig } from "vitest/config";

// Unit tests only. `include` is scoped to src/**/*.test.ts so vitest never tries to
// run the Playwright spec under e2e/ (different runner, different API).
//
// jsdom: the executor contract test drives the REAL agent path through the seam
// (bridge.ts reads window/__JUCE__; the vendored JUCE frontend installs a
// placeholder window.__JUCE__ on import). Vitest sets import.meta.env.DEV = true
// so the dev-mock backs every execute_command. The pure tests run fine under it too.
export default defineConfig({
  test: {
    environment: "jsdom",
    include: ["src/**/*.test.ts"],
  },
});
