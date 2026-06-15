import { defineConfig } from "vitest/config";

// Unit tests only. `include` is scoped to src/**/*.test.ts so vitest never tries
// to run the Playwright spec under e2e/ (different runner, different API).
export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
  },
});
