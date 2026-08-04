import { test, expect, type Page } from "@playwright/test";

// L3 reachability (DAW-parity P5): the export surface — range/tail/format via the shared
// ExportControls, reached in v2 through the Composer "+" (FileOptions).
//
// The G19 stems test below was a FIXME whose comment said export_stems had "NO UI
// affordance". That was WRONG for weeks: the affordance shipped as a `mixdown | stems`
// mode select (`export-mode`) with a confirm gate. The fixme pointed at
// `export-stems-run`, a testid chosen before the work and never reconciled with the one
// that shipped — so a finished feature read as debt. Ledger:
// docs/verification/REACHABILITY.md.

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

// G19 — the stems mode is reachable; the fixme's selector was the only thing missing.
test("stem export is reachable from the export surface", async ({ page }) => {
  await openFileOptions(page);
  await page.getByTestId("export-mode").selectOption("stems");
  await expect(page.getByTestId("export-run")).toBeVisible();
});

// #551 — the spec that used to live here pinned the export dialog's undithered-16-bit
// warning. It was DELETED deliberately, not lost in a merge: the warning was true until
// CAP-EXP-001 shipped TPDF dither, and a spec is very good at keeping a false warning alive
// forever. The depth selector itself is still exercised, below. What replaced it:
// ui/src/ui/ExportControls.dither.test.ts (the retired copy must not creep back) and
// check_export_dither in scripts/verify-hardware/verify.py (the dither is real, measured on
// rendered audio rather than asserted).
test("bit depth is selectable and the export still runs at 16-bit", async ({ page }) => {
  await openFileOptions(page);
  await page.getByTestId("export-depth").selectOption("16");
  await expect(page.getByTestId("export-depth")).toHaveValue("16");
  await page.getByTestId("export-run").click();
  await expect(page.getByTestId("export-done")).toBeVisible();
});
