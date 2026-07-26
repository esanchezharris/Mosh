import { test, expect, type Page } from "@playwright/test";

// UI-REACH — remove_track. The sole call site in the whole codebase used to be classic's
// × on its track header, which v2 never renders, so a mouse-only v2 user could not delete
// a track at all (commandClassification.ts UI_REACH_GAPS). Drives a REAL gesture against
// the shipped v2 shell (the mock backend, same command/snapshot contract as native).

async function bootV2(page: Page): Promise<void> {
  await page.addInitScript(() => {
    window.localStorage.clear();
    window.localStorage.setItem("mosh.settings", JSON.stringify({ version: 2, template: null, values: {}, keyOverrides: {} }));
  });
  await page.goto("/?shell=v2");
  await expect(page.getByTestId("v2-shell")).toBeVisible();
  await expect(page.getByTestId("v2-timeline")).toBeVisible();
}

test("delete opens a confirm and dispatches nothing until confirmed, then removes the track", async ({ page }) => {
  await bootV2(page);
  const before = await page.getByTestId("v2-track-header").count();
  const firstHeader = page.getByTestId("v2-track-header").first();
  const trackId = await firstHeader.getAttribute("data-track-id");

  await firstHeader.getByTestId("v2-track-remove").click();
  await expect(page.getByTestId("v2-track-remove-confirm")).toBeVisible();
  // Still there — opening the confirm must not itself have dispatched remove_track.
  await expect(page.getByTestId("v2-track-header")).toHaveCount(before);

  await page.getByTestId("v2-track-remove-confirm-confirm").click();
  await expect(page.getByTestId("v2-track-header")).toHaveCount(before - 1);
  await expect(page.locator(`[data-testid="v2-track-header"][data-track-id="${trackId}"]`)).toHaveCount(0);
});

test("cancelling the confirm dispatches nothing and leaves the track in place", async ({ page }) => {
  await bootV2(page);
  const before = await page.getByTestId("v2-track-header").count();

  await page.getByTestId("v2-track-header").first().getByTestId("v2-track-remove").click();
  const dialog = page.getByTestId("v2-track-remove-confirm");
  await expect(dialog).toBeVisible();
  await dialog.getByRole("button", { name: "Cancel" }).click();

  await expect(dialog).toHaveCount(0);
  await expect(page.getByTestId("v2-track-header")).toHaveCount(before);
});
