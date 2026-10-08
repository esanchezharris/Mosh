import { test, expect } from "@playwright/test";
import { bootV3, expectDispatched } from "./helpers";

// LoRAs in V3, the default shell, by mouse and keyboard only. V3 had no way into
// training at all (the LoRA Lab and the training tools were mounted only in v2), and
// its Re-Imagine had no way to apply a LoRA, so a producer on the default shell could
// neither make one nor use one. These walk the path a producer takes.

test.beforeEach(async ({ page }) => {
  await bootV3(page);
});

test("the LoRA button opens the training tools, which register a source and open the Lab", async ({ page }) => {
  const trigger = page.getByTestId("v3-training-trigger");
  await expect(trigger).toHaveText("LoRA");
  await trigger.click();
  const dialog = page.getByTestId("v3-training-modal");
  await expect(dialog).toBeVisible();
  await expect(trigger).toHaveAttribute("aria-expanded", "true");

  // A half-filled source survives closing the dialog (Escape) and opening it again.
  await dialog.getByPlaceholder("Track/beat name").fill("Night drive");
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  await trigger.click();
  await expect(dialog.getByPlaceholder("Track/beat name")).toHaveValue("Night drive");

  // Register a rights-cleared source through the form, then approve it.
  await dialog.getByPlaceholder("Creator/artist name").fill("Me");
  await dialog.getByPlaceholder("Local file path").fill("/Users/you/night-drive.wav");
  await dialog.getByPlaceholder("Paste your rights claim text").fill("my own work");
  await dialog.getByPlaceholder("link + proof note").fill("session files");
  await dialog.getByRole("button", { name: "Add source" }).click();
  await expectDispatched(page, "import_training_source", { title: "Night drive", creator: "Me" });
  await dialog.getByRole("button", { name: "Approve" }).click();
  await expect(dialog.getByText("All sources ready for training")).toBeVisible();

  // Into the Lab: the dialog makes way for it.
  await dialog.getByTestId("open-lora-lab").click();
  await expect(dialog).toHaveCount(0);
  const lab = page.getByTestId("lora-lab");
  await expect(lab).toBeVisible();
  const train = lab.getByTestId("lab-train");
  await expect(train).toBeEnabled();
  await expect(train).toContainText("1 clip");

  // Train and Stop, as in v2: with the clock frozen the run stays queued until Stop.
  await page.clock.install();
  await page.clock.pauseAt(new Date(Date.now() + 60_000));
  await train.click();
  const status = lab.getByTestId("lab-run-status");
  await expect(status).toHaveText("queued");
  await lab.getByTestId("lab-stop").click();
  await expect(status).toHaveText("stopped");
});

test("Re-Imagine applies a kept LoRA at 70, adjustable with the shared strength control", async ({ page }) => {
  const source = page.getByRole("button", { name: "chords, audio clip", exact: true });
  await source.focus(); await page.keyboard.press("Enter");
  await page.getByTestId("v3-reimagine-open").click();

  const loras = page.getByRole("group", { name: "Kept LoRAs" });
  // Kept, usable adapters only: the unreadable one is not offered.
  await expect(loras.getByRole("button")).toHaveText(["Ken (xperiment)", "Brother (BWPOM era)", "Microphones"]);
  await loras.getByRole("button", { name: "Ken (xperiment)" }).click();
  await expect(loras.getByRole("button", { name: "Ken (xperiment)" })).toHaveAttribute("aria-pressed", "true");

  const slider = page.getByRole("slider", { name: "Ken (xperiment) strength" });
  await expect(slider).toHaveValue("70");
  await expect(slider).toHaveAttribute("max", "200");
  // Typed beyond the slider: the value is kept, the slider pins to its edge.
  await page.getByRole("button", { name: /^Ken \(xperiment\) strength 70/ }).click();
  await page.getByRole("textbox", { name: "Ken (xperiment) strength value" }).fill("-20");
  await page.keyboard.press("Enter");
  await expect(slider).toHaveValue("0");

  await page.getByTestId("gen-prompt").fill("V3 deterministic fixture.");
  await page.getByTestId("gen-render").click();
  await expectDispatched(page, "set_render_param", { loras: [{ name: "ken-sa3", value: -20 }] });
  await expect(page.getByTestId("gen-status")).toContainText("with Ken (xperiment) -20");
});
