import { test, expect } from "@playwright/test";
import { boot, newProject, addAudioTrack, selectTrack } from "./helpers";

// LoRA rack — trained style adapters in the re-imagine drawer (against the dev mock):
// add a wave clip → "+ Re-imagine" → add a LoRA from the menu → strength slider →
// trigger chip fills the prompt → a second LoRA maxes out the rack (≤2) → remove.

test.beforeEach(async ({ page }) => {
  await boot(page);
});

test("lora rack: add → strength → trigger chip → compose limit → remove", async ({ page }) => {
  await newProject(page);
  await addAudioTrack(page);
  await selectTrack(page, 0);
  await page.getByRole("button", { name: "+ Test Tone", exact: true }).click();

  const gen = page.getByTestId("generative");
  await expect(gen).toBeVisible();
  await gen.getByTestId("gen-create").click();

  // The rack menu lists the mock library; pick Ken.
  const add = gen.getByTestId("lora-add");
  await expect(add).toBeVisible();
  await add.selectOption("ken-sa3");
  const row = gen.getByTestId("lora-row-ken-sa3");
  await expect(row).toBeVisible();

  // Strength slider is live (0–100).
  const slider = row.getByRole("slider");
  await expect(slider).toHaveValue("70");
  await slider.fill("40");
  await expect(slider).toHaveValue("40");

  // The trigger word isn't in the (empty) prompt — the chip offers it, one tap adds it.
  const chip = gen.getByTestId("lora-trigger-chip");
  await expect(chip).toBeVisible();
  await expect(chip).toContainText("kxc");
  await chip.click();
  await expect(chip).toHaveCount(0);

  // Second LoRA fills the rack; the add menu disappears at the ≤2 limit.
  await gen.getByTestId("lora-add").selectOption("bro-sa3");
  await expect(gen.getByTestId("lora-row-bro-sa3")).toBeVisible();
  await expect(gen.getByTestId("lora-add")).toHaveCount(0);

  // Render still works with the rack armed; remove restores the menu.
  await gen.getByTestId("gen-render").click();
  await expect(gen.getByTestId("render-status")).toHaveText("ready");
  await gen.getByTestId("lora-row-bro-sa3").getByRole("button", { name: "✕" }).click();
  await expect(gen.getByTestId("lora-add")).toBeVisible();
  await expect(page.getByTestId("error")).toHaveCount(0);
});
