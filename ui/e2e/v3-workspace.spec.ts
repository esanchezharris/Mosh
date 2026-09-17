import { expect, test } from "@playwright/test";
import { bootV3 } from "./helpers";

for (const width of [900, 1440]) {
  test(`ordinary V3 workspace is reachable at ${width}`, async ({ page }, info) => {
    await page.setViewportSize({ width, height: 900 });
    await bootV3(page);
    await page.getByTestId("v3-add-midi").click();
    const track = page.getByTestId("v3-track").last();
    await track.getByRole("button", { name: /^Select track/ }).click();
    await expect(page.getByTestId("v3-add-midi-clip")).toBeEnabled();
    await track.getByTestId("v3-clip").dblclick();
    const roll = page.getByTestId("piano-roll");
    await expect(roll).toBeVisible();
    await expect(roll).toHaveCSS("background-color", "rgb(22, 26, 26)");
    await page.screenshot({ path: info.outputPath(`midi-${width}.png`) });
    await page.keyboard.press("Escape");
    await expect(roll).toHaveCount(0);
    const trackCount = await page.getByTestId("v3-track").count();
    await page.getByTestId("v3-rail-mixer").click();
    await expect(page.getByTestId("v3-mixer")).toBeVisible();
    await expect(page.getByTestId("channel-strip")).toHaveCount(trackCount);
    const strip = page.getByTestId("channel-strip").last();
    const volume = strip.getByRole("slider", { name: /volume$/ });
    await volume.focus();
    await page.keyboard.press("ArrowDown");
    await expect(volume).toHaveValue("-0.5");
    await strip.getByRole("button", { name: /^Mute / }).click();
    await expect(strip.getByRole("button", { name: /^Mute / })).toHaveAttribute("aria-pressed", "true");
    await page.screenshot({ path: info.outputPath(`mixer-${width}.png`) });
    await page.getByRole("button", { name: "Back to arrangement" }).click();
    await expect(page.getByTestId("v3-arrangement")).toBeVisible();
    expect(await page.getByTestId("v3-shell").evaluate((node) => node.scrollWidth <= node.clientWidth)).toBe(true);
    await page.keyboard.press("Meta+Comma");
    await expect(page.getByTestId("v3-settings")).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(page.getByTestId("v3-settings")).toHaveCount(0);
    await page.getByTestId("v3-history").click();
    await expect(page.getByTestId("v3-history-flyout")).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(page.getByTestId("v3-history-flyout")).toHaveCount(0);
  });
}

test("empty V3 session offers existing track and import actions", async ({ page }, info) => {
  await bootV3(page);
  await page.getByTestId("v3-file-trigger").click();
  await page.getByRole("menuitem", { name: "New Session" }).click();
  await expect(page.getByTestId("v3-track")).toHaveCount(0);
  await expect(page.getByText("Start your session")).toBeVisible();
  await page.screenshot({ path: info.outputPath("empty.png") });
  await page.getByTestId("v3-add-audio").click();
  await expect(page.getByTestId("v3-track")).toHaveCount(1);
  await page.getByTestId("v3-import-audio").click();
  await expect(page.getByTestId("v3-browser")).toBeVisible();
  await page.getByTestId("v3-rail-plugins").click();
  await expect(page.getByTestId("v3-plugins")).toBeVisible();
});
