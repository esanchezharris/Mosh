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

  // The menu is a FILTER over what list_loras returned, which the store holds whole as
  // `availableLoras` (the command is in the mock's READONLY set, so it never reaches the
  // command trace — the slice only it fills is the observable). Every kept, usable
  // adapter is offered; the unreadable one and a run's lab checkpoints are not.
  type Listed = { name: string; valid?: boolean; family?: string };
  const listed = await page.evaluate(() =>
    (window as unknown as { __moshStore: { getState: () => { availableLoras: Listed[] } } })
      .__moshStore.getState().availableLoras);
  const offered = await add.locator("option").evaluateAll((els) =>
    els.map((el) => (el as HTMLOptionElement).value).filter(Boolean));
  expect(listed.some((l) => l.family === "lab")).toBe(true);
  expect([...offered].sort(), 'the "+ LoRA…" menu is the kept, usable part of the "list_loras" result').toEqual(
    listed.filter((l) => (l.valid ?? true) && l.family !== "lab").map((l) => l.name).sort());
  await add.selectOption("ken-sa3");
  const row = gen.getByTestId("lora-row-ken-sa3");
  await expect(row).toBeVisible();

  // The trigger is auto-injected server-side — surfaced only in the row tooltip,
  // never as a chip and never written into the visible prompt.
  await expect(row.locator(".nlabel")).toHaveAttribute("title", /kxc.*automatically/);
  await expect(gen.getByTestId("lora-trigger-chip")).toHaveCount(0);

  // Strength: added at 70; the slider runs 0–200 with a notch at 100 ("ideal").
  const slider = row.getByRole("slider");
  await expect(slider).toHaveValue("70");
  await expect(slider).toHaveAttribute("max", "200");
  await expect(row.locator(".lora-strength-ideal")).toHaveText("ideal");
  await slider.fill("40");
  await expect(slider).toHaveValue("40");
  // The number takes any typed value; past the slider's range it pins to the edge.
  await row.locator(".lora-strength-num").click();
  await row.locator(".lora-strength-input").fill("250");
  await row.locator(".lora-strength-input").press("Enter");
  await expect(row.locator(".lora-strength-num")).toHaveText("250");
  await expect(slider).toHaveValue("200");

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
  await gen.getByTestId("lora-row-mic-sa3").getByRole("button", { name: /^Remove / }).click();
  await expect(gen.getByTestId("lora-row-mic-sa3")).toHaveCount(0);
  await expect(page.getByTestId("error")).toHaveCount(0);
});
