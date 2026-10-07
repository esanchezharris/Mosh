import { test, expect, type Locator } from "@playwright/test";
import { bootV3 } from "./helpers";

// The Sampler panel (instrument-panels contract §3b): the loaded pads as a grid, a tap plays
// and selects one, a level change is sent once (on release / when the keys go quiet) and is
// one undo step, a solo left on a cleared pad is named and undone in one click, a dropped
// sample asks before it replaces a pad, the kit menu loads a kit.
// Plumbing against the mock; whether a pad sounds is the engine selftest's and the owner's.

const padCell = (row: Locator, note: number) => row.locator(`[data-testid="pp-sampler-cell"][data-note="${note}"]`);

async function dropFromBrowser(row: Locator, note: number, path: string) {
  const cell = padCell(row, note);
  await cell.evaluate((el, p) => {
    const dt = new DataTransfer();
    dt.setData("application/x-mosh-sample", p);
    el.dispatchEvent(new DragEvent("dragover", { bubbles: true, cancelable: true, dataTransfer: dt }));
    el.dispatchEvent(new DragEvent("drop", { bubbles: true, cancelable: true, dataTransfer: dt }));
  }, path);
}

test("Sampler panel: tap, a level edit sent once and undone, an orphan solo cleared, a drop that asks first, a kit load", async ({ page }) => {
  await bootV3(page);
  const tracks = page.getByTestId("v3-track");
  const before = await tracks.count();
  await page.getByTestId("v3-add-drum-beat").click();               // a drum track with the bundled kit
  await expect(tracks).toHaveCount(before + 1);
  await tracks.last().getByRole("button", { name: /^Select track/ }).click();
  const inspector = page.getByTestId("v3-inspector");
  const row = inspector.locator('[data-testid="v3-plugin"][data-plugin-type="sampler"]').first();
  const panel = row.getByTestId("pp-sampler");
  await expect(panel).toHaveAttribute("data-view", "drum");
  await expect(row.getByTestId("pp-sampler-cell")).toHaveCount(8);  // the kit's eight pads, nothing else
  await expect(padCell(row, 38)).toContainText("Snare");

  // a tap selects the pad: ONE row of its controls
  await padCell(row, 38).locator(".pad").dispatchEvent("pointerdown", { button: 0, pointerId: 1, isPrimary: true });
  const level = row.getByTestId("pp-sampler-level").getByRole("slider");
  await expect(level).toHaveAttribute("aria-valuetext", "0.0 dB");

  // two key steps preview at once and land as ONE set_drum_pad once the keys go quiet
  await level.focus();
  await page.keyboard.press("ArrowUp");
  await page.keyboard.press("ArrowUp");
  await expect(level).toHaveAttribute("aria-valuetext", "+2.0 dB");
  type Sound = { pitch: number; userGainDb: number };
  type Snap = { tracks: { plugins?: { type: string; sampler?: { sounds: Sound[] } }[] }[] };
  const userGain = () => page.evaluate(() => {
    const st = (window as unknown as { __moshStore: { getState: () => { snapshot: Snap } } }).__moshStore.getState();
    const t = st.snapshot.tracks[st.snapshot.tracks.length - 1]!;
    return t.plugins!.find((p) => p.type === "sampler")!.sampler!.sounds.find((s) => s.pitch === 38)!.userGainDb;
  });
  await expect.poll(userGain).toBe(2);
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur?.());
  await page.keyboard.press("ControlOrMeta+z");
  await expect.poll(userGain).toBe(0);
  await expect(level).toHaveAttribute("aria-valuetext", "0.0 dB");

  // mute is per lane, at the pad's note
  await padCell(row, 42).getByTestId("pp-sampler-m").click();
  await expect(padCell(row, 42).getByTestId("pp-sampler-m")).toHaveAttribute("aria-pressed", "true");
  await expect(padCell(row, 42)).toHaveClass(/quiet/);

  // a solo left on a cleared pad's note silences the kit: the panel names it, one click off
  await padCell(row, 46).getByTestId("pp-sampler-s").click();
  await padCell(row, 46).locator(".pad").dispatchEvent("pointerdown", { button: 0, pointerId: 1, isPrimary: true });
  await row.getByTestId("pp-sampler-clear").click();
  await expect(padCell(row, 46)).toHaveCount(0);
  await expect(row.getByTestId("pp-sampler-orphan-solo")).toContainText("Solo on empty A#2");
  await expect(padCell(row, 36)).toHaveClass(/quiet/);
  await row.getByTestId("pp-sampler-unsolo").click();
  await expect(row.getByTestId("pp-sampler-orphan-solo")).toHaveCount(0);
  await expect(padCell(row, 36)).not.toHaveClass(/quiet/);

  // a sample dragged from the browser onto the clap: asked first, then it replaces the clap
  await dropFromBrowser(row, 39, "/mock/samples/Clap 909.wav");
  await expect(row.getByTestId("pp-sampler-confirm")).toContainText("Replace Clap with Clap 909.wav?");
  await expect(padCell(row, 39)).toContainText("Clap");
  await row.getByTestId("pp-sampler-replace").click();
  await expect(padCell(row, 39)).toContainText("Clap 909");

  // the kit menu: fetched when opened, loading one names it on the button
  await row.getByTestId("pp-sampler-kitbtn").click();
  await expect(row.getByTestId("pp-sampler-kits")).toContainText("Replaces all 7 sounds");
  await row.locator('[data-testid="pp-sampler-kit"][data-kit="mosh-808"]').click();
  await expect(row.getByTestId("pp-sampler-kitbtn")).toContainText("mosh 808");
  await expect(padCell(row, 39)).toContainText("Clap");
  await expect(padCell(row, 39)).not.toContainText("909");

  // minimized: one line with the pads' dots and a summary that fits
  await row.getByTestId("v3-plugin-minimize").click();
  await expect(row.getByTestId("pp-sampler-mini")).toBeVisible();
  await expect(row.getByTestId("v3-plugin-summary")).toHaveText("8 pads, mosh-808");
});
