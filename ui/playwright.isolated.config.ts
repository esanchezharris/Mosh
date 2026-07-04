import { defineConfig, devices } from "@playwright/test";

// Throwaway ISOLATED e2e config (not used by CI): identical to playwright.config.ts but
// on port 5191 with strictPort, for machines where a CONCURRENT session's dev server owns
// :5173 with a different bundle (the documented false-fail trap — do NOT kill that server).
// MUST keep the camera fake-media flags or 2 collaborator-video tests false-fail.

export default defineConfig({
  testDir: "./e2e",
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: 0,
  reporter: [["list"], ["html", { outputFolder: "e2e-report", open: "never" }]],
  outputDir: "e2e-results",
  timeout: 30_000,
  expect: { timeout: 7_000 },
  use: {
    baseURL: "http://localhost:5191",
    viewport: { width: 1440, height: 900 },
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    video: "off",
  },
  projects: [{
    name: "chromium",
    use: {
      ...devices["Desktop Chrome"],
      permissions: ["camera"],
      launchOptions: { args: ["--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream"] },
    },
  }],
  webServer: {
    command: "npx vite --port 5191 --strictPort",
    url: "http://localhost:5191",
    reuseExistingServer: false,
    timeout: 120_000,
    stdout: "ignore",
    stderr: "pipe",
  },
});
