import { defineConfig, devices } from "@playwright/test";

// Visual no-op gate for the design-system work — SEPARATE from the e2e harness
// (playwright.config.ts) so `npm run test:e2e` is untouched. Boots Storybook and
// screenshot-diffs the token sheet (and, later, component stories) in dark + light
// against committed baselines. A token sweep (PR-2.5/2.6) that changes any resolved
// value moves pixels here and fails the gate. Baselines are darwin/chromium-specific
// (regenerate on the target OS): `npm run test:visual:update`.
export default defineConfig({
  testDir: "./visual",
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  reporter: [["list"]],
  outputDir: "visual-results",
  timeout: 60_000,
  expect: {
    timeout: 10_000,
    // Playwright defaults: per-pixel threshold 0.2 absorbs AA jitter, but there is NO
    // allowed diff-pixel budget — so ANY real change (a swatch tint, or the resolved
    // value TEXT next to it) fails the gate. Do NOT add maxDiffPixelRatio here: a single
    // swatch is well under 0.2% of the sheet and would slip through.
    toHaveScreenshot: { animations: "disabled" },
  },
  use: {
    viewport: { width: 1400, height: 1000 },
    trace: "retain-on-failure",
  },
  projects: [
    {
      // The design SYSTEM — tokens and atoms, in isolation. Storybook's comparative
      // advantage: one screenshot covers dozens of states.
      name: "chromium",
      testMatch: /visual\/(tokens|consumers)\.spec\.ts/,
      use: { ...devices["Desktop Chrome"], baseURL: "http://127.0.0.1:6008" },
    },
    {
      // The PRODUCT — the assembled shell. Composition, density and hierarchy only exist
      // here, and Storybook cannot render them: build-storybook is a production build, so
      // the dev mock is off and AppV2 falls back to "Running outside the engine". See
      // shellFixture.ts.
      name: "shell",
      testMatch: /visual\/shell\.spec\.ts/,
      use: { ...devices["Desktop Chrome"], baseURL: "http://127.0.0.1:6009" },
    },
  ],
  webServer: [
    {
      // REBUILD Storybook from current source each run, then serve it statically. A fresh
      // build (not a reused HMR dev server) is what makes this a trustworthy no-op gate:
      // with `storybook dev` + reuseExistingServer, a token change slipped through as a
      // false green. Static serve needs no extra dep (python http.server).
      command: "(lsof -ti:6008 | xargs kill -9 2>/dev/null || true) && npm run build-storybook -- --quiet && python3 -m http.server 6008 --bind 127.0.0.1 --directory storybook-static",
      url: "http://127.0.0.1:6008/iframe.html",
      reuseExistingServer: false,
      timeout: 300_000,
      stdout: "ignore",
      stderr: "pipe",
    },
    {
      // A PRODUCTION Vite build with the mock switched on explicitly, served by `vite preview`.
      // Production, not `npm run dev`, for the reason recorded above: a dev server with HMR is
      // this repo's known false-green vector. It also exercises the real dead-code path, so the
      // bundle being screenshotted is shaped like the one that ships.
      //
      // Port 6009 with --strictPort on purpose. 5173 is the documented foreign-dev-server trap,
      // 5191 belongs to playwright.isolated.config.ts, 6008 is Storybook above. Strict means a
      // collision fails loudly instead of quietly screenshotting another worktree's bundle.
      command: "(lsof -ti:6009 | xargs kill -9 2>/dev/null || true) && VITE_MOSH_E2E_MOCK=1 npm run build && VITE_MOSH_E2E_MOCK=1 npx vite preview --host 127.0.0.1 --port 6009 --strictPort",
      url: "http://127.0.0.1:6009/",
      reuseExistingServer: false,
      timeout: 300_000,
      stdout: "ignore",
      stderr: "pipe",
    },
  ],
});
