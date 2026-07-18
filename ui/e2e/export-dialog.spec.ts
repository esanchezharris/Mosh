import { test, expect, type Page } from "@playwright/test";

// L3 reachability (DAW-parity P5): the export surface — range/tail/format via the shared
// ExportControls, reached in v2 through the Composer "+" (FileOptions). The stems test is
// a FIXME: export_stems shipped natively (#410) with NO UI affordance (G19) — this spec
// is that backlog item's definition of done. Ledger: docs/verification/REACHABILITY.md.

async function bootV2(page: Page): Promise<void> {
  await page.addInitScript(() => {
    window.localStorage.clear();
    window.localStorage.setItem("mosh.settings", JSON.stringify({ version: 2, template: null, values: { theme: "dark" }, keyOverrides: {} }));
  });
  await page.goto("/?shell=v2");
  await expect(page.getByTestId("v2-shell")).toBeVisible();
  await expect(page.getByTestId("v2-timeline")).toBeVisible();
}

async function openFileOptions(page: Page) {
  await page.getByTestId("file-options").click();
  await expect(page.getByTestId("file-options-menu")).toBeVisible();
}

test.beforeEach(async ({ page }) => {
  await bootV2(page);
});

test("export with a custom range + tail policy completes from the v2 shell", async ({ page }) => {
  await openFileOptions(page);
  await page.getByTestId("export-range").selectOption("custom");
  await page.getByTestId("export-start").fill("0.5");
  await page.getByTestId("export-end").fill("2");
  await page.getByTestId("export-tail").selectOption("include");
  await expect(page.getByTestId("export-tail-seconds")).toBeVisible(); // progressive disclosure
  await page.getByTestId("export-run").click();
  await expect(page.getByTestId("export-done")).toBeVisible();
  await expect(page.getByTestId("export-done")).toContainText("Exported to:");
});

test("loop range option exists alongside full/custom", async ({ page }) => {
  await openFileOptions(page);
  const range = page.getByTestId("export-range");
  const options = await range.locator("option").allTextContents();
  expect(options.join(" ").toLowerCase()).toContain("loop");
});

// G19 — export_stems has no UI affordance. Remove the fixme in the PR that adds the
// stems action to ExportControls (acceptance in docs/auto-loop/backlog.jsonl).
test.fixme("stem export runs from the export surface", async ({ page }) => {
  await openFileOptions(page);
  await page.getByTestId("export-stems-run").click();
  await expect(page.getByTestId("export-done")).toBeVisible();
});
