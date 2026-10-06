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
  // the label names what is ON the instrument: once ⌘Z reverted the load it cannot vouch for it
  await expect(page.getByTestId("v3-preset-current")).toHaveCount(0);

  await page.keyboard.press("ControlOrMeta+z");
  await expect(fader).toHaveValue(before);
  await page.keyboard.press("ControlOrMeta+z");
  await expect(rows).toHaveCount(rowsBefore);
});

// Track-chain presets: one pick in the inspector's Plugins group applies the whole vocal chain to
// the selected audio track, a second pick does not stack another, and one undo removes it. Plumbing
// only — that the chain is the DSP it claims to be is the native selftest's job, and how it sounds
// is nobody's claim yet.
test("apply the Mosh Clean Lead preset to an audio track, re-apply without duplicating, undo in one step", async ({ page }) => {
  await bootV3(page);
  await page.getByTestId("v3-add-audio").click();
  const newTrack = page.getByTestId("v3-track").last();
  await newTrack.getByRole("button", { name: /^Select track/ }).click();
  const inspector = page.getByTestId("v3-inspector");
  await expect(inspector).toHaveAttribute("data-track-id", (await newTrack.getAttribute("data-track-id"))!);
  const rows = inspector.getByTestId("v3-plugin");
  const rowsBefore = await rows.count();
  await expect(inspector.getByTestId("v3-plugin-preset")).toHaveCount(0);     // anti-vacuity baseline

  const picker = inspector.getByTestId("v3-track-preset");
  await expect(picker).toBeVisible();
  await picker.selectOption({ label: "Mosh Clean Lead v0" });
  await expect(rows).toHaveCount(rowsBefore + 2);
  await expect(inspector.getByTestId("v3-plugin-preset")).toHaveCount(2);
  await expect(inspector.getByTestId("v3-plugin-preset").first()).toHaveText("Preset: Mosh Clean Lead v0");
  const highPass = rows.nth(rowsBefore);
  const compressor = rows.nth(rowsBefore + 1);
  await expect(highPass).toHaveAttribute("data-plugin-type", "highpass");
  await expect(highPass).toContainText("Filter");                             // the filter panel's title
  await expect(highPass.getByRole("button", { name: "HP (High-pass)", exact: true })).toHaveAttribute("aria-pressed", "true");
  await expect(highPass).toContainText("80 Hz");                             // readback in real units
  await expect(compressor).toContainText("Compressor");
  await expect(compressor).toContainText("2.5:1");                           // the compressor panel's ratio read-out
  await expect(compressor).toContainText("-24.0 dB");                        // and its threshold
  // every parameter is reachable: the threshold handle on the curve and four dials (the
  // inert sidechain gain behind "more")
  for (const name of ["Threshold", "Ratio", "Attack", "Release", "Makeup"])
    await expect(compressor.getByRole("slider", { name, exact: true })).toHaveCount(1);
  await expect(compressor.getByRole("button", { name: "Bypass" })).toBeVisible();

  await expect(picker).toHaveValue("");                                      // snaps back, so it can be picked again
  await picker.selectOption({ label: "Mosh Clean Lead v0" });
  await expect(rows).toHaveCount(rowsBefore + 2);                            // still one chain, not two

  await picker.blur();                                                       // ⌘Z is ignored while a form control has focus
  await page.keyboard.press("ControlOrMeta+z");
  await expect(rows).toHaveCount(rowsBefore);                                // ONE undo removed both stages
  await expect(inspector.getByTestId("v3-plugin-preset")).toHaveCount(0);
});

