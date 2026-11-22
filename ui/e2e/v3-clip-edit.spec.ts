import { test, expect, type Page } from "@playwright/test";
import { bootV3, clipNum, dragClipBy, trimClipRightBy } from "./helpers";

// Shell-retirement step 2: the core clip-edit behaviours the old v2 specs
// clip-edit-fades / gesture-clip-regions / ripple-delete asserted, re-homed on the V3 boot.
//
// V3's Arrangement has NO UI for clip fades / reverse / normalize / gain / loop region, and no
// ripple-delete action (only a store-level ripple flag that nothing in V3 toggles). Those are
// marked NO-V3-UI below: the command is driven through the same store.exec seam the UI uses
// (execute_command -> MoshOps), and the snapshot is asserted, with one-⌘Z undo. If V3 grows
// the control, swap the exec call for a click and keep the assertions.

type Clip = { id: string; start: number; length: number; gainDb?: number; fadeInSec?: number; fadeOutSec?: number;
  fadeInType?: number; fadeOutType?: number; reversed?: boolean; loopEnabled?: boolean; loopStart?: number; loopLength?: number };
type Trk = { id: string; name: string; clips: Clip[] };

const tracks = (page: Page) =>
  page.evaluate(() => (window as unknown as { __moshStore: { getState: () => { snapshot: { tracks: Trk[] } } } })
    .__moshStore.getState().snapshot.tracks);
const clipById = async (page: Page, id: string) => {
  for (const t of await tracks(page)) { const c = t.clips.find((x) => x.id === id); if (c) return c; }
  return undefined;
};
const trackClips = async (page: Page, name: string) =>
  (await tracks(page)).find((t) => t.name === name)!.clips.map((c) => [c.start, c.length]).sort((a, b) => a[0] - b[0]);
const run = (page: Page, command: string, args: Record<string, unknown>) =>
  page.evaluate(([c, a]) => (window as unknown as { __moshStore: { getState: () => { exec: (c: string, a: Record<string, unknown>) => Promise<{ ok?: boolean }> } } })
    .__moshStore.getState().exec(c as string, a as Record<string, unknown>), [command, args] as const);
const undo = async (page: Page) => { await page.locator("body").click({ position: { x: 1, y: 1 } }); await page.keyboard.press("ControlOrMeta+z"); };

const KEYS_WAVE = "103";   // the seeded audio clip on Keys (start 2, length 6)

test.describe("clip edit commands (NO-V3-UI: driven through exec)", () => {
  test("set_clip_fade: fade durations and curves read back from the snapshot, one undo each", async ({ page }) => {
    await bootV3(page);
    expect((await clipById(page, KEYS_WAVE))?.fadeInSec ?? 0).toBe(0);     // anti-vacuity baseline
    expect((await run(page, "set_clip_fade", { clipId: KEYS_WAVE, fadeInSec: 0.5, fadeOutSec: 1 })).ok).toBe(true);
    expect((await run(page, "set_clip_fade", { clipId: KEYS_WAVE, curveOut: "sCurve" })).ok).toBe(true);
    let c = (await clipById(page, KEYS_WAVE))!;
    expect([c.fadeInSec, c.fadeOutSec, c.fadeOutType]).toEqual([0.5, 1, 4]);

    await undo(page);                                                       // the curve change only
    c = (await clipById(page, KEYS_WAVE))!;
    expect([c.fadeInSec, c.fadeOutSec]).toEqual([0.5, 1]);
    expect(c.fadeOutType).not.toBe(4);
    await undo(page);                                                       // the durations
    c = (await clipById(page, KEYS_WAVE))!;
    expect(c.fadeInSec ?? 0).toBe(0);
    expect(c.fadeOutSec ?? 0).toBe(0);
  });

  test("set_clip_reverse toggles and undoes in one step", async ({ page }) => {
    await bootV3(page);
    expect(Boolean((await clipById(page, KEYS_WAVE))?.reversed)).toBe(false);
    expect((await run(page, "set_clip_reverse", { clipId: KEYS_WAVE, reversed: true })).ok).toBe(true);
    expect((await clipById(page, KEYS_WAVE))?.reversed).toBe(true);
    await undo(page);
    expect(Boolean((await clipById(page, KEYS_WAVE))?.reversed)).toBe(false);
  });

  test("normalize_clip and set_clip_gain move the clip gain, one undo each", async ({ page }) => {
    await bootV3(page);
    const before = (await clipById(page, KEYS_WAVE))?.gainDb ?? 0;
    expect((await run(page, "normalize_clip", { clipId: KEYS_WAVE })).ok).toBe(true);
    const normalized = (await clipById(page, KEYS_WAVE))!.gainDb;
    expect(normalized).not.toBe(before);                                    // the mock normalizes a -6 dBFS peak to 0 dB: +6
    expect((await run(page, "set_clip_gain", { clipId: KEYS_WAVE, gainDb: -4 })).ok).toBe(true);
    expect((await clipById(page, KEYS_WAVE))?.gainDb).toBe(-4);
    await undo(page);
    expect((await clipById(page, KEYS_WAVE))?.gainDb).toBe(normalized);
    await undo(page);
    expect((await clipById(page, KEYS_WAVE))?.gainDb ?? 0).toBe(before);
  });

  test("set_clip_loop enables a loop region and disabling it zeroes the region without moving the clip", async ({ page }) => {
    await bootV3(page);
    expect(Boolean((await clipById(page, KEYS_WAVE))?.loopEnabled)).toBe(false);
    expect((await run(page, "set_clip_loop", { clipId: KEYS_WAVE, enabled: true, start: 0, length: 1 })).ok).toBe(true);
    let c = (await clipById(page, KEYS_WAVE))!;
    expect([c.loopEnabled, c.loopStart, c.loopLength]).toEqual([true, 0, 1]);
    expect((await run(page, "set_clip_loop", { clipId: KEYS_WAVE, enabled: false })).ok).toBe(true);
    c = (await clipById(page, KEYS_WAVE))!;
    expect([c.loopEnabled, c.loopLength, c.start, c.length]).toEqual([false, 0, 2, 6]);
    // enabling with a non-positive length is refused and leaves the clip alone
    expect((await run(page, "set_clip_loop", { clipId: KEYS_WAVE, enabled: true, length: 0 })).ok).toBeFalsy();
    await undo(page);                                                       // back to the 1 s loop
    expect((await clipById(page, KEYS_WAVE))?.loopLength).toBe(1);
  });
});

