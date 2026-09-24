import { test, expect } from "@playwright/test";
import { bootV3 } from "./helpers";

// V3 parity brief rows 2–3: drop in a beat (one command, one undo) and generate one from the
// Moshi dock (the deterministic loop script; the brain proxy is unreachable under Playwright).
// Never join a multiplayer room in this file — an active session disables the loop.

type MoshWindow = Window & { __moshStore?: { getState: () => {
  snapshot?: { session: { tempo: number }; tracks: { id: string; type?: string; clips: { id: string; notes?: unknown[] }[] }[] };
  transport: { position: number; looping?: boolean; loopStart: number; loopEnd: number };
  exec: (c: string, a?: Record<string, unknown>) => Promise<unknown>;
} } };
const store = (page: Parameters<typeof bootV3>[0]) => ({
  tempo: () => page.evaluate(() => (window as unknown as MoshWindow).__moshStore!.getState().snapshot!.session.tempo),
  loop: () => page.evaluate(() => {
    const t = (window as unknown as MoshWindow).__moshStore!.getState().transport;
    return { looping: !!t.looping, loopStart: t.loopStart, loopEnd: t.loopEnd };
  }),
  seek: (sec: number) => page.evaluate((s) => (window as unknown as MoshWindow).__moshStore!.getState().exec("set_transport", { position: s }), sec),
});
const noteCount = (page: Parameters<typeof bootV3>[0], clipId: string) =>
  page.evaluate((id) => {
    const snap = (window as unknown as MoshWindow).__moshStore?.getState().snapshot;
    for (const t of snap?.tracks ?? []) for (const c of t.clips) if (c.id === id) return c.notes?.length ?? 0;
    return -1;
  }, clipId);

test("+ Drum beat lands a four-bar drum clip, selects it with no editor modal, and one undo removes it", async ({ page }) => {
  await bootV3(page);
  const tracks = page.getByTestId("v3-track");
  const clips = page.getByTestId("v3-clip");
  await expect(tracks.first()).toBeVisible();
  const tracksBefore = await tracks.count();
  const clipsBefore = await clips.count();

  await page.getByTestId("v3-add-drum-beat").click();
  await expect(tracks).toHaveCount(tracksBefore + 1);
  await expect(clips).toHaveCount(clipsBefore + 1);
  const newTrack = tracks.last();
  await expect(newTrack.locator(".midi-tag")).toBeVisible();
  const clip = newTrack.getByTestId("v3-clip").first();
  const clipId = await clip.getAttribute("data-clip-id");
  expect(clipId).toBeTruthy();
  // four bars at the session tempo (8 s at the mock's 120 BPM), the one-bar pattern tiled x4
  const barSec = (4 * 60) / await store(page).tempo();
  expect(Number(await clip.getAttribute("data-clip-length"))).toBeCloseTo(4 * barSec, 6);
  expect(await noteCount(page, clipId!), "14 hits per bar x 4 bars (anti-vacuity)").toBe(56);
  // selected, and NO modal: the Drum Machine editor stays closed so Loop / Play are reachable
  await expect(clip).toHaveAttribute("aria-pressed", "true");
  await expect(page.locator(".modal-backdrop")).toHaveCount(0);
  await expect(page.getByTestId("pr-note")).toHaveCount(0);

  await page.keyboard.press("ControlOrMeta+z");
  await expect(tracks).toHaveCount(tracksBefore);
  await expect(clips).toHaveCount(clipsBefore);
});

test("in an empty session + Drum beat lands at bar 1 and sets the loop region to the clip; Loop then arms exactly it", async ({ page }) => {
  await bootV3(page);
  await page.getByTestId("v3-file-trigger").click();
  await page.getByRole("menuitem", { name: "New Session" }).click();
  await expect(page.getByTestId("v3-track")).toHaveCount(0);
  await store(page).seek(5.3);                                   // a playhead past bar 1 (anti-vacuity)
  expect(await store(page).loop()).toEqual({ looping: false, loopStart: 0, loopEnd: 0 });

  await page.getByTestId("v3-add-drum-beat").click();
  const clip = page.getByTestId("v3-clip");
  await expect(clip).toHaveCount(1);
  expect(Number(await clip.getAttribute("data-clip-start"))).toBe(0);
  const len = Number(await clip.getAttribute("data-clip-length"));
  expect(len).toBeCloseTo((4 * 4 * 60) / await store(page).tempo(), 6);
  await expect.poll(() => store(page).loop()).toEqual({ looping: false, loopStart: 0, loopEnd: len });

  await page.getByTestId("v3-topbar").getByRole("button", { name: "Loop", exact: true }).click();
  await expect.poll(() => store(page).loop()).toEqual({ looping: true, loopStart: 0, loopEnd: len });
});

test("a lofi ask in the Moshi dock lands a drum track, and one undo reverts the task", async ({ page }) => {
  await bootV3(page);
  const tracks = page.getByTestId("v3-track");
  await expect(tracks.first()).toBeVisible();
  const tracksBefore = await tracks.count();

  await page.getByTestId("v3-moshi-field").fill("build me a lofi sketch");
  await page.getByTestId("v3-moshi-send").click();
  await expect(tracks).toHaveCount(tracksBefore + 1, { timeout: 15_000 });
  // The bare ask takes the fast path to generate_beat_recipe, not the free-form loop.
  await expect(tracks.filter({ hasText: "Recipe Drums" })).toHaveCount(1);
  await expect(page.getByTestId("v3-moshi-field")).toBeEnabled({ timeout: 15_000 });

  await page.keyboard.press("ControlOrMeta+z");
  await expect(tracks).toHaveCount(tracksBefore);
});