// Chain order is audible, so the inspector lets you drag a plugin above or below another.
// A real pointer drag in the browser: the header is the handle, the half of the row under
// the pointer decides above/below, and it is one undoable reorder_plugin.
test("drag a plugin's header above or below another row to reorder the chain; undo puts it back", async ({ page }) => {
  await bootV3(page);
  await page.getByTestId("v3-add-audio").click();
  const newTrack = page.getByTestId("v3-track").last();
  await newTrack.getByRole("button", { name: /^Select track/ }).click();
  const inspector = page.getByTestId("v3-inspector");
  await expect(inspector).toHaveAttribute("data-track-id", (await newTrack.getAttribute("data-track-id"))!);
  const rows = inspector.getByTestId("v3-plugin");
  const first = await rows.count();

  const picker = inspector.getByTestId("v3-track-preset");
  await picker.selectOption({ label: "Mosh Clean Lead v0" });
  await expect(rows).toHaveCount(first + 2);
  await picker.blur();
  await expect(rows.nth(first)).toHaveAttribute("data-plugin-type", "highpass");   // anti-vacuity baseline: the starting order
  await expect(rows.nth(first + 1)).toContainText("Compressor");

  // Compressor up: drop on the UPPER half of the High-Pass row.
  await rows.nth(first + 1).getByTestId("v3-plugin-handle").dragTo(rows.nth(first), { targetPosition: { x: 24, y: 4 } });
  await expect(rows.nth(first)).toContainText("Compressor");
  await expect(rows.nth(first + 1)).toHaveAttribute("data-plugin-type", "highpass");

  // And back down: drop on the LOWER half of the row now beneath it.
  const lower = (await rows.nth(first + 1).boundingBox())!;
  await rows.nth(first).getByTestId("v3-plugin-handle").dragTo(rows.nth(first + 1), { targetPosition: { x: 24, y: lower.height - 4 } });
  await expect(rows.nth(first)).toHaveAttribute("data-plugin-type", "highpass");
  await expect(rows.nth(first + 1)).toContainText("Compressor");

  // Each move is its own undo step.
  await page.keyboard.press("ControlOrMeta+z");
  await expect(rows.nth(first)).toContainText("Compressor");
  await page.keyboard.press("ControlOrMeta+z");
  await expect(rows.nth(first)).toHaveAttribute("data-plugin-type", "highpass");
  await expect(rows).toHaveCount(first + 2);
});

// Mosh AutoTune reads like a tuner: the key and the scale are menus of named choices, every
// control is on screen, and each slider reads back in its own units. The row shows what the
// engine describes (choices + display); this drives it against the mock's copy of that.
test("AutoTune: Key and Scale are menus, all nine controls show with units, and a picked key sticks", async ({ page }) => {
  await bootV3(page);
  await page.getByTestId("v3-add-audio").click();
  const newTrack = page.getByTestId("v3-track").last();
  await newTrack.getByRole("button", { name: /^Select track/ }).click();
  const inspector = page.getByTestId("v3-inspector");
  await expect(inspector).toHaveAttribute("data-track-id", (await newTrack.getAttribute("data-track-id"))!);
  const rows = inspector.getByTestId("v3-plugin");
  const before = await rows.count();

  await page.getByTestId("v3-add-plugin").click();
  const dock = page.getByTestId("v2-plugin-dock");
  await dock.getByTestId("v2-pb-search").fill("AutoTune");
  await dock.getByTestId("v2-pb-row").first().click();
  await expect(rows).toHaveCount(before + 1);
  const tuner = rows.last();
  await expect(tuner).toHaveAttribute("data-plugin-type", "moshAutoTune");

  // every control, in the order a tuner is read
  const params = tuner.getByTestId("v3-plugin-param");
  await expect(params).toHaveCount(9);
  await expect(params.locator(".nm")).toHaveText(
    ["Key", "Scale", "Retune speed", "Glide", "Amount", "Range", "Mix", "Output", "Look-ahead"]);

  // Key and Scale are menus, not sliders
  const key = tuner.getByLabel("Key", { exact: true });
  const scale = tuner.getByLabel("Scale", { exact: true });
  await expect(key).toHaveJSProperty("tagName", "SELECT");
  await expect(scale).toHaveJSProperty("tagName", "SELECT");
  await expect(key.locator("option")).toHaveText(["C", "C#/Db", "D", "D#/Eb", "E", "F", "F#/Gb", "G", "G#/Ab", "A", "A#/Bb", "B"]);
  await expect(scale.locator("option")).toHaveText(["Chromatic", "Major", "Minor"]);
  await expect(tuner.locator('input[type="range"]')).toHaveCount(7);
  await expect(key.locator("option:checked")).toHaveText("C");

  // the sliders read back in units, not as a bare 0-1 number
  await expect(params.nth(2).locator(".v")).toHaveText("80 ms");
  await expect(params.nth(5).locator(".v")).toHaveText("100 cents");
  await expect(params.nth(7).locator(".v")).toHaveText("0.0 dB");

  // on the chromatic scale Key changes nothing, and the row says so until a scale is chosen
  const hint = tuner.getByTestId("v3-plugin-hint");
  await expect(hint).toContainText("Key has no effect");
  await scale.selectOption({ label: "Minor" });
  await expect(scale.locator("option:checked")).toHaveText("Minor");
  await expect(hint).toHaveCount(0);

  // A picked key sticks and leaves the scale alone. (That each pick is its own undo step
  // is the engine's doing and is checked in --selftest; the mock keeps no history for
  // parameter edits.)
  await key.selectOption({ label: "A#/Bb" });
  await expect(key.locator("option:checked")).toHaveText("A#/Bb");
  await expect(scale.locator("option:checked")).toHaveText("Minor");
  await key.selectOption({ label: "G" });
  await expect(key.locator("option:checked")).toHaveText("G");
});

