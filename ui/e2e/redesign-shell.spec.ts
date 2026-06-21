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
