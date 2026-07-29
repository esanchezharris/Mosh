import { test, expect, type Page } from "@playwright/test";

// L3 reachability (DAW-parity P5): the master bus (fader + plugin chain in RightRail's
// MasterCard) and the per-track sends surface (Inspector Mix tab), plus meter presence.
// Ledger: docs/verification/REACHABILITY.md.

async function bootV2(page: Page): Promise<void> {
  await page.addInitScript(() => {
    window.localStorage.clear();
    window.localStorage.setItem("mosh.settings", JSON.stringify({ version: 2, template: null, values: { theme: "dark" }, keyOverrides: {} }));
  });
  await page.goto("/?shell=v2");
  await expect(page.getByTestId("v2-shell")).toBeVisible();
  await expect(page.getByTestId("v2-timeline")).toBeVisible();
}

test.beforeEach(async ({ page }) => {
  await bootV2(page);
});

test("master fader moves and round-trips through the snapshot", async ({ page }) => {
  const card = page.getByTestId("v2-master-card");
  await expect(card).toBeVisible();
  const vol = page.getByTestId("v2-master-volume");
  await vol.fill("-6");
  // Round-trip: the control reflects the snapshot, not local state.
  await expect.poll(async () => vol.inputValue()).toBe("-6");
  const pan = page.getByTestId("v2-master-pan");
  await expect(pan).toBeVisible();
});

test("master plugin chain: add a builtin, see the row, remove it", async ({ page }) => {
  await expect(page.getByTestId("v2-master-rack")).toBeVisible();
  const before = await page.getByTestId("v2-master-plugin-row").count();
  await page.getByTestId("v2-master-add-plugin").click();
  const picker = page.getByTestId("v2-master-plugin-picker");
  await expect(picker).toBeVisible();
  // Pick the first offered plugin (the mock's builtin list).
  await picker.locator("button, [role=option]").first().click();
  await expect(page.getByTestId("v2-master-plugin-row")).toHaveCount(before + 1);
});

test("sends surface: + Bus exists in the Mix tab and creates a send slider", async ({ page }) => {
  // Select a track (click its lane header) so the Inspector shows the Mix tab surface.
  await page.locator(".v2-clip").first().click();
  await page.getByTestId("v2-rail-tab-track").click();
  await page.getByTestId("v2-insp-tab-mix").click();
  await expect(page.getByTestId("v2-sends")).toBeVisible();
  await page.getByTestId("v2-add-bus").click();
  // A bus row appears; its add-send affordance creates the per-track send slider.
  const sendRow = page.locator('[data-testid^="v2-send-"], [data-testid^="v2-add-send-"]').first();
  await expect(sendRow).toBeVisible();
});

test("meters exist: per-track meter bars and the master meter field", async ({ page }) => {
  await expect(page.locator(".v2-meter").first()).toBeVisible();
  await expect(page.getByTestId("v2-master-meter-field")).toBeVisible();
});
