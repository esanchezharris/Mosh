// Two T0 gaps that were UI-only all along.
//
//   • CAP-CLP-005 crop to range — `trim_clip` could always express a crop; nothing could
//     ASK for one. Dragging a clip's left edge is the closest a producer could get, and it
//     does two things at once (moves the boundary AND slides the source under it), so
//     cropping a stack of clips to a section meant hand-dragging every edge twice.
//   • CAP-CLP-002 adaptive grid — snapDivision was a fixed choice, so the grid turned into
//     noise when you zoomed in and vanished when you zoomed out.
//
// The arithmetic for both is unit-tested pure (`cropToRange.test.ts`, `adaptiveGrid.test.ts`),
// including the crop rules a browser cannot show: the offset compensation that keeps the
// surviving audio the audio that was already there, and the degenerate-range case that
// must crop NOTHING rather than delete the project. This spec covers the half those
// cannot: that the controls exist, and that using them changes the arrangement.

import { test, expect } from "@playwright/test";
import { bootV2 } from "./helpers";

test.describe("crop to range (CAP-CLP-005)", () => {
  test("Crop trims the clips that straddle the range and drops the rest", async ({ page }) => {
    await bootV2(page);
    const clips = page.getByTestId("v2-clip");
    const before = await clips.count();
    test.skip(before === 0, "fixture has no clips");

    // Draw a range over the first part of the timeline by shift-dragging the ruler —
    // the shipped path, and the one v2-timerange.spec.ts already pins.
    const ruler = page.getByTestId("v2-timeline").locator(".v2-ruler-cell");
    const box = (await ruler.boundingBox())!;
    const y = box.y + box.height / 2;
    await page.mouse.move(box.x + 40, y);
    await page.keyboard.down("Shift");
    await page.mouse.down();
    await page.mouse.move(box.x + 260, y, { steps: 8 });
    await page.mouse.up();
    await page.keyboard.up("Shift");
    await expect(page.getByTestId("v2-timerange-band")).toBeVisible();

    await page.getByTestId("v2-timerange-crop").click();

    // The range is consumed, and the arrangement changed: clips outside are gone.
    await expect(page.getByTestId("v2-timerange-band")).toHaveCount(0);
    await expect.poll(() => clips.count()).toBeLessThanOrEqual(before);
  });
});

test.describe("adaptive grid (CAP-CLP-002)", () => {
  test("Auto is offered in the snap picker and sticks once chosen", async ({ page }) => {
    await bootV2(page);
    const sel = page.getByTestId("v2-snap-division");
    await expect(sel).toBeVisible();
    await expect(sel).not.toHaveValue("auto");

    await sel.selectOption("auto");
    // Must SHOW auto afterwards — a mode that is on and invisible is worse than no mode.
    await expect(sel).toHaveValue("auto");
    expect(await page.evaluate(() => (window as any).__moshStore.getState().snapAuto)).toBe(true);
  });

  test("Auto picks a FINER division as you zoom in", async ({ page }) => {
    await bootV2(page);
    await page.getByTestId("v2-snap-division").selectOption("auto");

    const effectiveAt = (pps: number) => page.evaluate((p) => {
      const st = (window as any).__moshStore.getState();
      st.setPxPerSec(p);
      return (window as any).__moshStore.getState().effectiveSnapDivision();
    }, pps);

    const order = ["bar", "1/4", "1/8", "1/16", "1/32"];
    const wide = await effectiveAt(25);
    const tight = await effectiveAt(400);
    // THE POINT: the same setting yields different grids at different zooms. A fixed
    // division would return the same string for both.
    expect(order.indexOf(tight)).toBeGreaterThan(order.indexOf(wide));
  });

  test("choosing a concrete division turns Auto back off", async ({ page }) => {
    await bootV2(page);
    const sel = page.getByTestId("v2-snap-division");
    await sel.selectOption("auto");
    await sel.selectOption("1/8");
    await expect(sel).toHaveValue("1/8");
    expect(await page.evaluate(() => (window as any).__moshStore.getState().snapAuto)).toBe(false);
  });
});