// The tuner's live display is a one-octave keyboard: the chosen key and scale lit, the
// rest greyed out, and the note being sung lit up. The readings ride their own 30 Hz rail,
// outside the snapshot; the mock stands in for a voice (a slow wobble around A3 while
// "playing"). What this proves is the path from the rail and the Key/Scale menus to the
// keyboard, not pitch detection, which is the engine's and is covered there.
test("AutoTune: the keyboard shows the scale, lights the sung note from the tuner rail, and clears after", async ({ page }) => {
  await bootV3(page);
  await page.getByTestId("v3-add-audio").click();
  const newTrack = page.getByTestId("v3-track").last();
  await newTrack.getByRole("button", { name: /^Select track/ }).click();
  const inspector = page.getByTestId("v3-inspector");
  await expect(inspector).toHaveAttribute("data-track-id", (await newTrack.getAttribute("data-track-id"))!);
  await expect(inspector.getByTestId("v3-tuner")).toHaveCount(0);            // no tuner, no keyboard

  await page.getByTestId("v3-add-plugin").click();
  const dock = page.getByTestId("v2-plugin-dock");
  await dock.getByTestId("v2-pb-search").fill("AutoTune");
  await dock.getByTestId("v2-pb-row").first().click();
  const tuner = inspector.getByTestId("v3-plugin").last();
  await expect(tuner).toHaveAttribute("data-plugin-type", "moshAutoTune");

  const strip = tuner.getByTestId("v3-tuner");
  const keys = strip.getByTestId("v3-tuner-key");
  const inScale = async () => (await keys.evaluateAll((els) =>
    els.filter((e) => e.hasAttribute("data-in-scale")).map((e) => e.getAttribute("data-note")))).sort();
  await expect(keys).toHaveCount(12);

  // a new AutoTune is chromatic: every key is available
  await expect(strip).toHaveAttribute("data-scale", "Chromatic");
  expect(await inScale()).toHaveLength(12);

  // choosing a key and scale greys out the notes outside it
  await tuner.getByLabel("Scale", { exact: true }).selectOption({ label: "Major" });
  await expect(strip).toHaveAttribute("data-scale", "C Major");
  await expect.poll(inScale).toEqual(["A", "B", "C", "D", "E", "F", "G"]);
  await tuner.getByLabel("Key", { exact: true }).selectOption({ label: "G" });
  await expect(strip).toHaveAttribute("data-scale", "G Major");
  await expect.poll(inScale).toEqual(["A", "B", "C", "D", "E", "F#", "G"]);
  await expect(strip).toHaveAttribute("aria-label", "Live pitch: no note. Scale: G Major");
  await expect(strip.locator("[data-sung]")).toHaveCount(0);                 // nothing sung yet

  // a pitch arrives: the A key lights, and the read-out names it
  await page.getByTestId("v3-play").click();
  await expect(strip).toHaveAttribute("data-live", "");
  await expect(strip.locator("[data-sung]")).toHaveCount(1);
  await expect(strip.locator("[data-sung]")).toHaveAttribute("data-note", "A");
  await expect(strip.getByTestId("v3-tuner-heard")).toHaveText("A3");
  await expect(strip.getByTestId("v3-tuner-cents")).toHaveText(/^[+-]?\d+ c$/);
  // it MOVES: the reading is live, not a number captured once
  const seen = new Set<string>();
  await expect.poll(async () => {
    seen.add((await strip.getByTestId("v3-tuner-cents").textContent()) ?? "");
    return seen.size;
  }, { timeout: 4000 }).toBeGreaterThan(2);

  // bypassed, a tuner hears nothing: the keyboard goes away rather than sit there looking attentive
  await tuner.getByRole("button", { name: "Bypass" }).click();
  await expect(tuner.getByTestId("v3-tuner")).toHaveCount(0);
  await tuner.getByRole("button", { name: "Enable" }).click();
  await expect(strip).toHaveAttribute("data-live", "");

  // the pitch stops: the lit key goes out (after holding for a moment)
  await page.getByTestId("v3-play").click();
  await expect(strip).not.toHaveAttribute("data-live", "", { timeout: 3000 });
  await expect(strip.locator("[data-sung]")).toHaveCount(0);
});

