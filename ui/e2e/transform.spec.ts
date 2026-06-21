import { test, expect } from "@playwright/test";
import { boot, newProject, addAudioTrack, selectTrack } from "./helpers";

// Route B — the transform render mode in the real WebView UI (against the dev mock):
// add a wave clip → "+ Transform" → pick a target instrument + strength → Render →
// Accept. Drives the same generative drawer / command surface the native MoshOps backs.

test.beforeEach(async ({ page }) => {
  await boot(page);
});

test("transform render mode: + Transform → pick target → render → accept", async ({ page }) => {
  await newProject(page);
  await addAudioTrack(page);
  await selectTrack(page, 0);

  // The generative drawer keys off a WAVE clip on the selected track.
  await page.getByRole("button", { name: "+ Test Tone", exact: true }).click();

  const gen = page.getByTestId("generative");
  await expect(gen).toBeVisible();
  // Both create options are offered (re-imagine + transform).
  await expect(gen.getByTestId("gen-create")).toBeVisible();
  const transformBtn = gen.getByTestId("gen-create-transform");
  await expect(transformBtn).toBeVisible();
  await transformBtn.click();

  // The transform control surface replaces the colours UI.
  const targetSel = gen.getByTestId("xform-target");
  await expect(targetSel).toBeVisible();
  await expect(gen.getByTestId("xform-strength")).toBeVisible();

  // Pick a target instrument (index 0 is the "pick instrument…" placeholder).
  await targetSel.selectOption({ index: 1 });

  // Render → status ready, Accept enabled → accept with no error surfaced.
  await gen.getByTestId("gen-render").click();
  await expect(gen.getByTestId("render-status")).toHaveText("ready");
  const accept = gen.getByTestId("gen-accept");
  await expect(accept).toBeEnabled();
  await accept.click();
  await expect(page.getByTestId("error")).toHaveCount(0);
});
