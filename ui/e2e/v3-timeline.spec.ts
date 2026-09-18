import { test, expect } from "@playwright/test";
import { bootV3, clipNum, dragClipBy, trimClipRightBy } from "./helpers";

// V3 parity brief row 11 — zoom on the shared pxPerSec, and pointer move / trim / split through
// the same gesture table, drag commit and command seam v2 uses. At 120 BPM the default snap
// grid is a beat = 0.5 s, and 80 px = 1 s at the default zoom.

type MoshWindow = Window & { __moshStore?: { getState: () => { pxPerSec: number; snapshot?: { session: { length?: number } } } } };
const pxPerSec = (page: Parameters<typeof bootV3>[0]) =>
  page.evaluate(() => (window as unknown as MoshWindow).__moshStore!.getState().pxPerSec);

const chords = (page: Parameters<typeof bootV3>[0]) =>
  page.locator('[data-testid="v3-track"]').filter({ hasText: "Keys" }).getByTestId("v3-clip").first();

test("zoom in / out scales the lanes on the shared pxPerSec and the ruler follows", async ({ page }) => {
  await bootV3(page);
  expect(await pxPerSec(page)).toBe(80);
  const clip = chords(page);
  const before = (await clip.boundingBox())!;
  expect(Math.round(before.width)).toBe(480);                              // 6 s × 80 px (anti-vacuity)

  await page.getByTestId("v3-zoom-in").click();
  await expect.poll(() => pxPerSec(page)).toBe(100);
  await expect(page.getByTestId("v3-arrangement")).toHaveAttribute("data-px-per-sec", "100");
  await expect.poll(async () => Math.round((await clip.boundingBox())!.width)).toBe(600);
  expect(Math.round((await clip.boundingBox())!.x - before.x)).toBe(40);   // start 2 s: 160 → 200 px
  const sessionSec = await page.evaluate(() => (window as unknown as MoshWindow).__moshStore!.getState().snapshot!.session.length ?? 32);
  await expect(page.getByTestId("v3-ruler")).toHaveCSS("width", `${Math.ceil(sessionSec * 100)}px`);   // the whole session at this zoom

  await page.getByTestId("v3-zoom-out").click();
  await expect.poll(() => pxPerSec(page)).toBe(80);
  await expect.poll(async () => Math.round((await clip.boundingBox())!.width)).toBe(480);
});

test("pointer move and trim commit through move_clip / trim_clip and undo one step each", async ({ page }) => {
  await bootV3(page);
  const clip = chords(page);
  expect(await clipNum(clip, "data-clip-start")).toBe(2);
  expect(await clipNum(clip, "data-clip-length")).toBe(6);

  await dragClipBy(page, clip, 80);                                          // +1 s, on the beat grid
  await expect.poll(() => clipNum(clip, "data-clip-start")).toBe(3);
  await page.keyboard.press("ControlOrMeta+z");
  await expect.poll(() => clipNum(clip, "data-clip-start")).toBe(2);

  await trimClipRightBy(page, clip, -80);                                    // −1 s from the right edge
  await expect.poll(() => clipNum(clip, "data-clip-length")).toBe(5);
  expect(await clipNum(clip, "data-clip-start")).toBe(2);                    // a right trim keeps the start
  await page.keyboard.press("ControlOrMeta+z");
  await expect.poll(() => clipNum(clip, "data-clip-length")).toBe(6);
});

test("Split here in the context menu splits at the pointer's snapped time and one undo rejoins", async ({ page }) => {
  await bootV3(page);
  const keys = page.locator('[data-testid="v3-track"]').filter({ hasText: "Keys" });
  const clips = keys.getByTestId("v3-clip");
  await expect(clips).toHaveCount(1);
  const b = (await clips.first().boundingBox())!;
  await page.mouse.click(b.x + b.width / 2, b.y + b.height / 2, { button: "right" });
  await page.getByTestId("v3-context-split").click();
  await expect(clips).toHaveCount(2);
  expect(await clipNum(clips.nth(0), "data-clip-length")).toBe(3);          // 2 → 5 s
  expect(await clipNum(clips.nth(1), "data-clip-start")).toBe(5);
  await page.keyboard.press("ControlOrMeta+z");
  await expect(clips).toHaveCount(1);
});
