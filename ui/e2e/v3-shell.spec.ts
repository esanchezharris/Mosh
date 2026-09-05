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
  await page.getByTestId("v3-booth-record").click();
  await expect(page.getByText("RECORDING", { exact: true })).toHaveCount(0);
  await expect(page.locator(".recording-banner")).toHaveCount(0);
  await expect(page.getByTestId("v3-moshi-dock")).toHaveAttribute("data-recording-safe", "true");
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
