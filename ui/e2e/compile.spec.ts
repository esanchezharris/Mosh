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

test("honest boundary: a tuning fix routes to AutoTune (one-click), no layer created", async ({ page }) => {
  await newProject(page);
  await addAudioTrack(page);
  await selectTrack(page, 0);
  await page.getByRole("button", { name: "+ Test Tone", exact: true }).click();

  const gen = page.getByTestId("generative");
  await gen.getByTestId("gen-compile-input").fill("fix the tuning, it's pitchy");
  await gen.getByTestId("gen-compile-go").click();

  // Honest redirect: it names the corrective tool (AutoTune) — corrects, doesn't re-perform.
  const say = gen.getByTestId("gen-compile-say");
  await expect(say).toBeVisible();
  await expect(say).toContainText(/AutoTune/i);
  const fix = gen.getByTestId("gen-compile-fix");
  await expect(fix).toHaveText("Add AutoTune");
  // No render layer was created (nothing re-performed).
  await expect(gen.getByTestId("gen-create")).toBeVisible();
  await expect(gen.getByTestId("gen-render")).toHaveCount(0);

  // One click runs the corrective tool (load_builtin AutoTune) with no error; the
  // affordance then resets (say + fix button clear).
  await fix.click();
  await expect(page.getByTestId("error")).toHaveCount(0);
  await expect(gen.getByTestId("gen-compile-fix")).toHaveCount(0);
  await expect(gen.getByTestId("gen-compile-say")).toHaveCount(0);
});

test("ambiguous 'fix my guitar' offers the corrective menu, no auto-action", async ({ page }) => {
  await newProject(page);
  await addAudioTrack(page);
  await selectTrack(page, 0);
  await page.getByRole("button", { name: "+ Test Tone", exact: true }).click();

  const gen = page.getByTestId("generative");
  await gen.getByTestId("gen-compile-input").fill("fix my guitar");
  await gen.getByTestId("gen-compile-go").click();

  await expect(gen.getByTestId("gen-compile-say")).toContainText(/AutoTune/i);
  await expect(gen.getByTestId("gen-compile-fix")).toHaveCount(0);   // ambiguous → no single action
  await expect(gen.getByTestId("gen-render")).toHaveCount(0);
});
