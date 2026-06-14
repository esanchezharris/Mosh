import { expect, test } from "@playwright/test";
import { collectConsoleProblems, openApp, resetToEmpty, trackWithClip, waitForSnapshot } from "./helpers";
import { dragBy, dragClipEdge } from "./helpers";

// Arrangement editing end-to-end: create, move, trim, split, then transport + loop.
test("track / clip / move / trim / split / transport / loop", async ({ page, request }) => {
  const problems = collectConsoleProblems(page);
  await openApp(page);
  await resetToEmpty(request);

  // Add a track via the UI, confirm the header rendered.
  await page.getByTestId("add-track").click();
  let snap = await waitForSnapshot(request, (s) => s.tracks.length === 1);
  await expect(page.getByTestId("track-header")).toHaveCount(1);

  // Drop a clip on the lane.
  await page.getByTestId("lane").first().click({ position: { x: 220, y: 42 } });
  snap = await waitForSnapshot(request, (s) => s.tracks[0]?.clips.length === 1);
  const firstClipId = snap.tracks[0].clips[0].id;
  await expect(page.getByTestId("clip")).toHaveCount(1);

  // Drag-move.
  const clip = page.getByTestId("clip").first();
  const beforeMove = snap.tracks[0].clips[0].start;
  await dragBy(page, clip, 90);
  snap = await waitForSnapshot(request, (s) => (s.tracks[0]?.clips[0]?.start ?? beforeMove) > beforeMove + 0.5);

  // Trim right edge in, then left edge in.
  const movedLength = snap.tracks[0].clips[0].length;
  await dragClipEdge(page, page.getByTestId("clip").first(), "right", -60);
  snap = await waitForSnapshot(request, (s) => (s.tracks[0]?.clips[0]?.length ?? movedLength) < movedLength - 0.25);

  const movedStart = snap.tracks[0].clips[0].start;
  await dragClipEdge(page, page.getByTestId("clip").first(), "left", 56);
  snap = await waitForSnapshot(request, (s) => (s.tracks[0]?.clips[0]?.start ?? movedStart) > movedStart + 0.15);

  // Split via double-click → two clips, original id preserved.
  await page.getByTestId("clip").first().dblclick();
  snap = await waitForSnapshot(request, (s) => s.tracks[0]?.clips.length === 2);
  await expect(page.getByTestId("clip")).toHaveCount(2);
  expect(snap.tracks[0].clips.some((c) => c.id === firstClipId)).toBeTruthy();

  // Transport: play, stop (resets position), ruler seek, loop region.
  await page.getByTestId("transport-play").click();
  await waitForSnapshot(request, (s) => s.transport.playing);

  await page.getByTestId("transport-stop").click();
  snap = await waitForSnapshot(request, (s) => !s.transport.playing && s.transport.position === 0);
  expect(snap.transport.position).toBe(0);

  await page.getByTestId("ruler").click({ position: { x: 260, y: 12 } });
  snap = await waitForSnapshot(request, (s) => s.transport.position > 0.5);
  expect(snap.transport.position).toBeGreaterThan(0.5);

  await page.getByTestId("transport-loop").click();
  snap = await waitForSnapshot(request, (s) => s.transport.looping === true);
  expect(snap.transport.loopStart).toBe(0);
  expect(snap.transport.loopEnd).toBe(8);

  expect(problems).toEqual([]);
});

// trackWithClip is also exercised here so the helper itself is covered in isolation.
test("trackWithClip helper yields one track with one clip", async ({ page, request }) => {
  await openApp(page);
  const { trackId, clipId } = await trackWithClip(page, request);
  expect(trackId).toBeTruthy();
  expect(clipId).toBeTruthy();
  const snap = await waitForSnapshot(request, (s) => s.tracks.length === 1 && s.tracks[0].clips.length === 1);
  expect(snap.tracks[0].id).toBe(trackId);
});
