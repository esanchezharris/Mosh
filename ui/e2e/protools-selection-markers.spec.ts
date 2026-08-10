import { expect, test } from "@playwright/test";
import { bootProTools } from "./helpers";

test("Time Grabber adjusts a visible Timeline selection boundary", async ({ page }, testInfo) => {
  // Given a Timeline selection created in the Bars+Beats ruler.
  await page.setViewportSize({ width: 1440, height: 900 });
  await bootProTools(page);
  const ruler = page.locator('[data-ruler="barsBeats"]');
  const rulerBox = await ruler.boundingBox();
  if (!rulerBox) throw new Error("Bars+Beats ruler bounds are unavailable");
  const rulerY = rulerBox.y + rulerBox.height / 2;
  await page.mouse.move(rulerBox.x + 180, rulerY);
  await page.mouse.down();
  await page.mouse.move(rulerBox.x + 560, rulerY, { steps: 4 });
  await page.mouse.up();
  await page.keyboard.press("F8");
  const start = page.getByRole("slider", { name: "Timeline selection start" });
  await expect(start).toHaveAttribute("aria-disabled", "false");
  const before = await page.getByTestId("pt-ruler-selection").boundingBox();
  const startBox = await start.boundingBox();
  if (!before || !startBox) throw new Error("Timeline selection marker bounds are unavailable");

  // When the Time Grabber moves the Start marker later.
  await page.mouse.move(startBox.x + startBox.width / 2, startBox.y + startBox.height / 2);
  await page.mouse.down();
  await page.mouse.move(rulerBox.x + 340, rulerY, { steps: 4 });
  await page.mouse.up();

  // Then Start moves, End stays fixed, and the handle remains reachable at compact width.
  const after = await page.getByTestId("pt-ruler-selection").boundingBox();
  if (!after) throw new Error("Adjusted Timeline selection bounds are unavailable");
  expect(after.x).toBeGreaterThan(before.x + 80);
  expect(Math.abs(after.x + after.width - (before.x + before.width))).toBeLessThanOrEqual(2);
  await page.screenshot({
    path: testInfo.outputPath("protools-selection-marker-wide.png"),
    animations: "disabled",
  });
  await page.setViewportSize({ width: 720, height: 720 });
  await start.scrollIntoViewIfNeeded();
  await expect(start).toBeVisible();
  await page.screenshot({
    path: testInfo.outputPath("protools-selection-marker-compact.png"),
    animations: "disabled",
  });
});
