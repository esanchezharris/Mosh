import { test, expect, type Page } from "@playwright/test";
import { bootV3 } from "./helpers";

async function bootV3Page(page: Page): Promise<void> {
  await bootV3(page);
}

test("idle studio chrome: title File, transport, History, no Undo / banner / top toggle", async ({ page }) => {
  await bootV3Page(page);
  await expect(page.getByTestId("v3-shell")).toHaveAttribute("data-colorway", "lime");
  await expect(page.getByTestId("v3-file-trigger")).toBeVisible();
  await expect(page.getByTestId("v3-record")).toBeVisible();
  await expect(page.getByTestId("v3-play")).toBeVisible();
  await expect(page.getByTestId("v3-stop")).toBeVisible();
  await expect(page.getByTestId("v3-history")).toBeVisible();
  await expect(page.getByTestId("v3-arrangement")).toBeVisible();
  await expect(page.getByTestId("v3-inspector")).toBeVisible();
  await expect(page.getByTestId("v3-moshi-dock")).toBeVisible();
  await expect(page.getByRole("button", { name: "Undo", exact: true })).toHaveCount(0);
  await expect(page.getByText("RECORDING", { exact: true })).toHaveCount(0);
  await expect(page.locator(".recording-banner")).toHaveCount(0);
  await expect(page.getByTestId("v3-studio-toggle")).toHaveCount(0);
});

test("History flyout opens from the text control", async ({ page }) => {
  await bootV3Page(page);
  await page.getByTestId("v3-history").click();
  await expect(page.getByTestId("v3-history-flyout")).toBeVisible();
  await expect(page.getByTestId("v3-history-flyout")).toContainText("Cmd+Z");
});

test("Settings colorway writes data-colorway", async ({ page }) => {
  await bootV3Page(page);
  await page.getByTestId("v3-file-trigger").click();
  await page.getByTestId("v3-open-settings").click();
  await expect(page.getByTestId("v3-settings")).toBeVisible();
  await page.locator('[data-testid="v3-colorway"][data-colorway="violet"]').click();
  await expect(page.getByTestId("v3-shell")).toHaveAttribute("data-colorway", "violet");
});

test("the colorway reaches the accents: a selected clip's border follows violet, not fixed lime", async ({ page }) => {
  await bootV3Page(page);
  const clip = page.getByTestId("v3-clip").first();
  // Chromium reports color-mix results in oklab; painting one pixel and reading it back gives
  // sRGB bytes whatever the syntax.
  const border = () => clip.evaluate((el) => {
    const canvas = document.createElement("canvas"); canvas.width = 1; canvas.height = 1;
    const ctx = canvas.getContext("2d")!;
    ctx.fillStyle = "#000"; ctx.fillRect(0, 0, 1, 1);
    ctx.fillStyle = getComputedStyle(el).borderTopColor; ctx.fillRect(0, 0, 1, 1);
    const d = ctx.getImageData(0, 0, 1, 1).data;
    return [d[0], d[1], d[2]];
  });
  await clip.click();
  await expect(clip).toHaveClass(/hl/);
  // the clip's border-color TRANSITIONS from the base grey, so poll until the accent has landed
  await expect.poll(async () => { const [r, g] = await border(); return g > r; }).toBe(true);   // lime: green leads
  const lime = await border();
  expect(Array.isArray(lime)).toBe(true);                                  // anti-vacuity: a real colour
  await page.getByTestId("v3-file-trigger").click();
  await page.getByTestId("v3-open-settings").click();
  await page.locator('[data-testid="v3-colorway"][data-colorway="violet"]').click();
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("v3-shell")).toHaveAttribute("data-colorway", "violet");
  await expect.poll(async () => { const [, g, b] = await border(); return b > g; }).toBe(true);   // violet #B8A4FF: blue leads (after the transition)
  expect(JSON.stringify(await border())).not.toBe(JSON.stringify(lime));
});

test("File menu Templates enter Booth without a top toggle or RECORDING banner", async ({ page }) => {
  await bootV3Page(page);
  await page.getByTestId("v3-file-trigger").click();
  await expect(page.getByTestId("v3-file-menu")).toBeVisible();
  await page.getByTestId("v3-templates").hover();
  await page.getByTestId("v3-template-booth").click();
  await expect(page.getByTestId("v3-booth")).toBeVisible();
  await expect(page.getByTestId("v3-arrangement")).toHaveCount(0);
  await expect(page.getByText("RECORDING", { exact: true })).toHaveCount(0);
  await expect(page.locator(".recording-banner")).toHaveCount(0);
  // the Booth is the recording loop's pad now: pick a Lead, then roll
  await page.getByTestId("v3-booth-setup").click();
  await page.getByTestId("v3-loop-record").click();
  await expect(page.getByTestId("v3-record")).toHaveClass(/on/);
  await expect(page.getByText("RECORDING", { exact: true })).toHaveCount(0);
  await expect(page.locator(".recording-banner")).toHaveCount(0);
  await expect(page.getByTestId("v3-moshi-dock")).toHaveAttribute("data-recording-safe", "true");
  await page.getByTestId("v3-loop-stop").click();
  await page.getByTestId("v3-booth-studio").click();
  await expect(page.getByTestId("v3-arrangement")).toBeVisible();
});

test("Ask Moshi field is a dock, not a chat thread", async ({ page }) => {
  await bootV3Page(page);
  await expect(page.getByTestId("v3-moshi-field")).toBeVisible();
  await expect(page.getByTestId("v3-moshi-mic")).toBeVisible();
  await expect(page.getByTestId("agent-drawer")).toHaveCount(0);
  await expect(page.locator(".agent-composer")).toHaveCount(0);
});
