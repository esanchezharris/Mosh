import { expect, test, type Locator, type Page } from "@playwright/test";
import { bootProTools } from "./helpers";

type UnlinkedSelectionSetup = {
  readonly link: Locator;
  readonly initialTimelineX: number;
  readonly initialTimelineWidth: number;
};

async function createUnlinkedSelections(page: Page): Promise<UnlinkedSelectionSetup> {
  await page.setViewportSize({ width: 1440, height: 900 });
  await bootProTools(page);
  const link = page.getByTestId("pt-selection-link");
  await expect(link).toHaveAttribute("aria-pressed", "true");
  const rulerBox = await page.locator('[data-ruler="barsBeats"]').boundingBox();
  if (!rulerBox) throw new Error("Bars+Beats ruler bounds are unavailable");
  const rulerY = rulerBox.y + rulerBox.height / 2;
  await page.mouse.move(rulerBox.x + 160, rulerY);
  await page.mouse.down();
  await page.mouse.move(rulerBox.x + 480, rulerY, { steps: 4 });
  await page.mouse.up();
  const initialTimeline = await page.getByTestId("pt-ruler-selection").boundingBox();
  if (!initialTimeline) throw new Error("Timeline selection bounds are unavailable");
  await link.click();
  await expect(link).toHaveAttribute("aria-pressed", "false");
  const clipBox = await page.locator('[data-testid="v2-clip"].wave').first().boundingBox();
  if (!clipBox) throw new Error("wave clip bounds are unavailable");
  const editY = clipBox.y + Math.min(8, clipBox.height / 4);
  await page.mouse.move(clipBox.x + clipBox.width * 0.2, editY);
  await page.mouse.down();
  await page.mouse.move(clipBox.x + clipBox.width * 0.75, editY, { steps: 4 });
  await page.mouse.up();
  return {
    link,
    initialTimelineX: initialTimeline.x,
    initialTimelineWidth: initialTimeline.width,
  };
}

test("unlinking preserves an independent Timeline playback span", async ({ page }, testInfo) => {
  // Given linked Timeline/Edit selections that are then separated by a clip edit.
  const setup = await createUnlinkedSelections(page);

  // When the two visible spans are measured after the Edit selection changes.
  const timeline = await page.getByTestId("pt-ruler-selection").boundingBox();
  const edit = await page.getByTestId("pt-edit-selection").boundingBox();

  // Then playback stays at the prior ruler span and the compact control remains reachable.
  if (!timeline || !edit) throw new Error("independent selection bounds are unavailable");
  expect(Math.abs(timeline.x - setup.initialTimelineX)).toBeLessThanOrEqual(1);
  expect(Math.abs(timeline.width - setup.initialTimelineWidth)).toBeLessThanOrEqual(1);
  expect(Math.abs(timeline.x - edit.x)).toBeGreaterThan(5);
  await page.screenshot({ path: testInfo.outputPath("protools-unlinked-selection-wide.png"), animations: "disabled" });
  await page.setViewportSize({ width: 720, height: 720 });
  await setup.link.scrollIntoViewIfNeeded();
  await expect(setup.link).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath("protools-unlinked-selection-compact.png"), animations: "disabled" });
});

test("Shift+Slash relinks the Timeline to the current Edit span", async ({ page }) => {
  // Given independent Timeline and Edit spans.
  const setup = await createUnlinkedSelections(page);

  // When the Pro Tools link shortcut is pressed.
  await page.keyboard.press("Shift+/");

  // Then the control and both visible spans return to one linked range.
  await expect(setup.link).toHaveAttribute("aria-pressed", "true");
  const timeline = await page.getByTestId("pt-ruler-selection").boundingBox();
  const edit = await page.getByTestId("pt-edit-selection").boundingBox();
  if (!timeline || !edit) throw new Error("relinked selection bounds are unavailable");
  expect(Math.abs(timeline.x - edit.x)).toBeLessThanOrEqual(1);
  expect(Math.abs(timeline.width - edit.width)).toBeLessThanOrEqual(1);
});
