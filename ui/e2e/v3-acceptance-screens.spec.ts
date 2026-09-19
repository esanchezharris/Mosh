import { test, expect, type Page } from "@playwright/test";
import { mkdirSync } from "node:fs";
import { join } from "node:path";

/**
 * V3 default-shell acceptance, row V3-feel — the automatable half (docs/VERIFICATION.md).
 *
 * The owner row asks for ten minutes of ordinary use in each colorway. What a machine can
 * do honestly is walk every V3 surface in every colorway, prove the accent actually
 * changed (a pixel readback, not a class name), and leave a contact sheet of screenshots
 * for the owner to flip through. scripts/v3-acceptance/run.py sets V3_ACCEPT_OUT to the
 * evidence directory; without it the PNGs land in the Playwright output dir.
 */
const OUT = process.env.V3_ACCEPT_OUT ?? "test-results/v3-acceptance-screens";
const COLORWAYS = ["lime", "bone", "violet", "coral"] as const;

async function bootColorway(page: Page, colorway: string): Promise<void> {
  await page.addInitScript((cw) => {
    window.localStorage.clear();
    window.localStorage.setItem("mosh.settings", JSON.stringify({
      version: 2, template: null, values: { colorway: cw }, keyOverrides: {},
    }));
  }, colorway);
  await page.goto("/?shell=v3");
  await expect(page.getByTestId("v3-shell")).toBeVisible();
  await expect(page.getByTestId("v3-arrangement")).toBeVisible();
  await expect(page.getByTestId("v3-shell")).toHaveAttribute("data-colorway", colorway);
}

/** The accent as rendered: paint --accent on a 1×1 canvas and read the pixel bytes
 *  (Chromium reports color-mix results in oklab, so a string compare is useless). */
async function accentRgb(page: Page): Promise<[number, number, number]> {
  return page.evaluate(() => {
    const accent = getComputedStyle(document.querySelector('[data-testid="v3-shell"]')!).getPropertyValue("--accent").trim();
    const c = document.createElement("canvas"); c.width = c.height = 1;
    const g = c.getContext("2d")!; g.fillStyle = accent; g.fillRect(0, 0, 1, 1);
    const d = g.getImageData(0, 0, 1, 1).data;
    return [d[0], d[1], d[2]] as [number, number, number];
  });
}

test.describe("V3-feel: every surface in every colorway", () => {
  test.beforeAll(() => { mkdirSync(OUT, { recursive: true }); });

  const seen = new Map<string, [number, number, number]>();

  for (const colorway of COLORWAYS) {
    test(`colorway ${colorway}: arrangement, editor, mixer, browser, plugins, booth, invite, settings`, async ({ page }) => {
      await page.setViewportSize({ width: 1440, height: 900 });
      await bootColorway(page, colorway);
      const shot = (name: string) => page.screenshot({ path: join(OUT, `${colorway}-${name}.png`), fullPage: false });

      seen.set(colorway, await accentRgb(page));
      await shot("01-arrangement");

      // A MIDI clip with the shared editor open — the accent on real content.
      const bass = page.locator('[data-testid="v3-track"]').filter({ hasText: "Bass" });
      await bass.getByTestId("v3-clip").first().dblclick();
      await expect(page.getByTestId("piano-roll")).toBeVisible();
      await shot("02-editor");
      await page.keyboard.press("Escape");
      await expect(page.getByTestId("piano-roll")).toHaveCount(0);

      await page.getByTestId("v3-rail-mixer").click();
      await expect(page.getByTestId("v3-mixer")).toBeVisible();
      await shot("03-mixer");

      await page.getByTestId("v3-rail-browser").click();
      await expect(page.getByTestId("v3-browser")).toBeVisible();
      await shot("04-browser");

      await page.getByTestId("v3-rail-plugins").click();
      await expect(page.getByTestId("v3-plugins-pane")).toBeVisible();
      await shot("05-plugins");

      await page.getByTestId("v3-mp-trigger").click();
      await expect(page.getByTestId("mp-launcher-modal")).toBeVisible();
      await shot("06-invite");
      await page.keyboard.press("Escape");
      await expect(page.getByTestId("mp-launcher-modal")).toHaveCount(0);

      await page.getByTestId("v3-rail-plugins").click();   // put the side pane away first
      await expect(page.getByTestId("v3-plugins-pane")).toHaveCount(0);
      await page.getByTestId("v3-file-trigger").click();
      await page.getByTestId("v3-templates").hover();
      await page.getByTestId("v3-template-booth").click();
      await expect(page.getByTestId("v3-booth")).toBeVisible();
      await expect(page.getByTestId("v3-file-menu")).toHaveAttribute("aria-hidden", "true");   // the menu stays mounted…
      await expect.poll(() => page.getByTestId("v3-file-menu").evaluate((el) => {                // …and fades: wait for the fade
        const cs = getComputedStyle(el); return cs.visibility === "hidden" || Number(cs.opacity) === 0 || cs.display === "none";
      })).toBe(true);
      await shot("07-booth");
      await page.getByTestId("v3-booth-studio").click();
      await expect(page.getByTestId("v3-arrangement")).toBeVisible();

      await page.getByTestId("v3-file-trigger").click();
      await page.getByTestId("v3-open-settings").click();
      await expect(page.getByTestId("v3-settings")).toBeVisible();
      await shot("08-settings");
    });
  }

  test("the four colorways render four different accents (the screenshots are not the same page in four folders)", async ({ page }) => {
    // Anti-vacuity for the walk above: read each accent fresh here so this test does not
    // depend on the walk's order, then require them pairwise distinct by a real margin.
    const rgb: Record<string, [number, number, number]> = {};
    for (const cw of COLORWAYS) { await bootColorway(page, cw); rgb[cw] = await accentRgb(page); }
    const dist = (a: number[], b: number[]) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
    for (let i = 0; i < COLORWAYS.length; i++)
      for (let j = i + 1; j < COLORWAYS.length; j++)
        expect(dist(rgb[COLORWAYS[i]], rgb[COLORWAYS[j]]), `${COLORWAYS[i]} vs ${COLORWAYS[j]}`).toBeGreaterThan(40);
  });
});
