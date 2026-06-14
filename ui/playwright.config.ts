import { defineConfig, devices } from "@playwright/test";

const channel =
  process.env.MOSH_PLAYWRIGHT_CHANNEL ||
  (process.platform === "win32" ? "msedge" : undefined);

export default defineConfig({
  testDir: "./e2e",
  timeout: 120_000,
  expect: { timeout: 10_000 },
  reporter: [["list"]],
  // The specs drive ONE shared, stateful MoshOps backend (a single Edit/session).
  // They must not run concurrently or they would mutate each other's arrangement.
  // Each spec resets to a known state, so they stay independently runnable in series
  // (e.g. `playwright test generative` to iterate one flow without the whole chain).
  fullyParallel: false,
  workers: 1,
  outputDir:
    process.env.PLAYWRIGHT_OUTPUT_DIR || "../.e2e-artifacts/playwright",
  use: {
    baseURL: process.env.MOSH_BASE_URL || "http://127.0.0.1:8080",
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    video: "off",
  },
  projects: [
    {
      name: "http-ui",
      use: {
        ...devices["Desktop Chrome"],
        channel,
      },
    },
  ],
});
