import { expect, test } from "@playwright/test";
import { bootProTools } from "./helpers";

type UniverseWindow = Window & {
  __moshCmdTrace?: Array<{
    command: string;
    args: Record<string, unknown>;
  }>;
};

async function commandCount(page: import("@playwright/test").Page): Promise<number> {
  return page.evaluate(() => (window as UniverseWindow).__moshCmdTrace?.length ?? 0);
}

test("Universe navigates the Edit window without mutating the project", async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await bootProTools(page);

  const toggle = page.getByTestId("pt-universe-toggle");
  const universe = page.getByTestId("pt-universe");
  const timeline = page.getByTestId("pt-timeline");
  const commandsBefore = await commandCount(page);

  await expect(toggle).toHaveAttribute("aria-pressed", "false");
  await expect(universe).toHaveCount(0);
  await toggle.click();
  await expect(toggle).toHaveAttribute("aria-pressed", "true");
  await expect(universe).toBeVisible();
  await expect(page.getByTestId("pt-universe-track")).toHaveCount(3);
  await expect(page.getByTestId("pt-universe-clip")).toHaveCount(3);

  await page.getByTestId("pt-zoom-preset-5").click();
  await expect.poll(() => timeline.evaluate((node) => node.scrollWidth > node.clientWidth)).toBe(true);

  const field = page.getByTestId("pt-universe-field");
  const frame = page.getByTestId("pt-universe-frame");
  const initialFrameLeft = await frame.evaluate((node) => Number.parseFloat(node.style.left));
  const bounds = await field.boundingBox();
  if (!bounds) throw new Error("Universe navigation field bounds are unavailable");
  await page.mouse.click(bounds.x + bounds.width * 0.82, bounds.y + bounds.height * 0.68);
  await expect.poll(() => timeline.evaluate((node) => node.scrollLeft)).toBeGreaterThan(0);
  await expect.poll(() => frame.evaluate((node) => Number.parseFloat(node.style.left)))
    .toBeGreaterThan(initialFrameLeft);

  await field.focus();
  await page.keyboard.press("Home");
  await expect.poll(() => timeline.evaluate((node) => node.scrollLeft)).toBe(0);
  await page.keyboard.press("End");
  await expect.poll(() => timeline.evaluate((node) => node.scrollLeft)).toBeGreaterThan(0);
  await page.keyboard.press("ArrowLeft");
  const pannedLeft = await timeline.evaluate((node) => node.scrollLeft);
  expect(pannedLeft).toBeGreaterThan(0);
  await page.keyboard.press("Home");
  await expect.poll(() => timeline.evaluate((node) => node.scrollLeft)).toBe(0);

  const resizer = page.getByTestId("pt-universe-resizer");
  await resizer.focus();
  await page.keyboard.press("ArrowDown");
  await expect(resizer).toHaveAttribute("aria-valuenow", "80");
  await resizer.dblclick();
  await expect(resizer).toHaveAttribute("aria-valuenow", "72");
  expect(await commandCount(page)).toBe(commandsBefore);

  await page.screenshot({
    path: testInfo.outputPath("protools-universe-wide.png"),
    animations: "disabled",
  });

  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.setViewportSize({ width: 720, height: 720 });
  await toggle.scrollIntoViewIfNeeded();
  await expect(toggle).toBeInViewport();
  await expect(universe).toBeVisible();
  await expect(resizer).toBeVisible();
  const compactBounds = await universe.boundingBox();
  if (!compactBounds) throw new Error("Compact Universe bounds are unavailable");
  expect(compactBounds.x).toBeGreaterThanOrEqual(0);
  expect(compactBounds.x + compactBounds.width).toBeLessThanOrEqual(720);
  await page.screenshot({
    path: testInfo.outputPath("protools-universe-compact.png"),
    animations: "disabled",
  });
});
