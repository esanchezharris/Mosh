import { expect, test, type Locator, type Page } from "@playwright/test";
import { bootProTools } from "./helpers";

async function drawEditRange(page: Page, lane: Locator): Promise<void> {
  const bounds = await lane.boundingBox();
  if (!bounds) throw new Error("Edit lane bounds are unavailable");
  const startX = Math.min(bounds.x + bounds.width - 180, bounds.x + 850);
  await page.mouse.move(startX, bounds.y + 8);
  await page.mouse.down();
  await page.mouse.move(startX + 120, bounds.y + 8, { steps: 4 });
  await page.mouse.up();
}

function commandCount(page: Page): Promise<number> {
  return page.evaluate(() => {
    const trace: unknown = Reflect.get(window, "__moshCmdTrace");
    return Array.isArray(trace) ? trace.length : 0;
  });
}

test("Avid Extend shortcut adds the neighboring linked Edit track", async ({ page }, testInfo) => {
  // Given a horizontal Edit span associated with the first two visible tracks.
  await page.setViewportSize({ width: 1440, height: 900 });
  await bootProTools(page);
  const lanes = page.getByTestId("pt-lane");
  const headers = page.getByTestId("pt-track-header");
  await expect(lanes).toHaveCount(3);
  const firstHeader = headers.nth(0);
  const middleHeader = headers.nth(1);
  const lastHeader = headers.nth(2);
  const firstTrackId = await firstHeader.getAttribute("data-track-id");
  const middleTrackId = await middleHeader.getAttribute("data-track-id");
  const lastTrackId = await lastHeader.getAttribute("data-track-id");
  if (!firstTrackId || !middleTrackId || !lastTrackId)
    throw new Error("Edit track ids are unavailable");
  await drawEditRange(page, lanes.nth(0));
  await middleHeader.getByTestId("pt-track-select").click({ modifiers: ["Shift"] });
  const edit = page.getByTestId("pt-edit-selection");
  await expect(edit).toHaveAttribute("data-track-ids", `${firstTrackId} ${middleTrackId}`);
  const before = await edit.boundingBox();
  if (!before) throw new Error("Edit selection geometry is unavailable");
  const commandsBefore = await commandCount(page);
  await page.getByTestId("pt-timeline").focus();

  // When Control+Shift+Semicolon extends Edit ownership down.
  await page.keyboard.press("Control+Shift+;");

  // Then the neighboring track joins without changing time or issuing a command.
  await expect(edit).toHaveAttribute(
    "data-track-ids",
    `${firstTrackId} ${middleTrackId} ${lastTrackId}`,
  );
  await expect(lastHeader).toHaveAttribute("data-selected", "true");
  const extended = await edit.boundingBox();
  if (!extended) throw new Error("extended Edit selection geometry is unavailable");
  expect(Math.abs(extended.x - before.x)).toBeLessThanOrEqual(1);
  expect(Math.abs(extended.width - before.width)).toBeLessThanOrEqual(1);
  expect(await commandCount(page)).toBe(commandsBefore);
  await page.screenshot({
    path: testInfo.outputPath("protools-extended-edit-selection-wide.png"),
    animations: "disabled",
  });

  // And the same extended state remains legible at compact reduced-motion size.
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.setViewportSize({ width: 720, height: 720 });
  await edit.scrollIntoViewIfNeeded();
  await expect(edit).toBeVisible();
  await page.screenshot({
    path: testInfo.outputPath("protools-extended-edit-selection-compact.png"),
    animations: "disabled",
  });
});

test("Avid Remove shortcuts trim linked Edit edges and retain the final owner", async ({ page }) => {
  // Given one horizontal Edit span associated with all three visible tracks.
  await page.setViewportSize({ width: 1440, height: 900 });
  await bootProTools(page);
  const lanes = page.getByTestId("pt-lane");
  const headers = page.getByTestId("pt-track-header");
  const firstHeader = headers.nth(0);
  const middleHeader = headers.nth(1);
  const lastHeader = headers.nth(2);
  const firstTrackId = await firstHeader.getAttribute("data-track-id");
  const middleTrackId = await middleHeader.getAttribute("data-track-id");
  const lastTrackId = await lastHeader.getAttribute("data-track-id");
  if (!firstTrackId || !middleTrackId || !lastTrackId)
    throw new Error("Remove Edit track ids are unavailable");
  await drawEditRange(page, lanes.nth(0));
  await lastHeader.getByTestId("pt-track-select").click({ modifiers: ["Shift"] });
  const edit = page.getByTestId("pt-edit-selection");
  await expect(edit).toHaveAttribute(
    "data-track-ids",
    `${firstTrackId} ${middleTrackId} ${lastTrackId}`,
  );
  const commandsBefore = await commandCount(page);
  await page.getByTestId("pt-timeline").focus();

  // When the top and bottom removal sequence reaches one surviving owner.
  await page.keyboard.press("Alt+Control+P");
  await expect(edit).toHaveAttribute("data-track-ids", `${middleTrackId} ${lastTrackId}`);
  await page.keyboard.press("Alt+Control+;");
  await page.keyboard.press("Alt+Control+;");

  // Then the final owner remains selected and the UI-local sequence emits no command.
  await expect(edit).toHaveAttribute("data-track-ids", middleTrackId);
  await expect(middleHeader).toHaveAttribute("data-selected", "true");
  await expect(firstHeader).toHaveAttribute("data-selected", "false");
  await expect(lastHeader).toHaveAttribute("data-selected", "false");
  expect(await commandCount(page)).toBe(commandsBefore);
});

test("vertical Edit shortcuts leave independent Track selection untouched", async ({ page }) => {
  // Given Edit ownership is on the middle track while the first Track Name is independently selected.
  await page.setViewportSize({ width: 1440, height: 900 });
  await bootProTools(page);
  const lanes = page.getByTestId("pt-lane");
  const headers = page.getByTestId("pt-track-header");
  const firstHeader = headers.nth(0);
  const middleHeader = headers.nth(1);
  const lastHeader = headers.nth(2);
  const middleTrackId = await middleHeader.getAttribute("data-track-id");
  const lastTrackId = await lastHeader.getAttribute("data-track-id");
  if (!middleTrackId || !lastTrackId) throw new Error("unlinked Edit track ids are unavailable");
  await drawEditRange(page, lanes.nth(1));
  await page.keyboard.press("Shift+T");
  await firstHeader.getByTestId("pt-track-select").click();
  const edit = page.getByTestId("pt-edit-selection");
  await expect(edit).toHaveAttribute("data-track-ids", middleTrackId);
  await page.getByTestId("pt-timeline").focus();

  // When Edit ownership extends down while Track/Edit is unlinked.
  await page.keyboard.press("Control+Shift+;");

  // Then only the Edit bands change; the independent Track Name remains pressed.
  await expect(edit).toHaveAttribute("data-track-ids", `${middleTrackId} ${lastTrackId}`);
  await expect(firstHeader).toHaveAttribute("data-selected", "true");
  await expect(middleHeader).toHaveAttribute("data-selected", "false");
  await expect(lastHeader).toHaveAttribute("data-selected", "false");
});
