import { test, expect } from "@playwright/test";
import { boot, newProject, tracks, clips, addAudioTrack, selectTrack, addMidiClip } from "./helpers";

// Harness smoke — proves the dev server + mock + selectors all line up before the
// heavier producer-loop / template specs lean on them.

test.beforeEach(async ({ page }) => {
  await boot(page);
});

test("boots the WebView UI with the seeded session", async ({ page }) => {
  await expect(page.getByTestId("topbar")).toBeVisible();
  await expect(page.getByTestId("toolbar")).toBeVisible();
  await expect(page.getByTestId("transport-play")).toBeVisible();
  // The dev mock seeds a loaded session (Drums / Bass / Keys).
  await expect(tracks(page)).toHaveCount(3);
});

test("File → New clears to a blank arrangement (empty state)", async ({ page }) => {
  await expect(tracks(page)).toHaveCount(3);
  await newProject(page);
  await expect(tracks(page)).toHaveCount(0);
  await expect(clips(page)).toHaveCount(0);
  await expect(page.locator(".empty-hint")).toBeVisible();
});

test("add a track, select it, program a MIDI clip", async ({ page }) => {
  await newProject(page);
  await addAudioTrack(page);
  await expect(tracks(page)).toHaveCount(1);
  await selectTrack(page, 0);
  await addMidiClip(page);
  const clip = clips(page).first();
  await expect(clip).toHaveCount(1);
  await expect(clip).toHaveClass(/midi/);
});
