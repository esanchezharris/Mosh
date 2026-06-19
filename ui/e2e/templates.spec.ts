import { test, expect } from "@playwright/test";
import {
  boot, newProject, TEMPLATES, TEMPLATE_SKIN,
  addAudioTrack, addDrumTrack, selectTrack, addMidiClip, clipsOnTrack,
  dragClipBy, dragClipHeaderBy, clipNum,
} from "./helpers";

// Per-template (Mosh / Ableton / FL) regression: switching the template must apply the
// skin + theme + accent + layout, keep the picker in sync, and preserve the per-DAW
// muscle-memory gestures. (The keymap/gesture TABLE divergence is unit-tested in
// src/interaction/*.test.ts; here we prove it through the live UI.)

const LIME: Record<string, string> = { mosh: "#ccff23", ableton: "#ffcf33", fl: "#ff7a1a" };

test.describe("template applied", () => {
  test.beforeEach(async ({ page }) => {
    await boot(page);
  });

  for (const name of TEMPLATES) {
    test(`${name}: skin + theme + accent + picker state`, async ({ page }) => {
      // open Settings and select the template
      await page.locator('button[title="Settings"]').click();
      const picker = page.getByTestId("template-picker");
      const button = picker.getByRole("button", { name: TEMPLATE_SKIN[name].label, exact: true });
      await button.click();
      await expect(button).toHaveAttribute("aria-pressed", "true");

      const html = page.locator("html");
      await expect(html).toHaveAttribute("data-skin", TEMPLATE_SKIN[name].skin);
      await expect(html).toHaveAttribute("data-theme", TEMPLATE_SKIN[name].theme);

      const lime = await page.evaluate(() =>
        getComputedStyle(document.documentElement).getPropertyValue("--lime").trim().toLowerCase(),
      );
      expect(lime).toBe(LIME[name]);
    });
  }

  // Core gesture muscle-memory: under Mosh & FL the whole clip body drags to move;
  // under Ableton the body time-selects and only the header moves.
  for (const name of ["mosh", "fl"] as const) {
    test(`${name}: clip body drag moves the clip`, async ({ page }) => {
      await applyTemplate(page, name);
      const clip = await singleMidiClip(page);
      expect(await clipNum(clip, "data-clip-start")).toBe(0);
      await dragClipBy(page, clip, 120);
      await expect.poll(() => clipNum(clip, "data-clip-start")).toBeGreaterThan(0);
    });
  }

  test("ableton: clip body time-selects, header moves", async ({ page }) => {
    await applyTemplate(page, "ableton");
    const clip = await singleMidiClip(page);
    // body drag → a time-range band appears, clip does NOT move
    await dragClipBy(page, clip, 140);
    await expect(page.getByTestId("range-band")).toBeVisible();
    expect(await clipNum(clip, "data-clip-start")).toBe(0);
    // header drag → the clip moves
    await dragClipHeaderBy(page, clip, 120);
    await expect.poll(() => clipNum(clip, "data-clip-start")).toBeGreaterThan(0);
  });

  test("fl: switching to FL pops the floating drum sequencer for a drum clip", async ({ page }) => {
    await newProject(page);
    await addDrumTrack(page);
    await selectTrack(page, 0); // the drum track
    await addMidiClip(page); // give it a MIDI clip so the FL layout has something to open
    await expect(page.getByTestId("floating-window")).toHaveCount(0);
    await applyTemplate(page, "fl");
    await expect(page.getByTestId("floating-window")).toBeVisible();
    await expect(page.getByTestId("drum-sequencer")).toBeVisible();
  });
});

test("template choice persists across reload", async ({ page }) => {
  // no localStorage-clearing init script here, so persistence is observable
  await page.goto("/");
  await expect(page.getByTestId("app")).toBeVisible();
  await page.locator('button[title="Settings"]').click();
  await page.getByTestId("template-picker").getByRole("button", { name: "FL", exact: true }).click();
  await page.keyboard.press("Escape");
  await expect(page.locator("html")).toHaveAttribute("data-skin", "fl");
  await page.reload();
  await expect(page.locator("html")).toHaveAttribute("data-skin", "fl");
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
});

// ── local helpers ────────────────────────────────────────────────────────────
async function applyTemplate(page: import("@playwright/test").Page, name: (typeof TEMPLATES)[number]) {
  await page.locator('button[title="Settings"]').click();
  await page.getByTestId("template-picker").getByRole("button", { name: TEMPLATE_SKIN[name].label, exact: true }).click();
  await page.keyboard.press("Escape");
  await expect(page.locator("html")).toHaveAttribute("data-skin", TEMPLATE_SKIN[name].skin);
}

async function singleMidiClip(page: import("@playwright/test").Page) {
  await newProject(page);
  await addAudioTrack(page);
  const id = await selectTrack(page, 0);
  await addMidiClip(page);
  const clip = clipsOnTrack(page, id).first();
  await expect(clip).toBeVisible();
  return clip;
}
