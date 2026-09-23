import { test, expect } from "@playwright/test";
import { bootV3 } from "./helpers";

// V3 parity brief row 7: insert a native instrument from the Plugins pane, see its parameters
// in the inspector, apply a preset from the inspector row, and undo both — plumbing only.
// Whether each builtin does what its name says is engine work (see the brief) and not a claim here.

test("insert 4OSC from Plugins, apply a preset in the inspector, undo the preset and the insert", async ({ page }) => {
  await bootV3(page);
  // a fresh audio track has no instrument: no preset picker anywhere (anti-vacuity baseline)
  await page.getByTestId("v3-add-audio").click();
  const newTrack = page.getByTestId("v3-track").last();
  await newTrack.getByRole("button", { name: /^Select track/ }).click();
  const inspector = page.getByTestId("v3-inspector");
  await expect(inspector).toHaveAttribute("data-track-id", (await newTrack.getAttribute("data-track-id"))!);
  const rows = inspector.getByTestId("v3-plugin");
  const rowsBefore = await rows.count();
  await expect(page.getByTestId("preset-pick")).toHaveCount(0);

  await page.getByTestId("v3-add-plugin").click();
  const dock = page.getByTestId("v2-plugin-dock");
  await expect(dock).toBeVisible();
  await dock.getByTestId("v2-pb-search").fill("4OSC");
  await dock.getByTestId("v2-pb-row").first().click();
  await expect(rows).toHaveCount(rowsBefore + 1);
  const synth = rows.last();
  await expect(synth).toContainText("4OSC");
  const fader = synth.locator('input[type="range"]').first();
  await expect(fader).toBeVisible();                       // the native patch surface is inline
  const before = await fader.inputValue();

  const picker = synth.getByTestId("preset-pick");
  await expect(picker).toBeVisible();
  expect(await picker.locator("option").count()).toBeGreaterThan(1);
  await picker.selectOption({ label: "mosh-bass" });
  await expect(fader).not.toHaveValue(before);              // readback: the preset moved the patch

  // the Browser's Presets tab offers the same picker for the selected track, and names the sound
  // that is on (the picker itself snaps back to "Presets…" after every pick)
  await page.getByTestId("v3-import-audio").click();
  await page.getByTestId("v3-browser-presets").click();
  await expect(page.getByTestId("v3-preset-row")).toHaveCount(1);
  const panePicker = page.getByTestId("v3-presets").getByTestId("preset-pick");
  await expect(panePicker).toBeVisible();
  await expect(panePicker).toHaveValue("");
  await expect(page.getByTestId("v3-preset-current")).toHaveText("mosh-bass");
  await panePicker.selectOption({ label: "mosh-pad" });
  await expect(page.getByTestId("v3-preset-current")).toHaveText("mosh-pad");
  await panePicker.blur();                                  // ⌘Z is ignored while a form control has focus
  await page.keyboard.press("ControlOrMeta+z");            // the pane pick is its own undo step

  await page.keyboard.press("ControlOrMeta+z");
  await expect(fader).toHaveValue(before);
  await page.keyboard.press("ControlOrMeta+z");
  await expect(rows).toHaveCount(rowsBefore);
});
