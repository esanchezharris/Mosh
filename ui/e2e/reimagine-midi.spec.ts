import { test, expect } from "@playwright/test";
import { boot, newProject, addAudioTrack, selectTrack, addMidiClip } from "./helpers";

// Phase 2 — re-imagining a MIDI clip lands a HIDDEN audio render beneath the now-muted MIDI on the
// same track: no Accept/Reject, a "✨ re-imagined" marker on the clip, and Reset to restore. Drives
// the real WebView generative drawer against the dev mock (which models the beneath behaviour).

test.beforeEach(async ({ page }) => {
  await boot(page);
});

test("MIDI re-imagine: render → hidden beneath + marker + Reset (no Accept)", async ({ page }) => {
  await newProject(page);
  await addAudioTrack(page);
  await selectTrack(page, 0);
  await addMidiClip(page);

  const gen = page.getByTestId("generative");
  await expect(gen).toBeVisible();
  await gen.getByTestId("gen-create").click();   // + Re-imagine

  // Render → auto-applies beneath the MIDI.
  await gen.getByTestId("gen-render").click();
  await expect(gen.getByTestId("render-status")).toHaveText("ready");

  // MIDI clips use Reset, never Accept/Reject.
  await expect(gen.getByTestId("gen-accept")).toHaveCount(0);
  const reset = gen.getByTestId("gen-reset");
  await expect(reset).toBeEnabled();

  // The clip carries the re-imagine marker, and the hidden audio clip is NOT shown as its own clip
  // (exactly one visible clip — the MIDI — on the lane).
  await expect(page.getByTestId("clip-reimagine").first()).toBeVisible();
  await expect(page.getByTestId("lane").first().getByTestId("clip")).toHaveCount(1);

  // Reset restores the editable MIDI — marker gone, status dirty, no error.
  await reset.click();
  await expect(gen.getByTestId("render-status")).toHaveText("dirty");
  await expect(page.getByTestId("clip-reimagine")).toHaveCount(0);
  await expect(page.getByTestId("error")).toHaveCount(0);
});
