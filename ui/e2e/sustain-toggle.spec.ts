import { test, expect } from "@playwright/test";
import { boot, newProject, addAudioTrack, selectTrack } from "./helpers";

// The Sustain axis ships two vectors (Gentle = L17, Swell = L8) presented as ONE control
// with a mode toggle (the "hardware button" the owner asked for). In the colour rack they
// collapse to a single "Sustain" dropdown entry; once added, a Gentle ⇄ Swell toggle swaps
// which vector drives the hold, defaulting to Gentle.

test.beforeEach(async ({ page }) => {
  await boot(page);
});

test("sustain toggle: one Sustain control, Gentle default ⇄ Swell", async ({ page }) => {
  await newProject(page);
  await addAudioTrack(page);
  await selectTrack(page, 0);
  await page.getByRole("button", { name: "+ Test Tone", exact: true }).click();

  const gen = page.getByTestId("generative");
  await expect(gen).toBeVisible();
  // Create a re-imagine layer so GenBody (the colour rack) renders.
  await gen.getByTestId("gen-create").click();

  // The two sustain vecs collapse to ONE "Sustain" dropdown entry (value = the Gentle default);
  // the Swell mode is NOT a separate option.
  const addSel = gen.getByTestId("color-add");
  await expect(addSel.locator('option[value="sustain"]')).toHaveText("Sustain");
  await expect(addSel.locator('option[value="sustain_swell"]')).toHaveCount(0);

  // Add it → a Gentle ⇄ Swell mode toggle appears, Gentle active by default.
  await addSel.selectOption("sustain");
  const gentle = gen.getByTestId("color-mode-gentle");
  const swell = gen.getByTestId("color-mode-swell");
  await expect(gentle).toHaveAttribute("aria-pressed", "true");
  await expect(swell).toHaveAttribute("aria-pressed", "false");

  // Flip to Swell (the L8 vector) — the active mode swaps in place.
  await swell.click();
  await expect(swell).toHaveAttribute("aria-pressed", "true");
  await expect(gentle).toHaveAttribute("aria-pressed", "false");

  // Sustain is active → neither mode re-appears in the add-dropdown.
  await expect(addSel.locator('option[value="sustain"]')).toHaveCount(0);
  await expect(page.getByTestId("error")).toHaveCount(0);
});
