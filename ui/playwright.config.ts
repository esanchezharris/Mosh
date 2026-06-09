import { defineConfig, devices } from "@playwright/test";

const channel =
  process.env.MOSH_PLAYWRIGHT_CHANNEL ||
  (process.platform === "win32" ? "msedge" : undefined);

export default defineConfig({
  testDir: "./e2e",
  timeout: 120_000,
  expect: { timeout: 10_000 },
  reporter: [["list"]],
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
