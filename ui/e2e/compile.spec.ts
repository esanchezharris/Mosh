import { test, expect } from "@playwright/test";
import { boot, newProject, addAudioTrack, selectTrack } from "./helpers";

// The prompt compiler in the real WebView UI (against the dev mock): add a wave clip →
// type a loose instruction in the "describe it…" box → Compile. A descriptive instruction
// fills a re-imagine layer (the chosen colour shows in the rack); a corrective request is
// honestly declined with a message and NO layer is created (generative-only v1).

test.beforeEach(async ({ page }) => {
  await boot(page);
});

test("describe-it: a loose instruction compiles into a re-imagine layer", async ({ page }) => {
  await newProject(page);
  await addAudioTrack(page);
  await selectTrack(page, 0);
  await page.getByRole("button", { name: "+ Test Tone", exact: true }).click();

  const gen = page.getByTestId("generative");
  await expect(gen).toBeVisible();
  const box = gen.getByTestId("gen-compile-input");
  await expect(box).toBeVisible();

  await box.fill("make it lo-fi and gritty");
  await gen.getByTestId("gen-compile-go").click();

  // The layer now exists → GenBody renders, the chosen "grit" colour is shown, Render is offered.
  await expect(gen.getByTestId("gen-render")).toBeVisible();
  await expect(gen.getByText("grit", { exact: false })).toBeVisible();
  await expect(gen.getByTestId("render-status")).toHaveText("dirty");
  await expect(page.getByTestId("error")).toHaveCount(0);

  // …and it renders + accepts like any layer.
  await gen.getByTestId("gen-render").click();
  await expect(gen.getByTestId("render-status")).toHaveText("ready");
  await expect(gen.getByTestId("gen-accept")).toBeEnabled();
});

test("honest boundary: a corrective request is declined, no layer created", async ({ page }) => {
  await newProject(page);
  await addAudioTrack(page);
  await selectTrack(page, 0);
  await page.getByRole("button", { name: "+ Test Tone", exact: true }).click();

  const gen = page.getByTestId("generative");
  await gen.getByTestId("gen-compile-input").fill("fix my guitar");
  await gen.getByTestId("gen-compile-go").click();

  // An honest "can't repair the take" message — and the create row is still shown
  // (nothing was re-performed; no render layer exists).
  const say = gen.getByTestId("gen-compile-say");
  await expect(say).toBeVisible();
  await expect(say).toContainText(/repair/i);
  await expect(gen.getByTestId("gen-create")).toBeVisible();
  await expect(gen.getByTestId("gen-render")).toHaveCount(0);
});
