import { test, expect } from "@playwright/test";
import { boot, newProject, addAudioTrack, selectTrack } from "./helpers";

// LoRA rack — trained style adapters in the re-imagine drawer (against the dev mock):
// add a wave clip → "+ Re-imagine" → add a LoRA from the menu → strength slider →
// stack a second + third (unbounded — no ≤2 limit) → the informational Σ readout
// appears → remove. Trigger tokens auto-inject server-side (tooltip-only), so there
// is NO trigger chip and the prompt stays untouched.

test.beforeEach(async ({ page }) => {
  await boot(page);
});

test("lora rack: add → strength → unbounded stack → Σ readout → remove", async ({ page }) => {
  await newProject(page);
  await addAudioTrack(page);
  await selectTrack(page, 0);
  await page.getByRole("button", { name: "+ Test Tone", exact: true }).click();

  const gen = page.getByTestId("generative");
  await expect(gen).toBeVisible();
  await gen.getByTestId("gen-create").click();

  // The rack menu lists the mock library; pick Ken. The invalid fixture entry
  // ("broken") must NOT be offered.
  const add = gen.getByTestId("lora-add");
  await expect(add).toBeVisible();
  await expect(add.locator("option[value=broken]")).toHaveCount(0);
  await add.selectOption("ken-sa3");
  const row = gen.getByTestId("lora-row-ken-sa3");
  await expect(row).toBeVisible();

  // The trigger is auto-injected server-side — surfaced only in the row tooltip,
  // never as a chip and never written into the visible prompt.
  await expect(row.locator(".nlabel")).toHaveAttribute("title", /kxc.*automatically/);
  await expect(gen.getByTestId("lora-trigger-chip")).toHaveCount(0);

  // Strength slider is live (0–100).
  const slider = row.getByRole("slider");
  await expect(slider).toHaveValue("70");
  await slider.fill("40");
  await expect(slider).toHaveValue("40");

  // Stack a second and a THIRD adapter — no count cap; the add menu stays while
  // addable adapters remain, and the muted Σ readout appears (informational only).
  await gen.getByTestId("lora-add").selectOption("bro-sa3");
  await expect(gen.getByTestId("lora-row-bro-sa3")).toBeVisible();
  await gen.getByTestId("lora-add").selectOption("mic-sa3");
  await expect(gen.getByTestId("lora-row-mic-sa3")).toBeVisible();
  await expect(gen.getByTestId("lora-sum")).toContainText("Σ");

  // Render still works with the rack armed; remove restores the menu entry.
  await gen.getByTestId("gen-render").click();
  await expect(gen.getByTestId("render-status")).toHaveText("ready");
  await gen.getByTestId("lora-row-mic-sa3").getByRole("button", { name: "✕" }).click();
  await expect(gen.getByTestId("lora-row-mic-sa3")).toHaveCount(0);
  await expect(page.getByTestId("error")).toHaveCount(0);
});
