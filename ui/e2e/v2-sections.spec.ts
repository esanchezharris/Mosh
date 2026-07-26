import { test, expect } from "@playwright/test";
import { bootV2 } from "./helpers";

// The song-structure ribbon, mounted as the timeline's TOP ROW.
//
// It was complete-but-unmounted since PR #183 removed it from the nav strip, where it
// "was misread as section editing" next to the whole-song navigator. Inside the grid, over
// the same x-axis as the clips, it reads as what it is — a structure lane. SongNav is
// untouched. Mounting it closed four UI_REACH_GAPS entries at once (ratchet 21 → 17).

test("the ribbon renders the song's sections over the timeline", async ({ page }) => {
  await bootV2(page);
  await expect(page.getByTestId("v2-section-ribbon")).toBeVisible();
  await expect(page.getByTestId("v2-section")).toHaveCount(3); // mock seeds Intro/Verse/Hook
  // SongNav must still be there — the ribbon replaces nothing.
  await expect(page.getByTestId("v2-navigator")).toBeVisible();
});

test("ribbon, ruler and lanes share one x-axis", async ({ page }) => {
  // shell.css warns that the nav "MUST cap + center identically to the stage or the
  // ribbon/ruler fall out of alignment". Three rows of one CSS grid; if they ever
  // disagree, section boundaries stop meaning anything against the clips.
  await bootV2(page);
  const box = async (sel: string) => (await page.locator(sel).first().boundingBox())!;
  const [ribbon, ruler, lane] = [await box(".v2-ribbon"), await box(".v2-ruler-cell"), await box(".v2-lane")];
  expect(Math.abs(ribbon.x - lane.x), "ribbon is not aligned with the lanes").toBeLessThanOrEqual(1);
  expect(Math.abs(ruler.x - lane.x), "ruler is not aligned with the lanes").toBeLessThanOrEqual(1);
  expect(Math.abs(ribbon.width - lane.width), "ribbon does not span the same time as the lanes").toBeLessThanOrEqual(1);
});

test("the two sticky rows stack instead of overlapping", async ({ page }) => {
  // PR #183 flattened both `top` offsets to 0 when the ribbon left the layout. With the
  // ribbon back, a shared offset would pin them on top of each other on scroll.
  await bootV2(page);
  const offsets = await page.evaluate(() => ({
    ribbon: getComputedStyle(document.querySelector(".v2-ribbon-cell")!).top,
    ruler: getComputedStyle(document.querySelector(".v2-ruler-cell")!).top,
  }));
  expect(offsets.ribbon).toBe("0px");
  expect(offsets.ruler, "the ruler must stick BELOW the ribbon, not at the same offset").not.toBe("0px");
});

test("+ adds a section and opens it for renaming", async ({ page }) => {
  await bootV2(page);
  await page.getByTestId("v2-section-add").click();
  await expect(page.getByTestId("v2-section")).toHaveCount(4);
  const input = page.getByTestId("v2-section-rename");
  await expect(input).toBeFocused();
  await input.fill("Bridge");
  await input.press("Enter");
  await expect(page.getByTestId("v2-section").last()).toContainText("Bridge");
});

test("a section can be removed", async ({ page }) => {
  await bootV2(page);
  await page.getByTestId("v2-section").first().hover(); // ✕ is hover-revealed
  await page.getByTestId("v2-section-remove").first().click();
  await expect(page.getByTestId("v2-section")).toHaveCount(2);
});

test("dragging a section moves it, snapped to the bar", async ({ page }) => {
  await bootV2(page);
  const seg = page.getByTestId("v2-section").first();
  const before = Number(await seg.getAttribute("data-start-beat"));
  const b = (await seg.boundingBox())!;
  // Grab the middle (clear of the ±7px edge-resize zones) and drag right.
  await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2);
  await page.mouse.down();
  await page.mouse.move(b.x + b.width / 2 + 180, b.y + b.height / 2, { steps: 10 });
  await page.mouse.up();
  await expect
    .poll(async () => Number(await page.getByTestId("v2-section").first().getAttribute("data-start-beat")))
    .toBeGreaterThan(before);
});
