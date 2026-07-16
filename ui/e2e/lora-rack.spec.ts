import { test, expect } from "@playwright/test";
import { boot, newProject, addAudioTrack, selectTrack } from "./helpers";

// The LoRA rack — stacked taste adapters in the generative drawer (against the dev
// mock's list_loras fixture). Progressive disclosure: adapters come from the watched
// folder; triggers auto-inject server-side (tooltip only); no count cap or budget.

test.beforeEach(async ({ page }) => {
  await boot(page);
});

test("LoRA rack: + LoRA → fader → second adapter → Σ readout → remove", async ({ page }) => {
  await newProject(page);
  await addAudioTrack(page);
  await selectTrack(page, 0);
  await page.getByRole("button", { name: "+ Test Tone", exact: true }).click();

  const gen = page.getByTestId("generative");
  await expect(gen).toBeVisible();
  await gen.getByTestId("gen-create").click();   // + Re-imagine

  // The rack offers the library via one quiet select.
  const add = gen.getByTestId("lora-add");
  await expect(add).toBeVisible();
  await add.selectOption("kxc");

  // A rack row appears with a fader; the trigger lives in the tooltip, not the label.
  const rack = gen.getByTestId("lora-rack");
  const row = rack.locator("label", { hasText: "Ken Carson" });
  await expect(row).toBeVisible();
  await expect(row).toHaveAttribute("title", /trigger “kxc” is added to the prompt automatically/);
  await expect(row.locator("input[type=range]")).toHaveValue("80");

  // Stack a second adapter → the informational Σ readout appears (never blocks).
  await gen.getByTestId("lora-add").selectOption("micz");
  await expect(rack.locator("label", { hasText: "The Microphones" })).toBeVisible();
  await expect(gen.getByTestId("lora-sum")).toHaveText(/Σ 1\.60/);

  // Fader drives set_render_param — the layer goes dirty, then renders clean.
  await row.locator("input[type=range]").fill("100");
  await expect(gen.getByTestId("render-status")).toHaveText("dirty");
  await gen.getByTestId("gen-render").click();
  await expect(gen.getByTestId("render-status")).toHaveText("ready");

  // Remove both rows → the quiet "+ LoRA…" affordance returns; no errors surfaced.
  await rack.locator("label", { hasText: "Ken Carson" }).locator("button.x").click();
  await rack.locator("label", { hasText: "The Microphones" }).locator("button.x").click();
  await expect(gen.getByTestId("lora-add")).toBeVisible();
  await expect(gen.getByTestId("lora-sum")).toHaveCount(0);
  await expect(page.getByTestId("error")).toHaveCount(0);
});
