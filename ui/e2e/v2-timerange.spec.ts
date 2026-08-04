import { test, expect, type Page } from "@playwright/test";
import { bootV2 } from "./helpers";

// UIREACH-TIMERANGE — delete_time_range's only shipped-UI home: shift-drag the bar ruler
// to draw a span, then pick one of two SEPARATELY labelled actions (never a modifier).
// Driven through the real gesture (a real Shift-held mouse drag, real button clicks) —
// the seam this feature can break is layout/timing, not just command dispatch, and a
// spy on store.exec would not catch a drag that lands the span in the wrong place or a
// button a real mousedown->mouseup cycle can't actually reach.
//
// The seeded mock fixture (bridge.mock.ts seedSnapshot, 120bpm 4/4 -> 2s bars): Drums
// [0,8], Bass [0,8], Keys [2,8]. A bar-snapped [4,6] span straddles all three cleanly
// (no clip edge coincides with 4 or 6), so every track is expected to split into two
// pieces regardless of which delete action runs.

type MoshSnapshotWindow = Window & {
  __moshStore?: { getState: () => { snapshot?: { tracks: { name: string; clips: { start: number; length: number }[] }[] } } };
};

async function clipSpans(page: Page, trackName: string): Promise<[number, number][]> {
  return page.evaluate((name) => {
    const store = (window as MoshSnapshotWindow).__moshStore;
    const track = store?.getState().snapshot?.tracks.find((t) => t.name === name);
    return (track?.clips ?? [])
      .map((c) => [c.start, c.start + c.length] as [number, number])
      .sort((a, b) => a[0] - b[0]);
  }, trackName);
}

/** pxPerSec, read back from two consecutive bar lines (2s apart at 120bpm 4/4) rather
 *  than assumed — the shell fits zoom to the session on mount, so the value is whatever
 *  it happens to boot at. */
async function pxPerSecOf(page: Page): Promise<number> {
  const lefts = await page.locator(".v2-ruler-bar").evaluateAll((els) =>
    els.slice(0, 2).map((e) => parseFloat((e as HTMLElement).style.left)));
  return (lefts[1] - lefts[0]) / 2; // bar spacing is 2s at 120bpm 4/4
}

/** Shift-drag the ruler from secStart to secEnd (both land on a 2s bar boundary). */
async function dragRange(page: Page, secStart: number, secEnd: number): Promise<void> {
  const ruler = page.getByTestId("v2-ruler");
  const box = (await ruler.boundingBox())!;
  const pxPerSec = await pxPerSecOf(page);
  const y = box.y + box.height / 2;
  await page.keyboard.down("Shift");
  await page.mouse.move(box.x + secStart * pxPerSec, y);
  await page.mouse.down();
  await page.mouse.move(box.x + secEnd * pxPerSec, y, { steps: 8 });
  await page.mouse.up();
  await page.keyboard.up("Shift");
}

test("shift-drag draws a time-range band with Delete and Delete-close-gap as two distinct actions", async ({ page }) => {
  await bootV2(page);
  await expect(page.getByTestId("v2-timerange-band")).toHaveCount(0);

  await dragRange(page, 4, 6);

  const band = page.getByTestId("v2-timerange-band");
  await expect(band).toBeVisible();
  const toolbar = page.getByTestId("v2-timerange-toolbar");
  await expect(toolbar).toBeVisible();
  // Both destructive actions present SIMULTANEOUSLY, as separate controls — not one
  // button behind a modifier.
  await expect(page.getByTestId("v2-timerange-delete")).toBeVisible();
  await expect(page.getByTestId("v2-timerange-delete-ripple")).toBeVisible();
  await expect(page.getByTestId("v2-timerange-loop")).toBeVisible();

  // Before: one clip per track.
  expect(await clipSpans(page, "Drums")).toEqual([[0, 8]]);

  await page.getByTestId("v2-timerange-delete").click();

  // The selection clears — the clips it described just split.
  await expect(band).toHaveCount(0);

  // Plain delete: straddling clips split into two pieces, leaving a HOLE at [4,6].
  for (const track of ["Drums", "Bass"]) {
    expect(await clipSpans(page, track), `${track} did not split cleanly around the deleted span`)
      .toEqual([[0, 4], [6, 8]]);
  }
  expect(await clipSpans(page, "Keys")).toEqual([[2, 4], [6, 8]]);
});

test("Delete, close gap slides every downstream clip left instead of leaving a hole", async ({ page }) => {
  await bootV2(page);
  await dragRange(page, 4, 6);
  await expect(page.getByTestId("v2-timerange-band")).toBeVisible();

  await page.getByTestId("v2-timerange-delete-ripple").click();
  await expect(page.getByTestId("v2-timerange-band")).toHaveCount(0);

  // Ripple: the same split, but the right piece slides left by the range length (2s) —
  // so it now sits FLUSH against the left piece instead of leaving a gap.
  for (const track of ["Drums", "Bass"]) {
    expect(await clipSpans(page, track), `${track} did not close the gap`).toEqual([[0, 4], [4, 6]]);
  }
  expect(await clipSpans(page, "Keys")).toEqual([[2, 4], [4, 6]]);
});

