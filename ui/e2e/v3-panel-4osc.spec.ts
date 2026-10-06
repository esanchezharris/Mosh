import { test, expect } from "@playwright/test";
import { bootV3 } from "./helpers";

// The 4OSC panel (instrument-panels contract §3b): one section at a time, controls that
// do nothing right now are not shown, settings are undoable commands. Plumbing against the
// mock; that the sound changes is the engine selftest's job. The mock does not model undo
// for set_plugin_param, so parameter edits are checked by their read-out only; the
// settings (set_plugin_state) are checked through undo.

test("4OSC panel: sections, an added oscillator, the filter's type and slope, the amp envelope, an effect", async ({ page }) => {
  await bootV3(page);
  await page.getByTestId("v3-add-audio").click();
  const newTrack = page.getByTestId("v3-track").last();
  await newTrack.getByRole("button", { name: /^Select track/ }).click();
  const inspector = page.getByTestId("v3-inspector");
  await expect(inspector).toHaveAttribute("data-track-id", (await newTrack.getAttribute("data-track-id"))!);
  const rows = inspector.getByTestId("v3-plugin");
  const rowsBefore = await rows.count();
  await page.getByTestId("v3-add-plugin").click();
  const dock = page.getByTestId("v2-plugin-dock");
  await dock.getByTestId("v2-pb-search").fill("4OSC");
  await dock.getByTestId("v2-pb-row").first().click();
  await page.keyboard.press("Escape");
  await expect(rows).toHaveCount(rowsBefore + 1);
  const synth = rows.last();
  const panel = synth.getByTestId("pp-fourosc");
  await expect(panel).toBeVisible();
  await expect(panel).toHaveAttribute("data-section", "osc");
  await expect(synth.getByTestId("preset-pick")).toHaveCount(1);          // the panel's own menu, not a second row
  await expect(synth.locator(".pp-fo-chip")).toHaveCount(1);               // a fresh 4OSC: oscillator 1 (sine) only

  const undo = async () => {
    await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur?.());   // ⌘Z is ignored inside a form control
    await page.keyboard.press("ControlOrMeta+z");
  };

  // OSC: "+" turns the next oscillator on with the chosen wave; one undo removes it
  await synth.getByTestId("pp-fo-add").selectOption("saw");
  await expect(synth.locator(".pp-fo-chip")).toHaveCount(2);
  await expect(synth.getByTestId("pp-fo-wave")).toHaveValue("saw");
  await expect(synth.getByRole("slider", { name: "Level 2", exact: true })).toHaveCount(1);
  await expect(synth.getByTestId("pp-fo-pan")).toBeVisible();               // one voice: pan, no detune
  await expect(synth.getByTestId("pp-fo-detune")).toHaveCount(0);
  await undo();
  await expect(synth.locator(".pp-fo-chip")).toHaveCount(1);

  // FILTER: off says so and hides its knobs; LP draws the curve; the slope is a setting
  await synth.getByTestId("pp-fo-section-filter").click();
  await expect(synth.getByTestId("pp-fo-filter-off")).toBeVisible();
  await expect(synth.getByTestId("pp-fo-cutoff")).toHaveCount(0);
  await synth.getByTestId("pp-fo-ftype-lowpass").click();
  await expect(synth.getByTestId("pp-fo-cutoff")).toBeVisible();
  await expect(synth.getByTestId("pp-fo-fcurve")).toHaveAttribute("d", /^M[\d.]+ [\d.]+ L/);
  const cutoff = synth.getByTestId("pp-fo-cutoff");
  const cut0 = await cutoff.textContent();
  await synth.getByTestId("pp-fo-fnode").focus();
  await page.keyboard.press("PageUp");
  await expect.poll(() => cutoff.textContent()).not.toBe(cut0);
  await synth.getByTestId("pp-fo-slope-24").click();
  await expect(synth.getByTestId("pp-fo-slope-24")).toHaveAttribute("aria-pressed", "true");
  await undo();
  await expect(synth.getByTestId("pp-fo-slope-12")).toHaveAttribute("aria-pressed", "true");
  await undo();
  await expect(synth.getByTestId("pp-fo-filter-off")).toBeVisible();

  // AMP: dragging the attack node lengthens the attack
  await synth.getByTestId("pp-fo-section-amp").click();
  const attack = synth.getByTestId("pp-fo-attack");
  const a0 = await attack.textContent();
  const dot = (await synth.getByTestId("pp-fo-env-attack").locator(".dot").boundingBox())!;
  await page.mouse.move(dot.x + dot.width / 2, dot.y + dot.height / 2);
  await page.mouse.down();
  for (let i = 1; i <= 6; i++) await page.mouse.move(dot.x + dot.width / 2 + i * 4, dot.y + dot.height / 2);
  await page.mouse.up();
  await expect.poll(() => attack.textContent()).not.toBe(a0);

  // FX: an effect's knobs show only while it is on
  await synth.getByTestId("pp-fo-section-fx").click();
  await synth.getByTestId("pp-fo-fx-reverb").click();
  await expect(synth.getByTestId("pp-fo-fx-off")).toBeVisible();
  await synth.getByTestId("pp-fo-fx-power").click();
  await expect(synth.getByTestId("pp-fo-mix")).toBeVisible();

  // minimized: the summary and the envelope thumbnail
  await synth.getByTestId("v3-plugin-minimize").click();
  await expect(synth.getByTestId("v3-plugin-summary")).toHaveText("sine · no filter");
  await expect(synth.getByTestId("pp-fo-mini")).toHaveCount(1);
});
