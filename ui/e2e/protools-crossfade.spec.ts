import { expect, test, type Page } from "@playwright/test";
import type { CommandResult, Snapshot } from "../src/types";
import { bootProTools } from "./helpers";

type ProToolsCrossfadeWindow = Window & {
  __moshStore?: {
    getState: () => {
      snapshot: Snapshot | null;
      exec: (command: string, args?: Record<string, unknown>) => Promise<CommandResult>;
      openPianoRoll: (clipId: string) => void;
    };
  };
  __moshCmdTrace?: Array<{ command: string }>;
};

test("Avid C04 overlapping audio exposes an undoable Auto Crossfade", async ({ page }, testInfo) => {
  // Given a selected audio clip overlaps a duplicate on the same track.
  await page.setViewportSize({ width: 1440, height: 900 });
  await bootProTools(page);
  const { sourceId, neighborId } = await createOverlappingAudioPair(page);
  const sourceClip = page.locator(`[data-testid="v2-clip"][data-clip-id="${sourceId}"]`);
  const neighborClip = page.locator(`[data-testid="v2-clip"][data-clip-id="${neighborId}"]`);
  await expect(sourceClip).toBeVisible();
  await expect(neighborClip).toBeVisible();
  await expect(page.getByTestId("pt-audio-clip-inspector")).toBeVisible();
  const crossfade = page.getByTestId("pt-clip-crossfade");
  await expect(crossfade).toBeEnabled();
  await expect(crossfade).toHaveAttribute("aria-pressed", "false");
  await expect(page.locator("#pt-clip-crossfade-help")).toContainText("overlap");

  // When Auto Crossfade is enabled.
  await crossfade.click();

  // Then the snapshot, pressed state, and MoshOps trace agree.
  await expect.poll(() => clipAutoCrossfade(page, sourceId)).toBe(true);
  await expect(crossfade).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByTestId("pt-crossfade-region")).toBeVisible();
  await expect.poll(() => lastCommand(page)).toBe("set_clip_crossfade");
  await page.screenshot({
    path: testInfo.outputPath("protools-crossfade-wide.png"),
    animations: "disabled",
  });

  // And compact reduced-motion keeps the control reachable and keyboard-operable.
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.setViewportSize({ width: 720, height: 720 });
  await crossfade.scrollIntoViewIfNeeded();
  await expect(crossfade).toBeVisible();
  await page.getByTestId("pt-clip-mute").focus();
  await page.keyboard.press("Tab");
  await expect(crossfade).toBeFocused();
  await page.screenshot({
    path: testInfo.outputPath("protools-crossfade-compact.png"),
    animations: "disabled",
  });
  await page.keyboard.press("Space");
  await expect.poll(() => clipAutoCrossfade(page, sourceId)).toBe(false);
});

async function createOverlappingAudioPair(page: Page): Promise<{
  readonly sourceId: string;
  readonly neighborId: string;
}> {
  return page.evaluate(async () => {
    const store = (window as ProToolsCrossfadeWindow).__moshStore;
    if (!store) throw new Error("__moshStore is unavailable");
    const snapshot = store.getState().snapshot;
    const track = snapshot?.tracks.find((candidate) => (
      candidate.clips.some((clip) => clip.type === "wave")
    ));
    const source = track?.clips.find((clip) => clip.type === "wave");
    if (!track || !source) throw new Error("seed audio clip is unavailable");
    const sourceId = source.id;
    const overlapStart = source.start + source.length - Math.min(1, source.length / 2);

    const duplicateResult = await store.getState().exec("duplicate_clip", { clipId: sourceId });
    if (!duplicateResult.ok) throw new Error(duplicateResult.error ?? "duplicate_clip failed");
    const updatedTrack = store.getState().snapshot?.tracks.find((candidate) => candidate.id === track.id);
    const neighbor = updatedTrack?.clips.find((clip) => clip.type === "wave" && clip.id !== sourceId);
    if (!neighbor) throw new Error("duplicated audio clip is unavailable");
    const moveResult = await store.getState().exec("move_clip", {
      clipId: neighbor.id,
      start: overlapStart,
    });
    if (!moveResult.ok) throw new Error(moveResult.error ?? "move_clip failed");
    store.getState().openPianoRoll(sourceId);
    return { sourceId, neighborId: neighbor.id };
  });
}

async function clipAutoCrossfade(page: Page, clipId: string): Promise<boolean> {
  return page.evaluate((id) => {
    const snapshot = (window as ProToolsCrossfadeWindow).__moshStore?.getState().snapshot;
    return snapshot?.tracks
      .flatMap((track) => track.clips)
      .find((clip) => clip.id === id)?.autoCrossfade === true;
  }, clipId);
}

async function lastCommand(page: Page): Promise<string | null> {
  return page.evaluate(() => (
    (window as ProToolsCrossfadeWindow).__moshCmdTrace?.at(-1)?.command ?? null
  ));
}
