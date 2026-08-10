import { test, expect } from "@playwright/test";
import {
  boot, bootRedesign, newProject, TEMPLATES, TEMPLATE_SKIN,
  addAudioTrack, addDrumTrack, selectTrack, addMidiClip, clipsOnTrack,
  dragClipBy, dragClipHeaderBy, clipNum,
} from "./helpers";

// Per-template (Mosh / Ableton / FL) regression: switching the template must apply the
// skin + theme + accent + layout, keep the picker in sync, and preserve the per-DAW
// muscle-memory gestures. (The keymap/gesture TABLE divergence is unit-tested in
// src/interaction/*.test.ts; here we prove it through the live UI.)

const LIME: Record<string, string> = { mosh: "#ccff23", ableton: "#ffcf33", fl: "#ff7a1a", protools: "#34c3a4", logic: "#4d8df0" };

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
  for (const name of ["mosh", "fl", "logic"] as const) {
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

  test("pro tools: clip body moves, header time-selects (Smart Tool)", async ({ page }) => {
    await applyTemplate(page, "protools");
    const clip = await singleMidiClip(page);
    // MIDI body = Grabber: the clip moves.
    await dragClipBy(page, clip, 140);
    await expect.poll(() => clipNum(clip, "data-clip-start")).toBeGreaterThan(0);
    const movedStart = await clipNum(clip, "data-clip-start");
    // Upper/header band = Selector: create a range without moving the clip again.
    await dragClipHeaderBy(page, clip, 120);
    await expect(page.getByTestId("range-band")).toBeVisible();
    expect(await clipNum(clip, "data-clip-start")).toBe(movedStart);
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

  // The template now restructures the dock: Ableton/FL bring the browser forward; Mosh
  // tucks it back to the minimal default. (Applied on switch only.)
  test("ableton/fl open the browser rail; mosh tucks it away", async ({ page }) => {
    await newProject(page); // a genuine no-drum project (the seed now has a drum track)
    await expect(page.getByTestId("browser-expand")).toBeVisible(); // mosh default: browser collapsed
    await applyTemplate(page, "ableton");
    await expect(page.getByTestId("dock-left")).toBeVisible(); // browser opened
    await applyTemplate(page, "fl");
    await expect(page.getByTestId("dock-left")).toBeVisible(); // FL keeps it open
    await expect(page.getByTestId("floating-window")).toHaveCount(0); // no stray drum float on a no-drum project
    await applyTemplate(page, "mosh");
    await expect(page.getByTestId("browser-expand")).toBeVisible(); // back to the rail
    await expect(page.getByTestId("dock-left")).toHaveCount(0);
  });
});

test.describe("dock restructure (redesign shell)", () => {
  test("Pro Tools tucks both rails; Logic opens Library + Inspector", async ({ page }) => {
    await bootRedesign(page);
    await expect(page.getByTestId("dock-right")).toBeVisible(); // redesign default: Inspector open
    // Pro Tools → Edit window: both rails collapse to tabs
    await applyTemplate(page, "protools");
    await expect(page.getByTestId("inspector-expand")).toBeVisible(); // right collapsed
    await expect(page.getByTestId("browser-expand")).toBeVisible();   // left collapsed
    // Logic → Library + Inspector open
    await applyTemplate(page, "logic");
    await expect(page.getByTestId("dock-right")).toBeVisible();        // Inspector back
    await expect(page.getByTestId("dock-left")).toBeVisible();         // Library open
  });
});

test("template choice persists across reload", async ({ page }) => {
  // Templates (the skin system) are a classic-shell feature, so pin uiShell="classic"
  // (Pro Tools is the fresh-settings default). MERGE rather than overwrite so the template this
  // test sets via the UI survives the reload — that persistence is what we're asserting.
  await page.addInitScript(() => {
    const raw = window.localStorage.getItem("mosh.settings");
    const cur = raw ? JSON.parse(raw) : { version: 2, template: null, values: {}, keyOverrides: {} };
    cur.values = { ...(cur.values || {}), uiShell: "classic" };
    window.localStorage.setItem("mosh.settings", JSON.stringify(cur));
  });
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
