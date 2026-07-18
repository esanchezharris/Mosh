import { test, expect, type Page } from "@playwright/test";

// L3 reachability (DAW-parity P5): timeline-ops affordances that shipped natively with
// ZERO UI surface — ripple delete (G17, #424/#425) and group/ungroup tracks (G18,
// Wave D). Each fixme is its backlog item's executable definition of done.
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

// ── G17 — ripple delete affordance ───────────────────────────────────────────────

test.fixme("a discoverable ripple-delete action closes the gap over a selection", async ({ page }) => {
  const clip = page.locator(".v2-clip").nth(1);
  await clip.click({ button: "right" });
  await page.getByTestId("v2-ripple-delete").click();
  // Downstream clips slide left — asserted structurally via clip positions.
});

// ── G18 — group/ungroup tracks affordance ────────────────────────────────────────

test.fixme("selected tracks can be grouped and the group ungrouped", async ({ page }) => {
  await page.getByTestId("v2-group-tracks").click();
  await expect(page.locator(".v2-track-header.grouped").first()).toBeVisible();
});
