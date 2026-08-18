import { defineConfig, devices } from "@playwright/test";

const preview = process.env.MOSH_E2E_PREVIEW === "1";

// E2E harness — drives the REAL React WebView UI in a headless Chromium against the
// Vite dev server. In dev, bridge.ts wires in the in-memory mock backend
// (bridge.mock.ts, enabled only in development, test, or explicit e2e mode), which
// speaks the same
// execute_command + snapshot + events contract the native C++ MoshOps exposes. So
// these tests exercise the whole frontend — store, gestures, keymap, templates,
// optimistic previews — deterministically, with no native build, no audio device,
// no Python service. The packaged app's own smoke path stays `Mosh --selftest`
// (the WKWebView can't be driven by Playwright, and the command surface is identical).

export default defineConfig({
  testDir: "./e2e",
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0, // the mock is deterministic; no retries locally
  workers: process.env.CI ? 2 : undefined,
  reporter: [["list"], ["html", { outputFolder: "e2e-report", open: "never" }]],
  outputDir: "e2e-results",
  timeout: 30_000,
  expect: { timeout: 7_000 },
  use: {
    baseURL: "http://127.0.0.1:5173",
    viewport: { width: 1440, height: 900 },
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    video: "off",
  },
  projects: [{
    name: "chromium",
    use: {
      ...devices["Desktop Chrome"],
      // Collaborator-video tests: a fake camera so getUserMedia resolves with a real
      // MediaStream and the permission prompt is auto-granted (headless, deterministic).
      permissions: ["camera"],
      launchOptions: { args: ["--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream"] },
    },
  }],
  webServer: {
    command: preview
      ? "MOSH_E2E_HERMETIC_BRAIN=1 npm run build:e2e && MOSH_E2E_HERMETIC_BRAIN=1 npm exec vite -- preview --outDir dist-e2e --host 127.0.0.1 --port 5173"
      : "MOSH_E2E_HERMETIC_BRAIN=1 VITE_MOSH_ENABLE_EXPERIMENTAL_AGENT_LOOP=1 npm run dev -- --host 127.0.0.1",
    url: "http://127.0.0.1:5173",
    reuseExistingServer: !process.env.CI && !preview,
    timeout: 120_000,
    stdout: "ignore",
    stderr: "pipe",
  },
});
