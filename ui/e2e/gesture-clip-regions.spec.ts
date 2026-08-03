// GESTURE-REACH — clip.header / clip.body, and the "Mouse gestures" setting becoming real.
//
// The setting (`settings/schema.ts` id `gestureTable`, label "Mouse gestures", help
// "Which DAW's clip/lane interaction model the mouse uses") shipped reachable from the
// v2 shell and did NOTHING there: `ClipView.tsx` hardcoded `getGestureTable("mosh")`.
// The sibling `keymap` setting WAS honoured, which is what made this a defect rather
// than a design choice.
//
// It could not simply be un-hardcoded. Ableton's and Pro Tools' tables address
// `clip.header` and `clip.body`, and v2 passed `headerPx: 0` to `classifyClipRegion`, so
// those regions could never be produced — flipping the table alone would have given a
// clip whose top strip did nothing. Both halves had to land together, which is why this
// spec asserts the two DAW models produce DIFFERENT behaviour from the same drag.
//
// jsdom cannot cover this: the region is decided from getBoundingClientRect, which is
// 0×0 without layout, so every pointer would classify identically.

import { test, expect, type Page } from "@playwright/test";

/** Boot v2 with a specific "Mouse gestures" model seeded into settings. */
async function bootWithGestures(page: Page, gestureTable: "mosh" | "ableton") {
  await page.addInitScript((gt) => {
    window.localStorage.clear();
    window.localStorage.setItem("mosh.settings", JSON.stringify({
      version: 2, template: null, values: { gestureTable: gt }, keyOverrides: {},
    }));
  }, gestureTable);
  await page.goto("/?shell=v2");
  await expect(page.getByTestId("v2-shell")).toBeVisible();
  await expect(page.getByTestId("v2-timeline")).toBeVisible();
  await page.getByTestId("v2-track-add").click();
  await page.getByTestId("v2-track-add-tone").click();
  await expect(page.getByTestId("v2-clip").first()).toBeVisible();
}

const clipLeft = async (page: Page) => (await page.getByTestId("v2-clip").first().boundingBox())!.x;

test.describe("clip.header / clip.body (GESTURE-REACH)", () => {
  test("Mosh: the whole clip drags to MOVE, and no title strip is drawn", async ({ page }) => {
    await bootWithGestures(page, "mosh");
    const clip = page.getByTestId("v2-clip").first();
    // No header class ⇒ no invisible dead zone and no decorative bar.
    await expect(clip).not.toHaveClass(/\bhdr\b/);

    const box = (await clip.boundingBox())!;
    const before = box.x;
    // Grab the BODY (well below any header strip) and drag right.
    await page.mouse.move(box.x + box.width / 2, box.y + box.height * 0.75);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width / 2 + 140, box.y + box.height * 0.75, { steps: 10 });
    await page.mouse.up();

    await expect.poll(() => clipLeft(page)).toBeGreaterThan(before + 20);
    // A move is not a time selection.
    await expect(page.getByTestId("v2-timerange-band")).toHaveCount(0);
  });

  test("Ableton: the same body drag TIME-SELECTS instead of moving the clip", async ({ page }) => {
    await bootWithGestures(page, "ableton");
    const clip = page.getByTestId("v2-clip").first();
    await expect(clip).toHaveClass(/\bhdr\b/);   // the strip is drawn, so it is findable

    const box = (await clip.boundingBox())!;
    const before = box.x;
    await page.mouse.move(box.x + box.width / 2, box.y + box.height * 0.75);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width / 2 + 140, box.y + box.height * 0.75, { steps: 10 });
    await page.mouse.up();

    // THE POINT: identical gesture, different model, different outcome.
    await expect(page.getByTestId("v2-timerange-band")).toBeVisible();
    expect(await clipLeft(page)).toBeCloseTo(before, 0);
  });

  test("Ableton: dragging the clip HEADER still moves it", async ({ page }) => {
    await bootWithGestures(page, "ableton");
    const clip = page.getByTestId("v2-clip").first();
    // Assert the Ableton model is actually ACTIVE. Without this the test passes under a
    // regression that hardcodes the Mosh table, because under Mosh the whole clip moves
    // and a header drag is just a clip drag — it would prove nothing it claims to.
    await expect(clip).toHaveClass(/\bhdr\b/);
    const box = (await clip.boundingBox())!;
    const before = box.x;
    // y inside the 18px title strip.
    const y = box.y + 8;
    await page.mouse.move(box.x + box.width / 2, y);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width / 2 + 140, y, { steps: 10 });
    await page.mouse.up();

    await expect.poll(() => clipLeft(page)).toBeGreaterThan(before + 20);
    await expect(page.getByTestId("v2-timerange-band")).toHaveCount(0);
  });

  test("Ableton: the edges still trim — trim outranks the header at a corner", async ({ page }) => {
    await bootWithGestures(page, "ableton");
    const clip = page.getByTestId("v2-clip").first();
    const box = (await clip.boundingBox())!;
    const beforeW = box.width;
    // Top-RIGHT corner: inside the header band vertically AND the edge band
    // horizontally. classifyClipRegion resolves edge first, matching DAW muscle memory.
    await page.mouse.move(box.x + box.width - 2, box.y + 4);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width - 2 - 120, box.y + 4, { steps: 10 });
    await page.mouse.up();

    await expect.poll(async () => (await clip.boundingBox())!.width).toBeLessThan(beforeW - 20);
  });
});