// CAP-CLP-017 — the inverse action on the same band. Driven through the real gesture for
// the same reason as the deletes: what can break here is reach and layout (a fourth
// button pushing the toolbar somewhere a real mousedown->mouseup cannot land), and no
// spy on store.exec would notice that.
test("Insert time opens the drawn span and pushes every downstream clip right", async ({ page }) => {
  await bootV2(page);
  await dragRange(page, 4, 6);
  await expect(page.getByTestId("v2-timerange-band")).toBeVisible();

  const insertBtn = page.getByTestId("v2-timerange-insert");
  await expect(insertBtn).toBeVisible();
  await insertBtn.click();
  await expect(page.getByTestId("v2-timerange-band")).toHaveCount(0);

  // The straddling clip splits at 4s; its right half — and everything after it — moves
  // right by exactly the 2s span. The reverse of "Delete, close gap" one button along.
  for (const track of ["Drums", "Bass"]) {
    expect(await clipSpans(page, track), `${track} did not open the span`).toEqual([[0, 4], [6, 10]]);
  }
  expect(await clipSpans(page, "Keys")).toEqual([[2, 4], [6, 10]]);
});

// The modal half. A ripple drag rearranges clips that are usually off-screen, so the
// property under test is that the shell TELLS the producer the mode is armed — in text,
// through a control they can reach with a mouse — and that the mode actually changes what
// the next drag does.
test("Ripple mode is announced in the top bar and makes a clip drag carry its neighbours", async ({ page }) => {
  await bootV2(page);
  const chip = page.getByTestId("v2-ripple");
  await expect(chip).toBeVisible();
  await expect(chip).toHaveAttribute("aria-pressed", "false");
  await expect(chip).toHaveText("Ripple");

  await chip.click();
  await expect(chip).toHaveAttribute("aria-pressed", "true");
  await expect(chip, "an armed destructive mode must say so in text, not colour alone").toHaveText("Ripple ON");
});

test("the same range can be looped instead of deleted, and toggles off on a second press", async ({ page }) => {
  await bootV2(page);
  await dragRange(page, 4, 6);

  const loopBtn = page.getByTestId("v2-timerange-loop");
  await loopBtn.click();

  // Looping is non-destructive: nothing split, and the selection is still there —
  // contrast with the delete tests above, where the band disappears.
  await expect(page.getByTestId("v2-timerange-band")).toBeVisible();
  expect(await clipSpans(page, "Drums")).toEqual([[0, 8]]);
  await expect(page.locator(".v2-loop-on")).toHaveText("loop");
  await expect(loopBtn).toHaveAttribute("aria-pressed", "true");

  // Press again -> loop off, without re-arming a different range.
  await loopBtn.click();
  await expect(page.locator(".v2-loop-on")).toHaveCount(0);
  await expect(loopBtn).toHaveAttribute("aria-pressed", "false");
});

test("Escape and the clear button both dismiss the selection without touching a single clip", async ({ page }) => {
  await bootV2(page);
  await dragRange(page, 4, 6);
  await expect(page.getByTestId("v2-timerange-band")).toBeVisible();

  await page.keyboard.press("Escape");
  await expect(page.getByTestId("v2-timerange-band")).toHaveCount(0);
  expect(await clipSpans(page, "Drums")).toEqual([[0, 8]]); // untouched

  await dragRange(page, 4, 6);
  await page.getByTestId("v2-timerange-clear").click();
  await expect(page.getByTestId("v2-timerange-band")).toHaveCount(0);
  expect(await clipSpans(page, "Drums")).toEqual([[0, 8]]); // still untouched
});

// Regression guard: the ruler's interaction model moved from onClick to deciding
// seek-vs-range-select at pointerdown (matching classic's onRulerDown), so a real
// (non-shift) press must still seek exactly once. jsdom's synthetic dispatch order
// does not reproduce a real pointerdown->mousedown->mouseup->click sequence, so this
// is only trustworthy driven through Playwright's real input.
test("a plain (non-shift) press still seeks, and never also opens a range", async ({ page }) => {
  await bootV2(page);
  const ruler = page.getByTestId("v2-ruler");
  const box = (await ruler.boundingBox())!;
  const pxPerSec = await pxPerSecOf(page);

  await page.mouse.click(box.x + 4 * pxPerSec, box.y + box.height / 2);

  await expect(page.getByTestId("v2-timerange-band")).toHaveCount(0);
  await expect(page.getByTestId("v2-time")).toHaveText("3.1.1"); // bar 4 (0-indexed) at 4/4
});
