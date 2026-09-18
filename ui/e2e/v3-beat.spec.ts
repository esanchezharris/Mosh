import { test, expect } from "@playwright/test";
import { bootV3 } from "./helpers";

// V3 parity brief rows 2–3: drop in a beat (one command, one undo) and generate one from the
// Moshi dock (the deterministic loop script; the brain proxy is unreachable under Playwright).
// Never join a multiplayer room in this file — an active session disables the loop.

type MoshWindow = Window & { __moshStore?: { getState: () => { snapshot?: { tracks: { id: string; type?: string; clips: { id: string; notes?: unknown[] }[] }[] } } } };
const noteCount = (page: Parameters<typeof bootV3>[0], clipId: string) =>
  page.evaluate((id) => {
    const snap = (window as unknown as MoshWindow).__moshStore?.getState().snapshot;
    for (const t of snap?.tracks ?? []) for (const c of t.clips) if (c.id === id) return c.notes?.length ?? 0;
    return -1;
  }, clipId);

test("+ Drum beat lands a drum track with a played clip, opens the pads editor, and one undo removes it", async ({ page }) => {
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
  const clipId = await newTrack.getByTestId("v3-clip").first().getAttribute("data-clip-id");
  expect(clipId).toBeTruthy();
  expect(await noteCount(page, clipId!), "the clip carries the pattern's notes (anti-vacuity)").toBeGreaterThan(8);
  // the shared editor opened on the drum clip and draws its notes
  const editorNotes = page.getByTestId("pr-note");
  expect(await editorNotes.count()).toBeGreaterThan(8);
  await page.keyboard.press("Escape");
  await expect(editorNotes).toHaveCount(0);

  await page.keyboard.press("ControlOrMeta+z");
  await expect(tracks).toHaveCount(tracksBefore);
  await expect(clips).toHaveCount(clipsBefore);
});

test("a lofi ask in the Moshi dock lands a drum track, and one undo reverts the task", async ({ page }) => {
  await bootV3(page);
  const tracks = page.getByTestId("v3-track");
  await expect(tracks.first()).toBeVisible();
  const tracksBefore = await tracks.count();

  await page.getByTestId("v3-moshi-field").fill("build me a lofi sketch");
  await page.getByTestId("v3-moshi-send").click();
  await expect(tracks).toHaveCount(tracksBefore + 1, { timeout: 15_000 });
  await expect(page.getByTestId("v3-moshi-field")).toBeEnabled({ timeout: 15_000 });

  await page.keyboard.press("ControlOrMeta+z");
  await expect(tracks).toHaveCount(tracksBefore);
});
