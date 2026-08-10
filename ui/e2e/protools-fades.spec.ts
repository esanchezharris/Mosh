import { expect, test, type Page } from "@playwright/test";
import type { CommandResult, Snapshot } from "../src/types";
import { bootProTools } from "./helpers";

type TraceEntry = {
  readonly command: string;
  readonly args: Record<string, unknown>;
  readonly ok: boolean;
};

type ProToolsFadesWindow = Window & {
  __moshStore?: {
    getState: () => {
      snapshot: Snapshot | null;
      exec: (command: string, args?: Record<string, unknown>) => Promise<CommandResult>;
      openPianoRoll: (clipId: string) => void;
      select: (clipIds: string[], additive?: boolean) => void;
    };
  };
  __moshCmdTrace?: TraceEntry[];
};

test("tutorial-backed Batch Fades persist curve-shaped overlap edits", async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await bootProTools(page);
  const { sourceId, neighborId, traceStart } = await createSelectedOverlap(page);

  await page.keyboard.press("Meta+f");
  const dialog = page.getByTestId("pt-fades-dialog");
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole("heading", { name: "Batch Fades" })).toBeVisible();
  await expect(page.getByTestId("pt-fades-length")).toBeFocused();
  await expect(dialog.getByRole("status")).toContainText("1 existing overlap");
  await expect(dialog.getByRole("status")).toContainText("audition are not available");

  await page.getByTestId("pt-fades-length").fill("250");
  await page.getByTestId("pt-fades-curve-in").selectOption("convex");
  await page.getByTestId("pt-fades-curve-out").selectOption("concave");
  await page.screenshot({
    path: testInfo.outputPath("protools-fades-wide.png"),
    animations: "disabled",
  });

  await page.getByTestId("pt-fades-apply").click();
  await expect(dialog).toHaveCount(0);
  await expect.poll(() => persistedFadeState(page, sourceId, neighborId)).toEqual({
    source: { autoCrossfade: false, fadeInSec: 0.25, fadeOutSec: 1, fadeInType: 2, fadeOutType: 3 },
    neighbor: { autoCrossfade: false, fadeInSec: 1, fadeOutSec: 0.25, fadeInType: 2, fadeOutType: 3 },
  });
  await expect(page.locator('[data-testid="pt-crossfade-region"][data-crossfade-mode="explicit"]')).toBeVisible();

  const commandNames = await page.evaluate((start) => (
    ((window as ProToolsFadesWindow).__moshCmdTrace ?? [])
      .slice(start)
      .map((entry) => entry.command)
  ), traceStart);
  expect(commandNames).toEqual([
    "batch_begin",
    "set_clip_crossfade",
    "set_clip_crossfade",
    "set_clip_fade",
    "set_clip_fade",
    "batch_end",
  ]);

  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.setViewportSize({ width: 720, height: 720 });
  const trigger = page.getByTestId("pt-open-fades");
  await trigger.scrollIntoViewIfNeeded();
  await trigger.click();
  await expect(dialog).toBeVisible();
  await expect(page.getByTestId("pt-fades-length")).toBeFocused();
  await page.getByTestId("pt-fades-close").focus();
  await page.keyboard.press("Shift+Tab");
  await expect(page.getByTestId("pt-fades-apply")).toBeFocused();
  await page.screenshot({
    path: testInfo.outputPath("protools-fades-compact.png"),
    animations: "disabled",
  });
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  await expect(trigger).toBeFocused();
});

async function createSelectedOverlap(page: Page): Promise<{
  readonly sourceId: string;
  readonly neighborId: string;
  readonly traceStart: number;
}> {
  return page.evaluate(async () => {
    const store = (window as ProToolsFadesWindow).__moshStore;
    if (!store) throw new Error("__moshStore is unavailable");
    const snapshot = store.getState().snapshot;
    const track = snapshot?.tracks.find((candidate) => (
      candidate.clips.some((clip) => clip.type === "wave")
    ));
    const source = track?.clips.find((clip) => clip.type === "wave");
    if (!track || !source) throw new Error("seed audio clip is unavailable");
    const originalIds = new Set(track.clips.map((clip) => clip.id));
    const duplicate = await store.getState().exec("duplicate_clip", { clipId: source.id });
    if (!duplicate.ok) throw new Error(duplicate.error ?? "duplicate_clip failed");
    const updatedTrack = store.getState().snapshot?.tracks.find((candidate) => candidate.id === track.id);
    const neighbor = updatedTrack?.clips.find((clip) => clip.type === "wave" && !originalIds.has(clip.id));
    if (!neighbor) throw new Error("duplicated audio clip is unavailable");
    const overlapStart = source.start + source.length - Math.min(1, source.length / 2);
    const move = await store.getState().exec("move_clip", { clipId: neighbor.id, start: overlapStart });
    if (!move.ok) throw new Error(move.error ?? "move_clip failed");
    for (const clipId of [source.id, neighbor.id]) {
      const enable = await store.getState().exec("set_clip_crossfade", { clipId, enabled: true });
      if (!enable.ok) throw new Error(enable.error ?? "set_clip_crossfade failed");
    }
    store.getState().select([source.id, neighbor.id]);
    store.getState().openPianoRoll(source.id);
    return {
      sourceId: source.id,
      neighborId: neighbor.id,
      traceStart: (window as ProToolsFadesWindow).__moshCmdTrace?.length ?? 0,
    };
  });
}

async function persistedFadeState(page: Page, sourceId: string, neighborId: string) {
  return page.evaluate(({ outgoingId, incomingId }) => {
    const snapshot = (window as ProToolsFadesWindow).__moshStore?.getState().snapshot;
    if (!snapshot) throw new Error("snapshot is unavailable");
    const clips = snapshot.tracks.flatMap((track) => track.clips);
    const summarize = (clipId: string) => {
      const clip = clips.find((candidate) => candidate.id === clipId);
      if (!clip) throw new Error(`clip ${clipId} is unavailable`);
      return {
        autoCrossfade: clip.autoCrossfade === true,
        fadeInSec: clip.fadeInSec,
        fadeOutSec: clip.fadeOutSec,
        fadeInType: clip.fadeInType,
        fadeOutType: clip.fadeOutType,
      };
    };
    return { source: summarize(outgoingId), neighbor: summarize(incomingId) };
  }, { outgoingId: sourceId, incomingId: neighborId });
}
