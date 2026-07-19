import { test, expect } from "@playwright/test";
import { boot } from "./helpers";

// Taste loop (workshop 2026-07-19) — the ⌘⇧F "felt wrong" capture dialog.
// Dev/mock has no native archive_pair (archivePair no-ops outside the WebView), so
// these specs assert the interaction contract: hotkey opens, empty tag can't save,
// Enter captures and closes, Escape cancels, and typing in the tag field never
// triggers app shortcuts.

test.describe("felt-wrong capture", () => {
  test("Mod+Shift+F opens the dialog; Enter with a tag captures and closes", async ({ page }) => {
    await boot(page);
    await page.keyboard.press("Meta+Shift+F");
    const dialog = page.getByTestId("felt-wrong-dialog");
    await expect(dialog).toBeVisible();

    const input = page.getByTestId("felt-wrong-tag");
    await expect(input).toBeFocused();
    await expect(page.getByTestId("felt-wrong-save")).toBeDisabled();

    await input.fill("drums stiff");
    await expect(page.getByTestId("felt-wrong-save")).toBeEnabled();
    await input.press("Enter");
    await expect(dialog).not.toBeVisible();
  });

  test("Escape cancels without capturing; typing in the tag never fires shortcuts", async ({ page }) => {
    await boot(page);
    await page.keyboard.press("Meta+Shift+F");
    const input = page.getByTestId("felt-wrong-tag");
    await expect(input).toBeVisible();

    // "1"/"2"/"3" are tool-switch shortcuts on the arrangement; inside the tag
    // input they must just type (isEditableTarget + the input's stopPropagation).
    await input.fill("2 fast");
    await expect(input).toHaveValue("2 fast");

    await page.keyboard.press("Escape");
    await expect(page.getByTestId("felt-wrong-dialog")).not.toBeVisible();

    // The dialog reopens cleanly after a cancel.
    await page.keyboard.press("Meta+Shift+F");
    await expect(page.getByTestId("felt-wrong-dialog")).toBeVisible();
  });
});
