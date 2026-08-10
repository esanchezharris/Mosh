import { expect, test } from "@playwright/test";
import { bootProTools } from "./helpers";

test("Link Track and Edit Selection associates and separates lane scope", async ({ page }, testInfo) => {
  // Given the default linked control and at least two Edit Window tracks.
  await page.setViewportSize({ width: 1440, height: 900 });
  await bootProTools(page);
  const link = page.getByTestId("pt-track-edit-link");
  await expect(link).toHaveAttribute("aria-pressed", "true");
  const lanes = page.getByTestId("pt-lane");
  const headers = page.getByTestId("pt-track-header");
  await expect(lanes).toHaveCount(await headers.count());
  expect(await lanes.count()).toBeGreaterThan(1);
  const firstLane = page.locator('.pt-lane:has([data-testid="v2-clip"].wave)').first();
  const firstTrackId = await firstLane.getAttribute("data-track-id");
  if (!firstTrackId) throw new Error("wave Edit lane has no track id");
  const firstHeader = page.locator(
    `[data-testid="pt-track-header"][data-track-id="${firstTrackId}"]`,
  );
  let secondHeader = headers.nth(0);
  if (await secondHeader.getAttribute("data-track-id") === firstTrackId) secondHeader = headers.nth(1);
  const firstBounds = await firstLane.boundingBox();
  if (!firstBounds) throw new Error("first Edit lane bounds are unavailable");

  // When an Edit range is drawn in the first lane.
  const y = firstBounds.y + Math.min(8, firstBounds.height / 4);
  await page.mouse.move(firstBounds.x + 20, y);
  await page.mouse.down();
  await page.mouse.move(firstBounds.x + 260, y, { steps: 4 });
  await page.mouse.up();

  // Then only its associated track owns the Edit overlay and selected header.
  const edit = page.getByTestId("pt-edit-selection");
  await expect(edit).toHaveAttribute("data-track-id", firstTrackId);
  await expect(firstHeader).toHaveAttribute("data-selected", "true");
  const editBounds = await edit.boundingBox();
  if (!editBounds) throw new Error("track-scoped Edit selection bounds are unavailable");
  expect(Math.abs(editBounds.y - firstBounds.y)).toBeLessThanOrEqual(1);
  expect(Math.abs(editBounds.height - firstBounds.height)).toBeLessThanOrEqual(1);

  // When Track/Edit is unlinked and another track header is selected.
  await page.keyboard.press("Shift+T");
  await expect(link).toHaveAttribute("aria-pressed", "false");
  await secondHeader.getByTestId("pt-track-select").click();

  // Then track selection diverges while the Edit range stays on its original lane.
  await expect(secondHeader).toHaveAttribute("data-selected", "true");
  await expect(edit).toHaveAttribute("data-track-id", firstTrackId);
  await page.screenshot({
    path: testInfo.outputPath("protools-track-edit-unlinked-wide.png"),
    animations: "disabled",
  });

  // And the independent link control remains reachable at compact width.
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.setViewportSize({ width: 720, height: 720 });
  await link.scrollIntoViewIfNeeded();
  await expect(link).toBeVisible();
  await page.screenshot({
    path: testInfo.outputPath("protools-track-edit-unlinked-compact.png"),
    animations: "disabled",
  });

  // When relinked, the track selection rejoins the retained Edit range.
  await page.keyboard.press("Shift+T");
  await expect(link).toHaveAttribute("aria-pressed", "true");
  await expect(firstHeader).toHaveAttribute("data-selected", "true");
});
