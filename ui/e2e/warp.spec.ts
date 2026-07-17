import { test, expect, type Page } from "@playwright/test";

// E2E for Ableton-style "easy warp" in the v2 shell (against the in-memory mock, the
// same command contract the native engine exposes): the Warp inspector tab toggles
// warp (auto-detect on enable), a warp badge appears on the clip, and the Fit-bars
// helper time-stretches the clip to fill N bars.

async function bootV2(page: Page): Promise<void> {
  await page.addInitScript(() => {
    window.localStorage.clear();
    window.localStorage.setItem("mosh.settings", JSON.stringify({ version: 2, template: null, values: { theme: "dark" }, keyOverrides: {} }));
  });
  await page.goto("/?shell=v2");
  await expect(page.getByTestId("v2-shell")).toBeVisible();
  await expect(page.getByTestId("v2-timeline")).toBeVisible();
}

// Select the seeded wave clip ("chords") and open its Warp tab (wave-only tab).
async function openWarpTab(page: Page) {
  const wave = page.locator(".v2-clip.wave").first();
  await expect(wave).toBeVisible();
  await wave.click();
  await page.getByTestId("v2-insp-tab-warp").click();
}

test("Warp tab toggles warp and the clip shows a warp badge", async ({ page }) => {
  await bootV2(page);
  const wave = page.locator(".v2-clip.wave").first();
  await expect(wave).toBeVisible();
  await expect(wave.getByTestId("v2-clip-warp")).toHaveCount(0); // not warped yet

  await openWarpTab(page);
  await page.getByTestId("v2-warp-toggle").click(); // enable (auto-detects BPM)
  await expect(page.getByTestId("v2-warp-toggle")).toHaveAttribute("aria-pressed", "true");
  // badge appears on the (still first) wave clip, and the source BPM readout shows
  await expect(page.locator(".v2-clip.wave").first().getByTestId("v2-clip-warp")).toBeVisible();
  await expect(page.getByTestId("v2-warp-bpm")).toBeVisible();
});

test('"Fit 4" bars time-stretches the wave clip wider', async ({ page }) => {
  await bootV2(page);
  const wave = page.locator(".v2-clip.wave").first();
  await expect(wave).toBeVisible();
  const before = await wave.boundingBox();
  if (!before) throw new Error("no wave clip");

  await openWarpTab(page);
  await page.getByTestId("v2-warp-toggle").click(); // reveal the helpers
  await page.getByTestId("v2-warp-fit-4").click();  // 4 bars @120bpm 4/4 = 8s (chords is 6s)

  await expect.poll(async () => {
    const b = await page.locator(".v2-clip.wave").first().boundingBox();
    return b ? Math.round(b.width) : 0;
  }).toBeGreaterThan(Math.round(before.width) + 8);
});

test("Detect BPM surfaces a reading", async ({ page }) => {
  await bootV2(page);
  await openWarpTab(page);
  await page.getByTestId("v2-warp-toggle").click();
  await page.getByTestId("v2-warp-detect").click();
  await expect(page.getByTestId("v2-warp-detected")).toBeVisible();
  await expect(page.getByTestId("v2-warp-apply")).toBeVisible();
});
