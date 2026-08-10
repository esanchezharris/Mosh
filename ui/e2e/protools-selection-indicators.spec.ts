import { expect, test } from "@playwright/test";
import { bootProTools } from "./helpers";

test("Edit Selection counters accept precise Start, End, and Length entry", async ({ page }, testInfo) => {
  // Given a visible Edit selection and Minutes:Seconds as the Main Time Scale.
  await page.setViewportSize({ width: 1440, height: 900 });
  await bootProTools(page);
  const ruler = page.locator('[data-ruler="barsBeats"]');
  const bounds = await ruler.boundingBox();
  if (!bounds) throw new Error("Bars+Beats ruler bounds are unavailable");
  const y = bounds.y + bounds.height / 2;
  await page.mouse.move(bounds.x + 160, y);
  await page.mouse.down();
  await page.mouse.move(bounds.x + 560, y, { steps: 4 });
  await page.mouse.up();
  await page.getByLabel("Main time scale").selectOption("minutesSeconds");
  const start = page.getByLabel("Edit Selection Start");
  const end = page.getByLabel("Edit Selection End");
  const length = page.getByLabel("Edit Selection Length");

  // When Slash activates Start and cycles to End using the Pro Tools numeric-entry flow.
  await page.locator(".pt-timeline-scroll").focus();
  await page.keyboard.press("/");
  await expect(start).toBeFocused();
  await start.fill("00:03.000");
  await start.press("/");
  await expect(end).toBeFocused();
  await end.fill("00:06.000");
  await end.press("Enter");

  // Then the accepted range and subsequent Length edit stay synchronized.
  await expect(start).toHaveValue("00:03.000");
  await expect(end).toHaveValue("00:06.000");
  await expect(length).toHaveValue("00:03.000");
  const beforeLength = await page.getByTestId("pt-ruler-selection").boundingBox();
  if (!beforeLength) throw new Error("Typed Edit selection bounds are unavailable");
  await length.fill("00:02.000");
  await length.press("Enter");
  await expect(end).toHaveValue("00:05.000");
  const afterLength = await page.getByTestId("pt-ruler-selection").boundingBox();
  if (!afterLength) throw new Error("Length-adjusted Edit selection bounds are unavailable");
  expect(afterLength.width).toBeLessThan(beforeLength.width);
  await page.screenshot({
    path: testInfo.outputPath("protools-selection-indicators-wide.png"),
    animations: "disabled",
  });

  // And the same fields remain reachable in the compact scrolling toolbar.
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.setViewportSize({ width: 720, height: 720 });
  await start.scrollIntoViewIfNeeded();
  await expect(start).toBeVisible();
  await page.screenshot({
    path: testInfo.outputPath("protools-selection-indicators-compact.png"),
    animations: "disabled",
  });
});
