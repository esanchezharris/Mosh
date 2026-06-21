import { test, expect, type Page } from "@playwright/test";

// The redesign shell (Inspector right rail) is gated behind the default-off
// `redesignShell` setting. Seed it on before boot, the way hands-free.spec seeds a
// single setting override.
async function bootRedesign(page: Page): Promise<void> {
  await page.addInitScript(() => {
    window.localStorage.clear();
    window.localStorage.setItem("mosh.settings", JSON.stringify({ version: 1, template: null, values: { redesignShell: true } }));
  });
  await page.goto("/");
  await expect(page.getByTestId("app")).toBeVisible();
  await expect(page.getByTestId("arrangement")).toBeVisible();
}

test("flag on: Inspector right rail starts collapsed and expands on click", async ({ page }) => {
  await bootRedesign(page);
  const tab = page.getByTestId("inspector-expand");
  await expect(tab).toBeVisible();
  await expect(page.getByTestId("dock-right")).toHaveCount(0);
  await tab.click();
  await expect(page.getByTestId("dock-right")).toBeVisible();
});

test("flag off (default): no Inspector rail", async ({ page }) => {
  await page.addInitScript(() => window.localStorage.clear());
  await page.goto("/");
  await expect(page.getByTestId("arrangement")).toBeVisible();
  await expect(page.getByTestId("inspector-expand")).toHaveCount(0);
});

test("flag on: Inspector shows the selected track's mix controls", async ({ page }) => {
  await bootRedesign(page);
  await page.getByTestId("inspector-expand").click();
  await page.getByTestId("track-header").first().click();
  const insp = page.getByTestId("inspector");
  await expect(insp).toBeVisible();
  await expect(insp.getByText("Volume", { exact: true })).toBeVisible();
  await expect(insp.getByText("Pan", { exact: true })).toBeVisible();
});

test("flag on: top-right presence cluster (AI pill + Share)", async ({ page }) => {
  await bootRedesign(page);
  await expect(page.getByTestId("presence")).toBeVisible();
  await expect(page.getByTestId("ai-pill")).toBeVisible();
  await expect(page.getByTestId("share")).toBeVisible();
});

test("flag off (default): no presence cluster", async ({ page }) => {
  await page.addInitScript(() => window.localStorage.clear());
  await page.goto("/");
  await expect(page.getByTestId("arrangement")).toBeVisible();
  await expect(page.getByTestId("presence")).toHaveCount(0);
});

test("flag on: a track's FX drawer opens from the header and collapses again", async ({ page }) => {
  await bootRedesign(page);
  const toggle = page.getByTestId("track-fx-toggle").first();
  await expect(toggle).toBeVisible();
  await expect(page.getByTestId("fx-drawer")).toHaveCount(0);
  await toggle.click();
  const drawer = page.getByTestId("fx-drawer").first();
  await expect(drawer).toBeVisible();
  await expect(drawer.getByRole("button", { name: "+ Plugin", exact: true })).toBeVisible();
  await toggle.click();
  await expect(page.getByTestId("fx-drawer")).toHaveCount(0);
});

test("flag off (default): no per-track FX toggle", async ({ page }) => {
  await page.addInitScript(() => window.localStorage.clear());
  await page.goto("/");
  await expect(page.getByTestId("arrangement")).toBeVisible();
  await expect(page.getByTestId("track-fx-toggle")).toHaveCount(0);
});

test("flag on: the agent prompt lives in a dedicated bottom bar", async ({ page }) => {
  await bootRedesign(page);
  const bar = page.getByTestId("promptbar");
  await expect(bar).toBeVisible();
  await expect(bar.locator(".agent-composer")).toBeVisible();
});

test("flag off (default): no bottom prompt bar (prompt stays in the Moshi dock)", async ({ page }) => {
  await page.addInitScript(() => window.localStorage.clear());
  await page.goto("/");
  await expect(page.getByTestId("arrangement")).toBeVisible();
  await expect(page.getByTestId("promptbar")).toHaveCount(0);
});

test("flag on: section navigator shows sections, adds one, and has zoom presets", async ({ page }) => {
  await bootRedesign(page);
  const nav = page.getByTestId("section-nav");
  await expect(nav).toBeVisible();
  await expect(page.getByTestId("section-seg")).toHaveCount(3); // seeded Intro / Verse / Hook
  await page.getByTestId("section-add").click();
  await expect(page.getByTestId("section-seg")).toHaveCount(4);
  await expect(nav.getByRole("button", { name: "8B", exact: true })).toBeVisible();
});

test("flag off (default): no section navigator", async ({ page }) => {
  await page.addInitScript(() => window.localStorage.clear());
  await page.goto("/");
  await expect(page.getByTestId("arrangement")).toBeVisible();
  await expect(page.getByTestId("section-nav")).toHaveCount(0);
});
