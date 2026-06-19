import { test, expect } from "@playwright/test";
import path from "node:path";
import {
  boot, newProject, TEMPLATES, TEMPLATE_SKIN,
  addAudioTrack, addDrumTrack, selectTrack, addMidiClip, clipsOnTrack,
} from "./helpers";

// Live walkthrough — runs a representative producer-loop slice under each template and
// captures screenshots into e2e-artifacts/ so the skin/layout fidelity is reviewable.
// Doubles as a visual-consistency guard (each shot must render without throwing).

const ART = "e2e-artifacts";

for (const name of TEMPLATES) {
  test(`walkthrough · ${name}`, async ({ page }) => {
    await boot(page);

    // apply the template
    await page.locator('button[title="Settings"]').click();
    await page.getByTestId("template-picker").getByRole("button", { name: TEMPLATE_SKIN[name].label, exact: true }).click();
    await page.keyboard.press("Escape");
    await expect(page.locator("html")).toHaveAttribute("data-skin", TEMPLATE_SKIN[name].skin);

    // build a small arrangement: an instrument track with a MIDI clip + a drum track
    await newProject(page);
    await addAudioTrack(page);
    const audioId = await selectTrack(page, 0);
    await addMidiClip(page);
    await addDrumTrack(page);
    await expect(page.getByTestId("track-header")).toHaveCount(2);
    // reset the topbar's horizontal scroll (interacting with right-side tools scrolls
    // the overflowing bar) so the canonical left-aligned chrome is captured
    await page.getByTestId("topbar").evaluate((el) => (el.scrollLeft = 0));
    await page.screenshot({ path: path.join(ART, `${name}-1-arrange.png`) });

    // the piano roll under this skin
    await clipsOnTrack(page, audioId).first().dblclick();
    await expect(page.getByTestId("piano-roll")).toBeVisible();
    await page.getByTestId("piano-roll").locator(".pr-grid").click({ position: { x: 120, y: 180 } });
    await page.screenshot({ path: path.join(ART, `${name}-2-pianoroll.png`) });
    await page.keyboard.press("Escape");

    // the mixer under this skin
    await page.getByTestId("view-toggle").getByRole("button", { name: "Mixer" }).click();
    await expect(page.getByTestId("mixer")).toBeVisible();
    await page.screenshot({ path: path.join(ART, `${name}-3-mixer.png`) });
  });
}
