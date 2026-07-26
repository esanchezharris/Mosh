import { test, expect } from "@playwright/test";
import { boot, newProject, addAudioTrack, selectTrack, addMidiClip } from "./helpers";

// freeze_layer / unfreeze_layer through the real drawer.
//
// Freeze was inert for a long time — it wrote status="frozen" and nothing read it, so the
// reactive loop went on re-rendering. The engine fix writes ids::reactive=false, and adds the
// thaw that never existed. What THIS file guards is the front end of that: that a mouse-only
// producer can reach both, and that the badge tracks the freeze rather than the status.
//
// The middle test is the one worth having. `status` and `reactive` agree right up until the
// first knob turn, which overwrites status with "dirty" while the layer stays frozen — so a
// badge derived from status silently reads "thawed" while the engine still refuses to render.
// Only a run that freezes and THEN edits catches it, which is why it is a scripted sequence
// and not a fixture.

test.beforeEach(async ({ page }) => {
  await boot(page);
});

test("freeze is offered only once a render is live, and toggles to Frozen", async ({ page }) => {
  await newProject(page);
  await addAudioTrack(page);
  await selectTrack(page, 0);
  await addMidiClip(page);

  const gen = page.getByTestId("generative");
  await expect(gen).toBeVisible();
  await gen.getByTestId("gen-create").click();

  // Nothing rendered yet ⇒ no loop to stop ⇒ no button.
  await expect(gen.getByTestId("gen-freeze")).toHaveCount(0);

  await gen.getByTestId("gen-render").click();
  await expect(gen.getByTestId("render-status")).toHaveText("ready");

  const freeze = gen.getByTestId("gen-freeze");
  await expect(freeze).toBeVisible();
  await expect(freeze).toHaveAttribute("aria-pressed", "false");
  await expect(freeze).toHaveText("Freeze");

  await freeze.click();
  await expect(freeze).toHaveAttribute("aria-pressed", "true");
  await expect(freeze).toHaveText("◉ Frozen");
  await expect(gen.getByTestId("render-status")).toHaveText("frozen");
});

test("the Frozen badge survives a param edit that moves status to dirty", async ({ page }) => {
  await newProject(page);
  await addAudioTrack(page);
  await selectTrack(page, 0);
  await addMidiClip(page);

  const gen = page.getByTestId("generative");
  await gen.getByTestId("gen-create").click();
  await gen.getByTestId("gen-render").click();
  await expect(gen.getByTestId("render-status")).toHaveText("ready");
  await gen.getByTestId("gen-freeze").click();
  await expect(gen.getByTestId("render-status")).toHaveText("frozen");

  // "⟳ seed" is a set_render_param — the cheapest real param edit on this surface.
  await gen.getByTitle("new take").click();

  // The layer is now BOTH dirty and frozen. Both readings must show, or the UI is lying
  // about one of them.
  await expect(gen.getByTestId("render-status")).toHaveText("dirty");
  await expect(gen.getByTestId("gen-freeze"), "badge read `status`, not `reactive`")
    .toHaveAttribute("aria-pressed", "true");
  await expect(page.getByTestId("error")).toHaveCount(0);
});

test("thawing re-arms the loop and reports dirty, not ready", async ({ page }) => {
  await newProject(page);
  await addAudioTrack(page);
  await selectTrack(page, 0);
  await addMidiClip(page);

  const gen = page.getByTestId("generative");
  await gen.getByTestId("gen-create").click();
  await gen.getByTestId("gen-render").click();
  await gen.getByTestId("gen-freeze").click();
  await expect(gen.getByTestId("gen-freeze")).toHaveAttribute("aria-pressed", "true");

  await gen.getByTestId("gen-freeze").click();
  await expect(gen.getByTestId("gen-freeze")).toHaveAttribute("aria-pressed", "false");
  await expect(gen.getByTestId("gen-freeze")).toHaveText("Freeze");
  // Deliberately "dirty": edits made while frozen skipped their re-render, so the engine
  // cannot claim the artifact still matches its source.
  await expect(gen.getByTestId("render-status")).toHaveText("dirty");
  await expect(page.getByTestId("error")).toHaveCount(0);
});
