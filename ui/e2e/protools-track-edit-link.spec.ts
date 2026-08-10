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
  await edit.scrollIntoViewIfNeeded();
  await expect(edit).toBeVisible();
  await page.screenshot({
    path: testInfo.outputPath("protools-track-edit-unlinked-compact.png"),
    animations: "disabled",
  });

  // When relinked, the track selection rejoins the retained Edit range.
  await page.keyboard.press("Shift+T");
  await expect(link).toHaveAttribute("aria-pressed", "true");
  await expect(firstHeader).toHaveAttribute("data-selected", "true");
});

test("vertical Edit selection links contiguous tracks and their compatible Track View", async ({ page }, testInfo) => {
  // Given the default linked Edit Window with two adjacent MIDI-capable tracks.
  await page.setViewportSize({ width: 1440, height: 900 });
  await bootProTools(page);
  const lanes = page.getByTestId("pt-lane");
  const headers = page.getByTestId("pt-track-header");
  await expect(lanes).toHaveCount(3);
  const firstLane = lanes.nth(0);
  const secondLane = lanes.nth(1);
  const firstHeader = headers.nth(0);
  const secondHeader = headers.nth(1);
  const thirdHeader = headers.nth(2);
  const firstTrackId = await firstLane.getAttribute("data-track-id");
  const secondTrackId = await secondLane.getAttribute("data-track-id");
  if (!firstTrackId || !secondTrackId) throw new Error("multi-track fixture ids are unavailable");
  const firstBounds = await firstLane.boundingBox();
  const secondBounds = await secondLane.boundingBox();
  if (!firstBounds || !secondBounds) throw new Error("multi-track lane bounds are unavailable");

  // When a blank-space Selector drag crosses from Drums into Bass.
  const startX = Math.min(firstBounds.x + firstBounds.width - 180, firstBounds.x + 850);
  const endX = Math.min(firstBounds.x + firstBounds.width - 40, startX + 120);
  await page.mouse.move(startX, firstBounds.y + 8);
  await page.mouse.down();
  await page.mouse.move(endX, secondBounds.y + 8, { steps: 6 });
  await page.mouse.up();

  // Then both associated headers and exactly those contiguous lanes own the Edit range.
  const edit = page.getByTestId("pt-edit-selection");
  await expect(edit).toHaveAttribute("data-track-ids", `${firstTrackId} ${secondTrackId}`);
  await expect(firstHeader).toHaveAttribute("data-selected", "true");
  await expect(secondHeader).toHaveAttribute("data-selected", "true");
  await expect(thirdHeader).toHaveAttribute("data-selected", "false");
  const editBounds = await edit.boundingBox();
  if (!editBounds) throw new Error("multi-track Edit selection bounds are unavailable");
  expect(Math.abs(editBounds.y - firstBounds.y)).toBeLessThanOrEqual(1);
  expect(Math.abs(editBounds.height - (secondBounds.y + secondBounds.height - firstBounds.y)))
    .toBeLessThanOrEqual(1);

  // When Notes is chosen from one selected MIDI-capable track.
  await firstHeader.getByTestId("pt-track-view").selectOption("notes");

  // Then the compatible selected Track View changes as one linked operation.
  await expect(firstHeader.getByTestId("pt-track-view")).toHaveValue("notes");
  await expect(secondHeader.getByTestId("pt-track-view")).toHaveValue("notes");

  // When Track/Edit is unlinked and the unrelated Keys header is selected.
  const link = page.getByTestId("pt-track-edit-link");
  await page.keyboard.press("Shift+T");
  await thirdHeader.getByTestId("pt-track-select").click();

  // Then Track selection diverges while the two-lane Edit range remains intact.
  await expect(firstHeader).toHaveAttribute("data-selected", "false");
  await expect(secondHeader).toHaveAttribute("data-selected", "false");
  await expect(thirdHeader).toHaveAttribute("data-selected", "true");
  await expect(edit).toHaveAttribute("data-track-ids", `${firstTrackId} ${secondTrackId}`);
  await page.screenshot({
    path: testInfo.outputPath("protools-multi-track-edit-unlinked-wide.png"),
    animations: "disabled",
  });

  // And the complete linked state remains legible and reachable at compact width.
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.setViewportSize({ width: 720, height: 720 });
  await link.scrollIntoViewIfNeeded();
  await expect(link).toBeVisible();
  await edit.scrollIntoViewIfNeeded();
  await expect(edit).toBeVisible();
  await page.screenshot({
    path: testInfo.outputPath("protools-multi-track-edit-unlinked-compact.png"),
    animations: "disabled",
  });

  // When relinked, every Edit-associated track rejoins Track selection.
  await page.keyboard.press("Shift+T");
  await expect(firstHeader).toHaveAttribute("data-selected", "true");
  await expect(secondHeader).toHaveAttribute("data-selected", "true");
  await expect(thirdHeader).toHaveAttribute("data-selected", "false");
});
