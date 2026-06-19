import { test, expect, type Locator } from "@playwright/test";
import {
  boot, newProject, clipsOnTrack, addAudioTrack, selectTrack, addMidiClip,
  setTool, dragClipBy, trimClipRightBy, splitClipAt, clipNum,
} from "./helpers";

// Arrangement gestures driven with REAL pointer events, so the configurable
// interaction layer (gesture table + feel drag-threshold / edge-grab + snap) is
// exercised, not just the command surface. Runs under the default Mosh template.

let trackId: string;
let clip: Locator;

test.beforeEach(async ({ page }) => {
  await boot(page);
  await newProject(page);
  await addAudioTrack(page);
  trackId = await selectTrack(page, 0);
  await addMidiClip(page);
  clip = clipsOnTrack(page, trackId).first();
  await expect(clip).toBeVisible();
});

test("drag a clip body moves it (move_clip)", async ({ page }) => {
  expect(await clipNum(clip, "data-clip-start")).toBe(0);
  await dragClipBy(page, clip, 120); // +120px ≈ +1.5s, snapped to the 1/4 grid
  await expect.poll(() => clipNum(clip, "data-clip-start")).toBeGreaterThan(0);
});

test("drag a clip's right edge trims it (trim_clip)", async ({ page }) => {
  const len0 = await clipNum(clip, "data-clip-length");
  expect(len0).toBeGreaterThan(1);
  await trimClipRightBy(page, clip, -80); // pull the end in ≈1s
  await expect.poll(() => clipNum(clip, "data-clip-length")).toBeLessThan(len0);
  expect(await clipNum(clip, "data-clip-length")).toBeGreaterThan(0);
});

test("split tool + click splits one clip into two (split_clip)", async ({ page }) => {
  await expect(clipsOnTrack(page, trackId)).toHaveCount(1);
  await setTool(page, "Split");
  await splitClipAt(page, clip, 0.5);
  await expect(clipsOnTrack(page, trackId)).toHaveCount(2);
});

test("delete key removes the selected clip", async ({ page }) => {
  await clip.click(); // select
  await expect(clip).toHaveAttribute("data-state", "selected");
  await page.keyboard.press("Delete");
  await expect(clipsOnTrack(page, trackId)).toHaveCount(0);
});
