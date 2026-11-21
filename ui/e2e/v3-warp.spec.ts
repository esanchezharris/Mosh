import { test, expect, type Page } from "@playwright/test";
import { bootV3, clipNum } from "./helpers";

// Shell-retirement step 2: the audio-warp behaviours the old v2 warp.spec asserted
// (warp toggle + badge, "Fit 4 bars" stretch, Detect BPM), on the V3 boot.
//
// NO-V3-UI: V3 has no Warp inspector, no warp badge and no Fit-bars helper (a V3 clip-edge
// drag under the "stretch" gesture trims instead; see Arrangement.tsx onDown). The V3 beat
// card calls detect_clip_bpm itself (beatImport.ts) but never warps. So the commands are
// driven through the same store.exec seam the UI uses and asserted on the snapshot — and on
// the V3 clip's rendered length where the stretch is visible. If V3 grows a Warp control,
// replace the exec calls with clicks and keep the assertions.

type Clip = { id: string; start: number; length: number; autoTempo?: boolean; sourceBpm?: number; stretchMode?: string };
const KEYS_WAVE = "103";   // the seeded audio clip on Keys: start 2, length 6 s
const KEYS_MIDI = "101";   // Drums' MIDI clip

const clip = (page: Page, id: string) =>
  page.evaluate((cid) => {
    const s = (window as unknown as { __moshStore: { getState: () => { snapshot: { tracks: { clips: Clip[] }[] } } } }).__moshStore.getState().snapshot;
    for (const t of s.tracks) { const c = t.clips.find((x) => x.id === cid); if (c) return c; }
    return undefined;
  }, id);
const run = (page: Page, command: string, args: Record<string, unknown>) =>
  page.evaluate(([c, a]) => (window as unknown as { __moshStore: { getState: () => { exec: (c: string, a: Record<string, unknown>) => Promise<{ ok?: boolean; error?: string; data?: { bpm?: number; confidence?: number } }> } } })
    .__moshStore.getState().exec(c as string, a as Record<string, unknown>), [command, args] as const);
const undo = async (page: Page) => { await page.locator("body").click({ position: { x: 1, y: 1 } }); await page.keyboard.press("ControlOrMeta+z"); };
const keysClip = (page: Page) =>
  page.locator('[data-testid="v3-track"]').filter({ hasText: "Keys" }).getByTestId("v3-clip").first();

test("set_clip_warp turns warp on (detecting the BPM) and off, one undo each", async ({ page }) => {
  await bootV3(page);
  expect((await clip(page, KEYS_WAVE))?.autoTempo ?? false).toBe(false);   // anti-vacuity: not warped yet

  expect((await run(page, "set_clip_warp", { clipId: KEYS_WAVE, autoTempo: true, detect: true })).ok).toBe(true);
  let c = (await clip(page, KEYS_WAVE))!;
  expect(c.autoTempo).toBe(true);
  expect(c.stretchMode).toBeTruthy();                                       // defaults to the SoundTouch mode
  expect(c.sourceBpm).toBe(120);                                            // the mock's detect stub

  expect((await run(page, "set_clip_warp", { clipId: KEYS_WAVE, autoTempo: false })).ok).toBe(true);
  c = (await clip(page, KEYS_WAVE))!;
  expect(c.autoTempo).toBe(false);
  expect(c.sourceBpm).toBeUndefined();                                      // carried only while warp is on

  await undo(page);
  expect((await clip(page, KEYS_WAVE))?.autoTempo).toBe(true);
  await undo(page);
  expect((await clip(page, KEYS_WAVE))?.autoTempo ?? false).toBe(false);
});

test("set_clip_warp refuses a MIDI clip and a call without autoTempo", async ({ page }) => {
  await bootV3(page);
  expect((await run(page, "set_clip_warp", { clipId: KEYS_MIDI, autoTempo: true })).ok).toBeFalsy();
  expect((await run(page, "set_clip_warp", { clipId: KEYS_WAVE })).ok).toBeFalsy();
  expect((await clip(page, KEYS_WAVE))?.autoTempo ?? false).toBe(false);
});

test("stretch_clip {bars:4} time-stretches the audio clip to fill 4 bars and the V3 lane shows it wider", async ({ page }) => {
  await bootV3(page);
  const el = keysClip(page);
  const before = (await el.boundingBox())!;
  expect(await clipNum(el, "data-clip-length")).toBe(6);

  expect((await run(page, "stretch_clip", { clipId: KEYS_WAVE, bars: 4 })).ok).toBe(true);   // 4 bars @120 4/4 = 8 s
  await expect.poll(() => clipNum(el, "data-clip-length")).toBe(8);
  const c = (await clip(page, KEYS_WAVE))!;
  expect(c.autoTempo).toBe(true);
  expect(c.sourceBpm).toBeCloseTo(160, 5);                                  // 120 × 8 / 6
  expect((await el.boundingBox())!.width).toBeGreaterThan(before.width + 8);

  await undo(page);
  await expect.poll(() => clipNum(el, "data-clip-length")).toBe(6);
  expect((await clip(page, KEYS_WAVE))?.autoTempo ?? false).toBe(false);
});

test("stretch_clip {length} sets an explicit length and rejects a non-positive one", async ({ page }) => {
  await bootV3(page);
  expect((await run(page, "stretch_clip", { clipId: KEYS_WAVE, length: 3 })).ok).toBe(true);
  expect((await clip(page, KEYS_WAVE))?.length).toBeCloseTo(3, 5);
  expect((await run(page, "stretch_clip", { clipId: KEYS_WAVE, length: 0 })).ok).toBeFalsy();
  expect((await run(page, "stretch_clip", { clipId: KEYS_WAVE })).ok).toBeFalsy();   // neither length nor bars
});

test("detect_clip_bpm is read-only and surfaces a reading with a confidence", async ({ page }) => {
  await bootV3(page);
  const r = await run(page, "detect_clip_bpm", { clipId: KEYS_WAVE });
  expect(r.ok).toBe(true);
  expect(r.data?.bpm).toBe(120);
  expect(r.data?.confidence ?? 0).toBeGreaterThan(0.5);
  expect((await clip(page, KEYS_WAVE))?.autoTempo ?? false).toBe(false);   // a reading, not an edit
  expect((await run(page, "detect_clip_bpm", { clipId: KEYS_MIDI })).ok).toBeFalsy();   // MIDI has no pulse to read
});
