import { expect, test, type Page } from "@playwright/test";
import { bootProTools } from "./helpers";

async function commandNames(page: Page): Promise<readonly string[]> {
  return page.evaluate(() => {
    const trace = Reflect.get(window, "__moshCmdTrace");
    if (!Array.isArray(trace)) return [];
    return trace.flatMap((entry) => {
      if (typeof entry !== "object" || entry === null) return [];
      const command = Reflect.get(entry, "command");
      return typeof command === "string" ? [command] : [];
    });
  });
}

test("Track List hides Edit rows without removing or mutating their clips", async ({ page }, testInfo) => {
  // Given a three-track Edit Window with the Universe and Clip List visible.
  await page.setViewportSize({ width: 1440, height: 900 });
  await bootProTools(page);
  await page.getByTestId("pt-universe-toggle").click();
  await expect(page.getByTestId("pt-track-header")).toHaveCount(3);
  await expect(page.getByTestId("pt-lane")).toHaveCount(3);
  await expect(page.getByTestId("pt-universe-track")).toHaveCount(3);
  const commandsBefore = await commandNames(page);

  // When Bass is hidden from the persistent Track List.
  await page.getByTestId("pt-track-visibility-menu").click();
  await page.getByRole("menuitem", { name: "Hide Bass track", exact: true }).click();

  // Then its aligned header, lane, and Universe row close while its clip stays in the session list.
  await expect(page.getByTestId("pt-track-header")).toHaveCount(2);
  await expect(page.getByTestId("pt-track-header").filter({ hasText: "Bass" })).toHaveCount(0);
  await expect(page.getByTestId("pt-lane")).toHaveCount(2);
  await expect(page.getByTestId("pt-universe-track")).toHaveCount(2);
  await expect(page.getByTestId("pt-clip-list-item").filter({ hasText: "Bass" })).toBeVisible();
  expect(await commandNames(page)).toEqual(commandsBefore);
  await page.screenshot({
    path: testInfo.outputPath("protools-track-hidden-wide.png"),
    animations: "disabled",
  });

  // When Bass is shown again, the ordered Edit surfaces return without a command.
  await page.getByTestId("pt-track-visibility-menu").click();
  await page.getByRole("menuitem", { name: "Show Bass track", exact: true }).click();
  await expect(page.getByTestId("pt-track-header")).toHaveCount(3);
  await expect(page.getByTestId("pt-lane")).toHaveCount(3);
  await expect(page.getByTestId("pt-universe-track")).toHaveCount(3);
  expect(await commandNames(page)).toEqual(commandsBefore);
});

test("compact Track List keeps show and hide keyboard reachable", async ({ page }, testInfo) => {
  // Given the reduced-motion compact Edit Window.
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.setViewportSize({ width: 720, height: 720 });
  await bootProTools(page);
  const trigger = page.getByTestId("pt-track-visibility-menu");
  await trigger.scrollIntoViewIfNeeded();
  const triggerBounds = await trigger.boundingBox();
  if (!triggerBounds) throw new Error("Compact Track List trigger bounds are unavailable");
  expect(triggerBounds.width).toBeGreaterThanOrEqual(24);
  expect(triggerBounds.height).toBeGreaterThanOrEqual(24);
  const commandsBefore = await commandNames(page);

  // When Bass is hidden using only keyboard activation.
  await trigger.focus();
  await page.keyboard.press("Enter");
  const hideBass = page.getByRole("menuitem", { name: "Hide Bass track", exact: true });
  await expect(hideBass).toBeVisible();
  const menuBounds = await page.getByTestId("pt-track-visibility-options").boundingBox();
  if (!menuBounds) throw new Error("Compact Track List menu bounds are unavailable");
  expect(menuBounds.x).toBeGreaterThanOrEqual(0);
  expect(menuBounds.x + menuBounds.width).toBeLessThanOrEqual(720);
  await hideBass.focus();
  await page.keyboard.press("Enter");

  // Then the compact Edit Window closes the row and retains a keyboard restoration path.
  await expect(page.getByTestId("pt-track-header")).toHaveCount(2);
  await trigger.focus();
  await page.keyboard.press("Enter");
  const showBass = page.getByRole("menuitem", { name: "Show Bass track", exact: true });
  await expect(showBass).toBeVisible();
  await page.screenshot({
    path: testInfo.outputPath("protools-track-hidden-compact.png"),
    animations: "disabled",
  });
  await showBass.focus();
  await page.keyboard.press("Enter");
  await expect(page.getByTestId("pt-track-header")).toHaveCount(3);
  expect(await commandNames(page)).toEqual(commandsBefore);
});