// Every plugin row can be minimized to one line that still says what the plugin is doing.
// Minimized is this viewer's view preference: it sends no command and is not an undo step.
test("a plugin row minimizes to a one-line summary and expands again; minimizing is not an edit", async ({ page }) => {
  await bootV3(page);
  await page.getByTestId("v3-add-audio").click();
  const newTrack = page.getByTestId("v3-track").last();
  await newTrack.getByRole("button", { name: /^Select track/ }).click();
  const inspector = page.getByTestId("v3-inspector");
  await expect(inspector).toHaveAttribute("data-track-id", (await newTrack.getAttribute("data-track-id"))!);
  await page.getByTestId("v3-add-plugin").click();
  const dock = page.getByTestId("v2-plugin-dock");
  await dock.getByTestId("v2-pb-search").fill("AutoTune");
  await dock.getByTestId("v2-pb-row").first().click();
  const row = inspector.getByTestId("v3-plugin").last();
  await row.getByLabel("Scale", { exact: true }).selectOption({ label: "Minor" });
  await row.getByLabel("Key", { exact: true }).selectOption({ label: "A" });

  const chevron = row.getByTestId("v3-plugin-minimize");
  await expect(chevron).toHaveAttribute("aria-expanded", "true");
  await expect(row.getByTestId("v3-plugin-summary")).toHaveCount(0);
  // Record every command the UI sends from here on (through the dev-only store handle).
  await page.evaluate(() => {
    type Exec = (c: string, ...rest: unknown[]) => unknown;
    const store = (window as unknown as { __moshStore: { getState(): { exec: Exec }; setState(p: { exec: Exec }): void } }).__moshStore;
    const original = store.getState().exec;
    const sent: string[] = [];
    (window as unknown as { __sent: string[] }).__sent = sent;
    store.setState({ exec: (c, ...rest) => { sent.push(c); return original(c, ...rest); } });
  });
  // Reads (list_*/get_*) are not edits; swapping exec re-runs effects that fetch with it.
  const sent = async () => (await page.evaluate(() => (window as unknown as { __sent: string[] }).__sent))
    .filter((c) => !/^(list_|get_)/.test(c));

  await chevron.click();
  await expect(chevron).toHaveAttribute("aria-expanded", "false");
  await expect(row).toHaveAttribute("data-collapsed", "");
  await expect(row.getByTestId("v3-plugin-summary")).toHaveText(/^a minor 80 ms$/);
  await expect(row.getByTestId("v3-plugin-param")).toHaveCount(0);        // the controls are folded away
  await expect(row.getByTestId("v3-tuner")).toHaveCount(0);
  expect(await sent()).toEqual([]);                                        // not a command, so not an edit

  await chevron.click();
  await expect(chevron).toHaveAttribute("aria-expanded", "true");
  await expect(row.getByTestId("v3-plugin-param")).toHaveCount(9);
  await expect(row.getByTestId("v3-plugin-summary")).toHaveCount(0);
  expect(await sent()).toEqual([]);
});
