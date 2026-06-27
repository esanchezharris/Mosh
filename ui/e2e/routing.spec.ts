import { test, expect } from "@playwright/test";
import { boot, newProject, addAudioTrack } from "./helpers";

// G8 — per-track output routing surfaces in the Mixer "out:" selector, wired to
// set_track_output / list_track_outputs through the store's loadRouting(). Driven
// against the dev-mock backend (which mirrors the native set_track_output
// contract), the full UI → seam loop is exercised here. Start from a fresh
// project so the strip count is deterministic.

test.describe("G8 per-track output routing", () => {
  test.beforeEach(async ({ page }) => {
    await boot(page);
    await newProject(page);
    await addAudioTrack(page);
    await addAudioTrack(page);
    await page.getByTestId("view-toggle").getByRole("button", { name: "Mixer" }).click();
    await expect(page.getByTestId("mixer")).toBeVisible();
  });

  test("each channel strip shows an out: selector once routing loads", async ({ page }) => {
    await expect(page.getByTestId("channel-strip")).toHaveCount(2);
    // loadRouting() ran on mixer mount → trackOutputs populated → selectors appear
    await expect(page.getByTestId("strip-out")).toHaveCount(2);
    const first = page.getByTestId("channel-strip").first().getByRole("combobox");
    await expect(first).toBeVisible();
    // Default plus the OTHER track as a candidate destination (self excluded)
    await expect(first.getByRole("option", { name: "Default" })).toHaveCount(1);
    await expect(first.locator("option")).toHaveCount(2); // Default + the other track
  });

  test("choosing another track routes the output (reflected back in the select)", async ({ page }) => {
    const strips = page.getByTestId("channel-strip");
    const firstSelect = strips.first().getByRole("combobox");
    // route track 1 -> track 2 (the only non-self candidate)
    const otherValue = await firstSelect.locator("option").nth(1).getAttribute("value");
    await firstSelect.selectOption(otherValue!);
    // the snapshot round-trips the choice → the select holds the new route value
    await expect(firstSelect).toHaveValue(otherValue!);

    // resetting to Default clears the route
    await firstSelect.selectOption("default");
    await expect(firstSelect).toHaveValue("default");
  });
});
