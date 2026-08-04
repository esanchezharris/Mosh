// GESTURE-REACH — marquee / deselect / range-tool time-select on empty lane space.
//
// This spec is the behavioural half of `ui/src/v2/gestureReach.test.ts`. That guard is a
// string probe: it proves the action is NAMED in the shipped shell, which is enough to
// stop a gesture silently disappearing, but not enough to prove the lasso actually
// selects anything. The pure rule has unit tests (`marqueeHit.test.ts`), but hit-testing
// reads real geometry — and jsdom has no layout, so every rect there is 0×0. A browser is
// the only place this can be proven.
//
// What shipped before this: v2 had NO empty-lane pointer surface at all. A producer on
// the default shell could not select more than one clip with the mouse, could not clear a
// selection by clicking away, and the Range tool (`3`) changed a mode with no effect.

import { test, expect } from "@playwright/test";
import { bootV2 } from "./helpers";

/** Two clips on one track, far enough apart that a lasso can take one or both. */
async function seedTwoClips(page: import("@playwright/test").Page) {
  await page.getByTestId("v2-track-add").click();
  await page.getByTestId("v2-track-add-tone").click();
  await expect(page.getByTestId("v2-clip").first()).toBeVisible();
}

test.describe("empty-lane gestures (GESTURE-REACH)", () => {
  test("drag on empty lane space marquee-selects the clips it touches", async ({ page }) => {
    await bootV2(page);
    await seedTwoClips(page);

    const lane = page.getByTestId("v2-lane").first();
    const clip = page.getByTestId("v2-clip").first();
    const laneBox = (await lane.boundingBox())!;
    const clipBox = (await clip.boundingBox())!;

    // Nothing selected to begin with.
    await expect(page.locator(".v2-clip.sel")).toHaveCount(0);

    // Lasso from blank space to the RIGHT of the clip back across it. Starting past the
    // clip proves the gesture begins on empty space, and dragging leftwards proves the
    // rect is direction-independent.
    const startX = Math.min(clipBox.x + clipBox.width + 120, laneBox.x + laneBox.width - 5);
    const y = laneBox.y + laneBox.height / 2;
    await page.mouse.move(startX, y);
    await page.mouse.down();
    await page.mouse.move(clipBox.x + clipBox.width / 2, y, { steps: 8 });
    // The lasso box is visible while dragging — the affordance, not just the result.
    await expect(page.getByTestId("v2-marquee")).toBeVisible();
    await page.mouse.up();

    await expect(page.getByTestId("v2-marquee")).toHaveCount(0);
    await expect(page.locator(".v2-clip.sel")).toHaveCount(1);
  });

  test("a lasso that touches nothing selects nothing (and does not throw)", async ({ page }) => {
    await bootV2(page);
    await seedTwoClips(page);
    const lane = page.getByTestId("v2-lane").first();
    const clip = page.getByTestId("v2-clip").first();
    await clip.click();
    await expect(page.locator(".v2-clip.sel")).toHaveCount(1);

    const laneBox = (await lane.boundingBox())!;
    const clipBox = (await clip.boundingBox())!;
    const x0 = clipBox.x + clipBox.width + 80;
    const y = laneBox.y + laneBox.height / 2;
    await page.mouse.move(x0, y);
    await page.mouse.down();
    await page.mouse.move(x0 + 100, y, { steps: 5 });
    await page.mouse.up();
    // A non-additive marquee over empty space REPLACES the selection with nothing.
    await expect(page.locator(".v2-clip.sel")).toHaveCount(0);
  });

  test("a plain click on empty lane space clears the selection (DESELECT)", async ({ page }) => {
    await bootV2(page);
    await seedTwoClips(page);
    const clip = page.getByTestId("v2-clip").first();
    await clip.click();
    await expect(page.locator(".v2-clip.sel")).toHaveCount(1);

    const lane = page.getByTestId("v2-lane").first();
    const laneBox = (await lane.boundingBox())!;
    const clipBox = (await clip.boundingBox())!;
    // A click, not a drag: under the 4px slop, so it must not be read as a lasso.
    await page.mouse.click(clipBox.x + clipBox.width + 100, laneBox.y + laneBox.height / 2);
    await expect(page.locator(".v2-clip.sel")).toHaveCount(0);
  });

  test("the Range tool draws a time range on an empty lane (TIME_SELECT)", async ({ page }) => {
    await bootV2(page);
    await seedTwoClips(page);

    // `3` selects the Range tool. Before this landed it set store.tool and nothing else.
    await page.keyboard.press("3");

    const lane = page.getByTestId("v2-lane").first();
    const laneBox = (await lane.boundingBox())!;
    const clip = page.getByTestId("v2-clip").first();
    const clipBox = (await clip.boundingBox())!;
    const x0 = clipBox.x + clipBox.width + 60;
    const y = laneBox.y + laneBox.height / 2;

    await page.mouse.move(x0, y);
    await page.mouse.down();
    await page.mouse.move(x0 + 160, y, { steps: 8 });
    await page.mouse.up();

    // The range band is the shipped surface for delete_time_range / loop; a range drag
    // must produce it, and must NOT produce a marquee box.
    await expect(page.getByTestId("v2-timerange-band")).toBeVisible();
    await expect(page.getByTestId("v2-marquee")).toHaveCount(0);
  });
});
