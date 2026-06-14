import { defineConfig } from "vitest/config";

// Vitest config kept SEPARATE from vite.config.ts on purpose: the production build
// uses vite-plugin-singlefile (inlines everything for the JUCE WebView), which has
// no place in a unit run. These are fast, pure-logic tests — node environment, no
// DOM, no bundler plugins. Target: the whole suite well under 2s.
export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
    // e2e/ is Playwright's; never let Vitest pick those up.
    exclude: ["e2e/**", "node_modules/**", "dist/**"],
    reporters: ["default"],
  },
});
