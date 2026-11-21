import { test, expect, type Page } from "@playwright/test";
import { bootV3 } from "./helpers";

// Ported from templates.spec.ts. The old spec drove the classic shell's Settings → template
// picker (skin + theme + accent per template, per-DAW clip gestures, dock restructure) — all
// of that is classic-only. V3 has no template picker; it pins data-skin=mosh (settings/effects.ts)
// and its only "template" is File → Templates → Full Studio.
//
// ALREADY COVERED, not duplicated: skin/theme application per template (store.test.ts:230-238),
// the template bundles themselves (templates.test.ts), per-DAW gesture tables
// (src/interaction/*.test.ts), clip body-drag move under the Mosh table (v3-timeline.spec.ts).
// Dropped with the shells: the protools/live templates, drum-float-on-FL, dock restructure.

const SETTINGS_KEY = "mosh.settings";

async function bootWithTemplate(page: Page, template: string, skin: string, theme: string) {
  await page.addInitScript(([t, s, th]) => {
    window.localStorage.clear();
    window.localStorage.setItem("mosh.settings", JSON.stringify({
      version: 2, template: t, values: { skin: s, theme: th, startOnLaunch: false }, keyOverrides: {},
    }));
  }, [template, skin, theme] as const);
  await page.goto("/?shell=v3");
  await expect(page.getByTestId("v3-shell")).toBeVisible();
  await expect(page.getByTestId("v3-arrangement")).toBeVisible();
}

for (const [template, skin, theme] of [["ableton", "ableton", "light"], ["fl", "fl", "dark"], ["logic", "logic", "dark"]] as const) {
  test(`a stored ${template} template does not reskin V3 (data-skin stays mosh)`, async ({ page }) => {
    await bootWithTemplate(page, template, skin, theme);
    await expect(page.locator("html")).toHaveAttribute("data-skin", "mosh");
    // …and V3's own palette tokens are still the ones in force, not the template's accent.
    const lime = await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue("--lime").trim().toLowerCase());
    expect(lime).not.toBe({ ableton: "#ffcf33", fl: "#ff7a1a", logic: "#4d8df0" }[template]);
  });
}

test("the stored template choice survives a reload (V3 never clobbers it)", async ({ page }) => {
  await page.addInitScript(() => {
    // Seed once per tab so the reload keeps whatever V3 wrote back.
    if (window.sessionStorage.getItem("mosh.e2e.seeded")) return;
    window.sessionStorage.setItem("mosh.e2e.seeded", "1");
    window.localStorage.clear();
    window.localStorage.setItem("mosh.settings", JSON.stringify({
      version: 2, template: "fl", values: { skin: "fl", theme: "dark", startOnLaunch: false }, keyOverrides: {},
    }));
  });
  await page.goto("/?shell=v3");
  await expect(page.getByTestId("v3-arrangement")).toBeVisible();
  await page.reload();
  await expect(page.getByTestId("v3-arrangement")).toBeVisible();
  const stored = await page.evaluate((k) => JSON.parse(window.localStorage.getItem(k) ?? "{}"), SETTINGS_KEY);
  expect(stored.template).toBe("fl");
  await expect(page.locator("html")).toHaveAttribute("data-skin", "mosh");
});

test("File → Templates → Full Studio puts the workspace back and shows it checked", async ({ page }) => {
  await bootV3(page);
  await page.getByTestId("v3-file-trigger").click();
  await page.getByTestId("v3-templates").hover();
  const full = page.getByTestId("v3-template-studio");
  await expect(full).toBeVisible();
  await full.click();
  await expect(page.getByTestId("v3-arrangement")).toBeVisible();

  await page.getByTestId("v3-file-trigger").click();
  await page.getByTestId("v3-templates").hover();
  await expect(page.getByTestId("v3-template-studio").locator(".check")).toBeVisible();
});
