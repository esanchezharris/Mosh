import { test, expect } from "@playwright/test";
import { boot, newProject, addAudioTrack, selectTrack } from "./helpers";

// Route C.2 — the real-time RAVE insert's rack UI (against the dev mock, which reports
// session.raveAvailable=true). The "+ RAVE" affordance is gated on that flag, so it only
// appears where the anira build can host a model.

test.beforeEach(async ({ page }) => {
  await boot(page);
});

test("RAVE insert: + RAVE → card → load model", async ({ page }) => {
  await newProject(page);
  await addAudioTrack(page);
  await selectTrack(page, 0);

  const rack = page.getByTestId("rack");
  const addRave = rack.getByTestId("rack-add-rave");
  await expect(addRave).toBeVisible();          // gated on session.raveAvailable
  await addRave.click();

  const card = rack.getByTestId("plugin-card").filter({ hasText: "RAVE" });
  await expect(card).toHaveCount(1);
  await expect(card.getByTestId("rave-model-name")).toHaveText("no model loaded");
  await expect(card.getByTestId("rave-mix")).toBeVisible();

  // Lane B — pick a model from the BROWSER dropdown (list_rave_models); the card reflects it.
  await card.getByTestId("rave-model-select").selectOption("guitar");
  await expect(card.getByTestId("rave-model-name")).toHaveText("guitar");

  // The "path…" escape hatch still loads a custom .ts via the prompt dialog.
  page.once("dialog", (d) => d.accept("flute"));
  await card.getByTestId("rave-load-custom").click();
  await expect(card.getByTestId("rave-model-name")).toHaveText("flute");

  await expect(page.getByTestId("error")).toHaveCount(0);
});
