import { expect, test, type Page } from "@playwright/test";
import type { Snapshot } from "../src/types";
import { bootProTools } from "./helpers";

type MidiEditorWindow = Window & {
  __moshStore?: {
    getState: () => {
      snapshot: Snapshot | null;
      editingClipId: string | null;
      selectedTrackId: string | null;
    };
  };
  __moshCmdTrace?: Array<{
    command: string;
    args: Record<string, unknown>;
  }>;
};

async function midiTrack(page: Page, trackName: string): Promise<{ trackId: string; clipId: string }> {
  return page.evaluate((name) => {
    const snapshot = (window as MidiEditorWindow).__moshStore?.getState().snapshot;
    const track = snapshot?.tracks.find((candidate) => candidate.name === name);
    if (!track) throw new Error(`${name} track is unavailable`);
    const clip = track?.clips.find((candidate) => candidate.type === "midi");
    if (!clip) throw new Error(`${name} MIDI clip is unavailable`);
    return { trackId: track.id, clipId: clip.id };
  }, trackName);
}

test("MIDI Track List superimposes context and keeps note commands on one explicit target", async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await bootProTools(page);
  const drums = await midiTrack(page, "Drums");
  const bass = await midiTrack(page, "Bass");

  await page.getByTestId("pt-clip-list-item").filter({ hasText: "loop" }).click();
  const trackList = page.getByTestId("pt-midi-track-list");
  await expect(trackList).toBeVisible();
  await expect(page.getByTestId("pt-midi-track-row")).toHaveCount(2);
  await expect(trackList.getByRole("button", { name: "Edit Drums", exact: true }))
    .toHaveAttribute("aria-pressed", "true");
  await expect(trackList.getByRole("button", { name: "Show Drums", exact: true })).toBeDisabled();

  const showBass = trackList.getByRole("button", { name: "Show Bass", exact: true });
  await showBass.focus();
  await expect(showBass).toBeFocused();
  await page.keyboard.press("Space");
  const bassContext = page.locator(
    `[data-testid=pr-context-note][data-track-id='${bass.trackId}']`,
  );
  await expect(bassContext.first()).toBeVisible();
  expect(await bassContext.first().evaluate((node) => getComputedStyle(node).pointerEvents)).toBe("none");

  const editBass = trackList.getByRole("button", { name: "Edit Bass", exact: true });
  await editBass.focus();
  await expect(editBass).toBeFocused();
  await page.keyboard.press("Enter");
  await expect.poll(() => page.evaluate(
    () => (window as MidiEditorWindow).__moshStore?.getState().editingClipId,
  )).toBe(bass.clipId);
  await expect.poll(() => page.evaluate(
    () => (window as MidiEditorWindow).__moshStore?.getState().selectedTrackId,
  )).toBe(bass.trackId);
  await expect(trackList.getByRole("button", { name: "Edit Bass", exact: true }))
    .toHaveAttribute("aria-pressed", "true");
  await expect(page.locator(".pt-midi-editor-main .pr-head")).toContainText("Piano Roll · sub");
  await expect(page.locator(
    `[data-testid=pr-context-note][data-track-id='${drums.trackId}']`,
  ).first()).toBeVisible();

  const traceStart = await page.evaluate(() => (window as MidiEditorWindow).__moshCmdTrace?.length ?? 0);
  const scroll = page.locator(".pt-midi-editor-main .pr-scroll");
  const bounds = await scroll.boundingBox();
  if (!bounds) throw new Error("MIDI grid viewport is unavailable");
  await page.mouse.click(bounds.x + Math.min(96, bounds.width / 3), bounds.y + Math.min(24, bounds.height / 3));

  await expect.poll(() => page.evaluate(({ start, clipId }) => {
    const trace = (window as MidiEditorWindow).__moshCmdTrace ?? [];
    return trace.slice(start).some((entry) => (
      entry.command === "add_note" && entry.args.clipId === clipId
    ));
  }, { start: traceStart, clipId: bass.clipId })).toBe(true);
  expect(drums.clipId).not.toBe(bass.clipId);

  await page.screenshot({
    path: testInfo.outputPath("protools-midi-superimposed-wide.png"),
    animations: "disabled",
  });
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.setViewportSize({ width: 720, height: 720 });
  await trackList.scrollIntoViewIfNeeded();
  await expect(trackList).toBeVisible();
  const compactBounds = await trackList.boundingBox();
  if (!compactBounds) throw new Error("Compact MIDI Track List bounds are unavailable");
  expect(compactBounds.x).toBeGreaterThanOrEqual(0);
  expect(compactBounds.x + compactBounds.width).toBeLessThanOrEqual(720);
  await page.screenshot({
    path: testInfo.outputPath("protools-midi-superimposed-compact.png"),
    animations: "disabled",
  });
});
