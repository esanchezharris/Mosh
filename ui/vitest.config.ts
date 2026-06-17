import { defineConfig } from "vitest/config";

// Unit tests only. `include` is scoped to src/**/*.test.ts so vitest only picks up
// the colocated unit tests. There is no separate e2e tree: Mosh's UI couples to the
// backend solely through the in-process JUCE native bridge (see src/bridge.ts), which
// no browser harness can drive; the project gate is the native `Mosh --selftest`.
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
