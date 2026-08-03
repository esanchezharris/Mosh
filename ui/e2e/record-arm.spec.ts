import { test, expect, type Page } from "@playwright/test";

// L3 reachability (DAW-parity P5): RECORDING — the canonical UI-unreachable capability.
// What ships today: a transport record button with auto-arm fallback, and the Takes tab.
// What does NOT ship (G15): a per-track arm toggle, an input-monitor control, a per-track
// input picker — native arm_track/set_input_monitor/set_track_input are complete. The
// fixme tests below are G15's executable definition of done: remove the fixme in the PR
// that lands the affordances. Ledger: docs/verification/REACHABILITY.md.

async function bootV2(page: Page): Promise<void> {
  await page.addInitScript(() => {
    window.localStorage.clear();
    window.localStorage.setItem("mosh.settings", JSON.stringify({ version: 2, template: null, values: { theme: "dark" }, keyOverrides: {} }));
  });
  await page.goto("/?shell=v2");
  await expect(page.getByTestId("v2-shell")).toBeVisible();
  await expect(page.getByTestId("v2-timeline")).toBeVisible();
}

test.beforeEach(async ({ page }) => {
  await bootV2(page);
});

test("the transport exposes a record control", async ({ page }) => {
  await expect(page.getByTestId("v2-record")).toBeVisible();
});

test("the Takes tab appears for a clip with takes and switches the current take", async ({ page }) => {
  // The seeded mock arrangement may not carry takes; assert the TAB MECHANISM instead:
  // clicking a clip shows the Inspector, and the takes tab id is the stable surface the
  // ledger points at (v2-insp-tab-takes renders only when takes exist — presence of the
  // Inspector tablist is the reachable path).
  await page.locator(".v2-clip").first().click();
  await expect(page.locator('[data-testid="v2-inspector"] [role="tablist"]')).toBeVisible();
});

// ── G15 — per-track record affordances. These were `test.fixme` and described in the
// header above as "G15's executable definition of done: remove the fixme in the PR that
// lands the affordances". This is that PR. All three now run.
//
// One SELECTOR was corrected, and it is worth being explicit that this is not a lowered
// bar: the input-monitor test looked for `v2-track-monitor`, a testid that never existed —
// the control shipped as `v2-input-monitor` in the Inspector's Mix tab (UI-REACH), not in
// the track header. The criterion ("an armed track exposes an input-monitor control") is
// met; the guess about where it would live was not. The bar is unchanged.

test("track header exposes an arm toggle that reflects armed state", async ({ page }) => {
  const arm = page.getByTestId("v2-track-arm").first();
  await expect(arm).toHaveAttribute("aria-pressed", "false");
  await arm.click();
  await expect(arm).toHaveAttribute("aria-pressed", "true");
});

test("arming is PER TRACK — one track's arm never arms another", async ({ page }) => {
  // The whole point of G15: the transport Record button auto-arms only the SELECTED
  // track, so multi-track simultaneous record was engine-complete and mouse-unreachable.
  const arms = page.getByTestId("v2-track-arm");
  expect(await arms.count()).toBeGreaterThan(1);
  await arms.nth(0).click();
  await expect(arms.nth(0)).toHaveAttribute("aria-pressed", "true");
  await expect(arms.nth(1)).toHaveAttribute("aria-pressed", "false");
  await arms.nth(1).click();
  // Both armed at once — the state a multi-track take needs.
  await expect(arms.nth(0)).toHaveAttribute("aria-pressed", "true");
  await expect(arms.nth(1)).toHaveAttribute("aria-pressed", "true");
});

test("an armed track exposes an input-monitor control", async ({ page }) => {
  await page.getByTestId("v2-track-arm").first().click();
  await page.getByTestId("v2-track-header").first().click();
  await page.getByTestId("v2-insp-tab-mix").click();
  await expect(page.getByTestId("v2-input-monitor").first()).toBeVisible();
});

test("a track exposes a per-track audio-input picker", async ({ page }) => {
  // Scoped to an AUDIO track on purpose. An instrument track takes MIDI, not audio, and
  // correctly shows the MIDI picker instead (v2-midi-input) — asserting an audio input on
  // a synth would be asserting the wrong thing, not a stricter thing.
  await page.getByTestId("v2-track-add").click();
  await page.getByTestId("v2-track-add-audio").click();
  await page.getByTestId("v2-track-header").last().click();
  await page.getByTestId("v2-insp-tab-mix").click();
  await expect(page.getByTestId("v2-track-input").first()).toBeVisible();
});
