import { test, expect } from "@playwright/test";
import { bootV2, openV2ArrangementTools } from "./helpers";

// The tempo lane — insert_tempo_change / remove_tempo_change reaching the mouse.
//
// Driven through the real gesture (pointer on the lane → inline BPM field → Enter) rather
// than store.exec, because the seam this feature can break is layout: the lane computes its
// insert position from a click x, so a component that dispatches correctly under a spy can
// still put the marker in the wrong place on screen.

test("a tempo change can be created and removed with the mouse", async ({ page }) => {
  await bootV2(page);
  await openV2ArrangementTools(page);
  const lane = page.getByTestId("v2-tempo-lane");
  await expect(lane).toBeVisible();
  // The base tempo renders as an anchor with no remove control — removeTempo() no-ops on
  // index 0 in the engine, so offering one would be a button that can only fail.
  await expect(page.getByTestId("v2-tempo-point")).toHaveCount(1);
  await expect(page.getByTestId("v2-tempo-remove")).toHaveCount(0);

  const box = (await lane.boundingBox())!;
  await page.mouse.move(box.x + 300, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.up();

  const input = page.getByTestId("v2-tempo-input");
  await expect(input).toBeVisible();
  await input.fill("180");
  await input.press("Enter");

  await expect(page.getByTestId("v2-tempo-point")).toHaveCount(2);
  const added = page.getByTestId("v2-tempo-point").nth(1);
  await expect(added).toHaveAttribute("data-bpm", "180");
  // Snapped to a bar, not left on the raw click position.
  const t = Number(await added.getAttribute("data-time"));
  expect(Number.isInteger(t / 2), `tempo change landed off-grid at ${t}s`).toBe(true);

  await added.getByTestId("v2-tempo-remove").click();
  await expect(page.getByTestId("v2-tempo-point")).toHaveCount(1);
});

test("the lane grid re-spaces across a tempo change instead of drifting from the ruler", async ({ page }) => {
  // The dormant bug this feature would otherwise expose: lane stripes are a CSS
  // repeating-linear-gradient, which has ONE period and cannot represent an uneven grid.
  // Once a tempo change exists the lane must switch to real positioned lines.
  await bootV2(page);
  await openV2ArrangementTools(page);
  await expect(page.locator(".v2-lane-mapped")).toHaveCount(0); // flat project keeps the gradient

  const lane = page.getByTestId("v2-tempo-lane");
  const box = (await lane.boundingBox())!;
  await page.mouse.move(box.x + 300, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.up();
  await page.getByTestId("v2-tempo-input").fill("240");
  await page.getByTestId("v2-tempo-input").press("Enter");

  await expect(page.locator(".v2-lane-mapped").first()).toBeVisible();
  const changeAt = Number(await page.getByTestId("v2-tempo-point").nth(1).getAttribute("data-time"));

  const lefts = await page.locator(".v2-lane-mapped").first().locator(".v2-gl.bar")
    .evaluateAll((els) => els.map((e) => parseFloat((e as HTMLElement).style.left)));
  const pxPerSec = Number(await page.getByTestId("v2-tempo-point").nth(1)
    .evaluate((e) => parseFloat((e as HTMLElement).style.left))) / changeAt;

  const gapsBefore = lefts.filter((x) => x <= changeAt * pxPerSec).slice(-3);
  const gapsAfter = lefts.filter((x) => x >= changeAt * pxPerSec).slice(0, 3);
  const span = (a: number[]) => a[1] - a[0];
  // 240bpm bars are half the length of 120bpm bars. Asserting the RATIO rather than pixels
  // keeps this independent of the zoom level the shell happens to boot at.
  expect(span(gapsAfter) / span(gapsBefore)).toBeCloseTo(0.5, 1);
});
