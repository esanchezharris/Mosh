// TRK-COLOUR (#550) — recolour a track.
//
// The first genuinely NEW command of the usability programme (`set_track_color`), rather
// than a UI for something the engine already had. Colour changes nothing audible, which is
// exactly why it belongs in a beat-first session: with a dozen lanes on screen, finding the
// drums instantly is the whole job.
//
// What `--selftest` already proves (and this spec therefore does not repeat): the value
// round-trips through the snapshot, uppercase normalises to lowercase, a malformed colour
// is REJECTED without half-applying, undo restores the PREVIOUS colour rather than the
// default, and "" removes the property. 14 checks, and unlike arming, the harness can see
// all of it — no audio device is involved.
//
// What only a browser can prove, and what this spec is for: that the producer can reach
// the choice, and that choosing it visibly changes the arrangement. A picker that set a
// value nothing rendered would be precisely the class of surface this programme removes.

import { test, expect } from "@playwright/test";
import { bootV2 } from "./helpers";

test.describe("track colour (#550)", () => {
  test("picking a swatch tints the track header and its lane", async ({ page }) => {
    await bootV2(page);
    await page.getByTestId("v2-track-header").first().click();
    await page.getByTestId("v2-insp-tab-mix").click();

    const header = page.getByTestId("v2-track-header").first();
    await expect(header).not.toHaveClass(/\bcoloured\b/);

    await page.getByTestId("v2-track-color-38bdf8").click();

    // The colour must reach the ARRANGEMENT, not just the Inspector's own swatch state.
    await expect(header).toHaveClass(/\bcoloured\b/);
    await expect(header).toHaveAttribute("style", /--track-col:\s*#38bdf8/);
    await expect(page.getByTestId("v2-lane").first()).toHaveClass(/\bcoloured\b/);
  });

  test("the chosen swatch reads as pressed, and only that one", async ({ page }) => {
    await bootV2(page);
    await page.getByTestId("v2-track-header").first().click();
    await page.getByTestId("v2-insp-tab-mix").click();

    await page.getByTestId("v2-track-color-4ade80").click();
    await expect(page.getByTestId("v2-track-color-4ade80")).toHaveAttribute("aria-pressed", "true");
    await expect(page.getByTestId("v2-track-color-38bdf8")).toHaveAttribute("aria-pressed", "false");
    // "Default" is a choice, so it must stop reading as selected once a colour is set.
    await expect(page.getByTestId("v2-track-color-none")).toHaveAttribute("aria-pressed", "false");
  });

  test("Default clears the colour back off the arrangement", async ({ page }) => {
    await bootV2(page);
    await page.getByTestId("v2-track-header").first().click();
    await page.getByTestId("v2-insp-tab-mix").click();

    await page.getByTestId("v2-track-color-c084fc").click();
    await expect(page.getByTestId("v2-track-header").first()).toHaveClass(/\bcoloured\b/);

    await page.getByTestId("v2-track-color-none").click();
    await expect(page.getByTestId("v2-track-header").first()).not.toHaveClass(/\bcoloured\b/);
    await expect(page.getByTestId("v2-track-color-none")).toHaveAttribute("aria-pressed", "true");
  });

  test("colouring one track leaves its neighbours alone", async ({ page }) => {
    await bootV2(page);
    await page.getByTestId("v2-track-header").first().click();
    await page.getByTestId("v2-insp-tab-mix").click();
    await page.getByTestId("v2-track-color-ff5f5f").click();

    await expect(page.getByTestId("v2-track-header").first()).toHaveClass(/\bcoloured\b/);
    await expect(page.getByTestId("v2-track-header").nth(1)).not.toHaveClass(/\bcoloured\b/);
  });
});
