import { test, expect, type Page } from "@playwright/test";

// L3 reachability (DAW-parity P5): AUTOMATION in the v2 shell — currently a gap (G16).
// Native write-mode recording + write_automation_curve landed (#414) and the CLASSIC
// shell has an automation panel, but v2 exposes no write-arm control and no lane view.
// The fixme tests are G16's executable definition of done.
// Ledger: docs/verification/REACHABILITY.md.

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

// ── G16 — v2 automation surface (fixme = definition of done) ─────────────────────

test.fixme("a track exposes an automation write-arm control", async ({ page }) => {
  await page.locator(".v2-clip").first().click();
  await page.getByTestId("v2-insp-tab-mix").click();
  const arm = page.getByTestId("v2-automation-arm");
  await arm.click();
  await expect(arm).toHaveAttribute("aria-pressed", "true");
});

test.fixme("an automated parameter shows an editable lane/curve surface", async ({ page }) => {
  await expect(page.getByTestId("v2-automation-lane").first()).toBeVisible();
});
