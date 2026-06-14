import { expect, test } from "@playwright/test";
import { collectConsoleProblems, openApp, trackWithClip, waitForSnapshot } from "./helpers";

// Undo/redo round-trips through MoshOps, and the events feed resyncs on a full catch-up.
test("undo / redo a split, and events feed resyncs", async ({ page, request }) => {
  const problems = collectConsoleProblems(page);
  await openApp(page);
  await trackWithClip(page, request);

  // Split → 2 clips.
  await page.getByTestId("clip").first().dblclick();
  await waitForSnapshot(request, (s) => s.tracks[0]?.clips.length === 2);

  // Undo → back to 1 clip.
  await page.getByTestId("undo-button").click();
  await waitForSnapshot(request, (s) => s.tracks[0]?.clips.length === 1);

  // Redo → 2 clips again.
  await page.keyboard.press("Control+Shift+Z");
  await waitForSnapshot(request, (s) => s.tracks[0]?.clips.length === 2);

  // A far-back catch-up returns a full resync rather than a delta.
  const eventResponse = await request.get("/api/events?since=-999999");
  expect(eventResponse.ok()).toBeTruthy();
  expect((await eventResponse.json()).resync).toBe(true);

  expect(problems).toEqual([]);
});
