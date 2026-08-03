// TRK-REORDER (#550) — move a track up or down the arrangement.
//
// `--selftest` already proves the ENGINE half exhaustively (12 checks): the off-by-one
// between moving up and moving down, out-of-range clamping, a same-index move succeeding
// without polluting undo, undo restoring the row, and the refusal to reorder a track that
// lives inside a group (which would silently reparent it — changing routing, i.e. sound,
// from a command that promises only to change order).
//
// This spec is for the half a headless harness cannot see: that a producer can REACH the
// reorder, that the arrangement visibly re-orders, and that the controls tell the truth at
// the boundaries rather than sitting there doing nothing.
//
// Honest scope note: all four reference DAWs reorder tracks by DRAGGING the header, so
// drag is the 2-of-4 idiom and is still owed. Buttons are a real affordance in the
// meantime (Reaper and Pro Tools also expose track-move as a command) — a missing
// convenience, not a false surface.

import { test, expect, type Page } from "@playwright/test";
import { bootV2 } from "./helpers";

const names = (page: Page) =>
  page.getByTestId("v2-track-header").evaluateAll((els) =>
    els.map((e) => e.querySelector(".v2-lname")?.textContent ?? ""));

test.describe("track reorder (#550)", () => {
  test("Move down swaps a track with the one below it", async ({ page }) => {
    await bootV2(page);
    const before = await names(page);
    test.skip(before.length < 2, "fixture has fewer than two tracks");

    await page.getByTestId("v2-track-header").first().hover();
    await page.getByTestId("v2-track-move-down").first().click();

    const expected = [before[1], before[0], ...before.slice(2)];
    await expect.poll(() => names(page)).toEqual(expected);
  });

  test("Move up is the exact inverse — no off-by-one", async ({ page }) => {
    await bootV2(page);
    const before = await names(page);
    test.skip(before.length < 2, "fixture has fewer than two tracks");

    await page.getByTestId("v2-track-header").first().hover();
    await page.getByTestId("v2-track-move-down").first().click();
    await expect.poll(() => names(page)).not.toEqual(before);

    // The moved track is now second; send it back.
    await page.getByTestId("v2-track-header").nth(1).hover();
    await page.getByTestId("v2-track-move-up").nth(1).click();
    await expect.poll(() => names(page)).toEqual(before);
  });

  test("the ends are DISABLED rather than silently doing nothing", async ({ page }) => {
    await bootV2(page);
    const n = await page.getByTestId("v2-track-header").count();
    test.skip(n < 2, "fixture has fewer than two tracks");

    await page.getByTestId("v2-track-header").first().hover();
    await expect(page.getByTestId("v2-track-move-up").first()).toBeDisabled();
    await expect(page.getByTestId("v2-track-move-down").first()).toBeEnabled();

    await page.getByTestId("v2-track-header").nth(n - 1).hover();
    await expect(page.getByTestId("v2-track-move-down").nth(n - 1)).toBeDisabled();
    await expect(page.getByTestId("v2-track-move-up").nth(n - 1)).toBeEnabled();
  });

  test("the lanes follow the headers — the whole row moves, not just the label", async ({ page }) => {
    await bootV2(page);
    const ids = () => page.getByTestId("v2-lane").evaluateAll((els) =>
      els.map((e) => (e as HTMLElement).dataset.trackId ?? ""));
    const before = await ids();
    test.skip(before.length < 2, "fixture has fewer than two tracks");

    await page.getByTestId("v2-track-header").first().hover();
    await page.getByTestId("v2-track-move-down").first().click();
    await expect.poll(ids).toEqual([before[1], before[0], ...before.slice(2)]);
  });
});