test.describe("ripple (NO-V3-UI: V3 has no ripple-delete action or ripple toggle)", () => {
  test("delete_time_range ripple:true closes the gap on every track and undoes in one step", async ({ page }) => {
    await bootV3(page);
    expect(await trackClips(page, "Drums")).toEqual([[0, 8]]);
    expect(await trackClips(page, "Keys")).toEqual([[2, 6]]);
    expect((await run(page, "delete_time_range", { start: 1, end: 3, ripple: true })).ok).toBe(true);
    // Drums split at 1 and 3, the middle 2 s gone, the right half slid left onto the left half.
    expect(await trackClips(page, "Drums")).toEqual([[0, 1], [1, 5]]);
    expect(await trackClips(page, "Keys")).toEqual([[1, 5]]);
    await undo(page);
    expect(await trackClips(page, "Drums")).toEqual([[0, 8]]);
    expect(await trackClips(page, "Keys")).toEqual([[2, 6]]);
  });

  test("delete_time_range without ripple leaves the gap", async ({ page }) => {
    await bootV3(page);
    expect((await run(page, "delete_time_range", { start: 1, end: 3 })).ok).toBe(true);
    expect(await trackClips(page, "Drums")).toEqual([[0, 1], [3, 5]]);
    await undo(page);
    expect(await trackClips(page, "Drums")).toEqual([[0, 8]]);
  });

  test("move_clip and trim_clip with ripple:true carry later clips on the same track", async ({ page }) => {
    await bootV3(page);
    expect((await run(page, "duplicate_clip", { clipId: "101" })).ok).toBe(true);        // a second Drums clip after the first
    const drums = (await tracks(page)).find((t) => t.name === "Drums")!.clips.sort((a, b) => a.start - b.start);
    expect(drums).toHaveLength(2);
    const [first, second] = drums;
    const secondStart = second.start;
    expect((await run(page, "trim_clip", { clipId: first.id, start: first.start, length: first.length - 2, ripple: true })).ok).toBe(true);
    expect((await clipById(page, second.id))?.start).toBeCloseTo(secondStart - 2, 5);    // the gap closed
    expect((await run(page, "move_clip", { clipId: first.id, start: first.start + 1, ripple: true })).ok).toBe(true);
    expect((await clipById(page, second.id))?.start).toBeCloseTo(secondStart - 1, 5);    // and the move carried it
  });
});

// ── gesture regions: the "Mouse gestures" model decides what a clip drag does ──────────

async function bootGestures(page: Page, gestureTable: "mosh" | "ableton") {
  await page.addInitScript((gt) => {
    window.localStorage.clear();
    window.localStorage.setItem("mosh.settings", JSON.stringify({
      version: 2, template: null, values: { colorway: "lime", startOnLaunch: false, gestureTable: gt }, keyOverrides: {},
    }));
  }, gestureTable);
  await page.goto("/?shell=v3");
  await expect(page.getByTestId("v3-arrangement")).toBeVisible();
}
const keysClip = (page: Page) =>
  page.locator('[data-testid="v3-track"]').filter({ hasText: "Keys" }).getByTestId("v3-clip").first();

test.describe("clip gesture regions (V3 honours the gestureTable setting)", () => {
  test("Mosh: the whole clip drags to MOVE through move_clip, in one undo", async ({ page }) => {
    await bootGestures(page, "mosh");
    const clip = keysClip(page);
    expect(await clipNum(clip, "data-clip-start")).toBe(2);
    await dragClipBy(page, clip, 160);                                      // +2 s at 80 px/s
    await expect.poll(() => clipNum(clip, "data-clip-start")).toBe(4);
    expect((await clipById(page, KEYS_WAVE))?.start).toBe(4);
    await undo(page);
    await expect.poll(() => clipNum(clip, "data-clip-start")).toBe(2);
  });

  test("Ableton: the same body drag does NOT move the clip (it is a time selection, which V3 has no band for)", async ({ page }) => {
    await bootGestures(page, "ableton");
    const clip = keysClip(page);
    const box = (await clip.boundingBox())!;
    await dragClipBy(page, clip, 160);
    // Anti-vacuity: under Mosh this exact drag moved the clip (previous test). A hardcoded Mosh
    // table would move it here too.
    expect(await clipNum(clip, "data-clip-start")).toBe(2);
    expect((await clipById(page, KEYS_WAVE))?.start).toBe(2);
    expect(Math.round((await clip.boundingBox())!.x)).toBe(Math.round(box.x));
  });

  test("Ableton: the right edge still trims", async ({ page }) => {
    await bootGestures(page, "ableton");
    const clip = keysClip(page);
    expect(await clipNum(clip, "data-clip-length")).toBe(6);
    await trimClipRightBy(page, clip, -80);                                 // -1 s
    await expect.poll(() => clipNum(clip, "data-clip-length")).toBe(5);
    expect((await clipById(page, KEYS_WAVE))?.length).toBe(5);
  });
});
