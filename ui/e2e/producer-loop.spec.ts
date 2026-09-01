import { test, expect } from "@playwright/test";
import {
  boot, newProject, tracks, clipsOnTrack,
  addAudioTrack, addDrumTrack, selectTrack, addMidiClip,
} from "./helpers";

// The producer loop, end to end, driving the real WebView UI against the dev mock:
// new project → add track → program MIDI → drum beat (sampler) → load plugin →
// arrange → mix → export, plus File-menu actions and undo/redo. Assertions read the
// structural data-* surface the arrangement exposes (no pixel matching).

test.beforeEach(async ({ page }) => {
  await boot(page);
});

test("full producer loop: new → program → drums → plugin → mix → export", async ({ page }) => {
  // 1 — New project: a genuinely blank arrangement.
  await newProject(page);
  await expect(tracks(page)).toHaveCount(0);

  // 2 — Add an audio track (auto-selected) and program a MIDI clip on it.
  await addAudioTrack(page);
  const audioId = await selectTrack(page, 0);
  await addMidiClip(page);
  const midiClip = clipsOnTrack(page, audioId).first();
  await expect(midiClip).toHaveClass(/midi/);

  // 3 — Open the piano roll and program a note.
  await midiClip.dblclick();
  const pr = page.getByTestId("piano-roll");
  await expect(pr).toBeVisible();
  await pr.locator(".pr-grid").dblclick({ position: { x: 120, y: 200 } });
  await expect(pr.getByTestId("pr-note")).toHaveCount(1);
  await page.keyboard.press("Escape");
  await expect(pr).toBeHidden();

  // 4 — Drum beat: add a drum track, open its step sequencer (loads the sampler), and
  // toggle a few steps so the pattern is audible.
  await addDrumTrack(page);
  const drumHeader = tracks(page).filter({ has: page.locator('[data-testid="open-drum-seq"]') }).first();
  await expect(drumHeader).toHaveAttribute("data-track-type", "drum");
  await drumHeader.getByTestId("open-drum-seq").click();
  const seq = page.getByTestId("drum-sequencer");
  await expect(seq).toBeVisible();
  // kick on the down-beats (lane 0, steps 0/4/8/12)
  for (const step of [0, 4, 8, 12]) {
    const cell = seq.locator(`[data-testid="dr-cell"][data-lane="0"][data-step="${step}"]`);
    await cell.click();
    await expect(cell).toHaveAttribute("data-on", "true");
  }
  // close the floating drum window so it stops overlaying the workspace
  await page.getByTestId("floating-window").getByRole("button", { name: "Close window" }).click();
  await expect(page.getByTestId("floating-window")).toBeHidden();

  // the drum track auto-loaded a sampler instrument → selecting it shows a rack card
  const drumId = (await drumHeader.getAttribute("data-track-id"))!;
  await drumHeader.click();
  await expect(page.getByTestId("rack").getByTestId("plugin-card")).toHaveCount(1);
  expect(drumId).toBeTruthy();

  // 5 — Load a VST3 effect (OTT) on the audio track via the plugin browser.
  await selectTrack(page, 0); // the audio track
  await page.getByRole("button", { name: "+ Plugin", exact: true }).click();
  const browser = page.getByTestId("plugin-browser");
  await expect(browser).toBeVisible();
  await browser.getByPlaceholder("Filter by name or vendor…").fill("OTT");
  await browser.locator(".prow-load").first().click();
  await expect(browser).toBeHidden();
  await expect(page.getByTestId("rack").locator('[data-testid="plugin-card"]', { hasText: "OTT" })).toHaveCount(1);

  // 6 — Mix: mute + solo + nudge the volume on the audio track header.
  const audioHeader = page.locator(`[data-testid="track-header"][data-track-id="${audioId}"]`);
  await audioHeader.locator("button.msx.m").click();
  await expect(audioHeader.locator("button.msx.m")).toHaveAttribute("data-state", "on");
  await audioHeader.locator("button.msx.s").click();
  await expect(audioHeader.locator("button.msx.s")).toHaveAttribute("data-state", "on");

  // 7 — Export the mix through the export popover (the file-picker-free path).
  await page.locator('button[title="Export the mix"]').click();
  await page.getByTestId("export-run").click();
  // Guest degradation: the confirmation now shows the full path prominently + a "Copy
  // path"/"Copy folder" affordance (there is no native Reveal-in-Finder command).
  await expect(page.getByTestId("export-done")).toBeVisible();
  await expect(page.getByTestId("export-done")).toContainText("Exported to:");
  await page.getByTestId("export-copy-path").click();
  await expect(page.getByTestId("export-copy-path")).toHaveText("Copied ✓");
});

test("File menu exposes the project actions with accelerators", async ({ page }) => {
  await page.getByRole("button", { name: "File", exact: true }).click();
  const menu = page.getByTestId("file-menu");
  await expect(menu).toBeVisible();
  for (const action of ["new_project", "open_project", "save", "save_as", "export_audio"]) {
    await expect(menu.locator(`[data-action="${action}"]`)).toBeVisible();
  }
  await expect(menu.locator('[data-action="new_project"] .menu-accel')).toHaveText("⌘N");
  await expect(menu.locator('[data-action="export_audio"] .menu-accel')).toHaveText("⇧⌘R");
  // Save dispatches without surfacing an error.
  await menu.locator('[data-action="save"]').click();
  await expect(page.getByTestId("error")).toHaveCount(0);
});

test("undo / redo via the toolbar and the keyboard", async ({ page }) => {
  await newProject(page);
  await addAudioTrack(page);
  await expect(tracks(page)).toHaveCount(1);

  // toolbar
  await page.getByRole("button", { name: "Undo", exact: true }).click();
  await expect(tracks(page)).toHaveCount(0);
  await page.getByRole("button", { name: "Redo", exact: true }).click();
  await expect(tracks(page)).toHaveCount(1);

  // keyboard (dev has no native menu, so the web keymap owns these)
  await page.keyboard.press("Meta+z");
  await expect(tracks(page)).toHaveCount(0);
  await page.keyboard.press("Meta+Shift+z");
  await expect(tracks(page)).toHaveCount(1);
});
