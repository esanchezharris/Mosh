import { test, expect } from "@playwright/test";
import { boot } from "./helpers";

// G3 — the Settings panel exposes an audio-device select (set_audio_device /
// list_audio_devices) and a per-track input picker (set_track_input /
// list_wave_inputs via loadRouting). Drives the REAL React UI against the in-memory
// mock backend (same command/snapshot contract as native) — proves the wiring
// crosses the swappable seam, not just the unit-tested helper shaping.

test.describe("G3 audio routing in Settings", () => {
  test.beforeEach(async ({ page }) => {
    await boot(page);
    await page.locator('button[title="Settings"]').click();
    await expect(page.getByTestId("template-picker")).toBeVisible(); // Settings is open
  });

  test("shows the audio-device selects populated from list_audio_devices", async ({ page }) => {
    const out = page.getByLabel("Output device", { exact: true });
    await expect(out).toBeVisible();
    await expect(out.locator("option")).toHaveText(["MacBook Pro Speakers", "External Headphones"]);
    await expect(out).toHaveValue("MacBook Pro Speakers");

    const inp = page.getByLabel("Input device", { exact: true });
    await expect(inp.locator("option")).toHaveText(["MacBook Pro Microphone", "Scarlett 2i2"]);
  });

  test("changing the output device round-trips through set_audio_device", async ({ page }) => {
    const out = page.getByLabel("Output device", { exact: true });
    await out.selectOption("External Headphones");
    // The store re-fetches list_audio_devices after set_audio_device; the mock
    // remembers the new selection, so the select stays on the new value.
    await expect(out).toHaveValue("External Headphones");
  });

  test("each non-group track gets an input picker; choosing one sticks", async ({ page }) => {
    // Seed project has Drums / Bass / Keys (all non-group, non-return).
    const keysInput = page.getByLabel("Input for Keys", { exact: true });
    await expect(keysInput).toBeVisible();
    // None + the three mock wave inputs.
    await expect(keysInput.locator("option")).toHaveText(["None", "Input 1-2", "Input 3-4", "Input 5 (disabled)"]);
    await expect(keysInput).toHaveValue(""); // None by default

    await keysInput.selectOption("Input 3-4");
    // set_track_input stamps the track's input; loadRouting + refresh reflect it.
    await expect(keysInput).toHaveValue("in-3-4");
  });
});
