import { expect, test } from "@playwright/test";
import { bootProTools } from "./helpers";

type UniverseWindow = Window & {
  __moshCmdTrace?: Array<{
    command: string;
    args: Record<string, unknown>;
  }>;
  __moshStore?: {
    getState: () => {
      exec: (
        command: string,
        args: Record<string, unknown>,
      ) => Promise<{ ok: boolean; error?: string; data?: { trackId?: string } }>;
    };
  };
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

test("Universe scroll controls expose a large session without project mutation", async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await bootProTools(page);
  await page.evaluate(async () => {
    const store = (window as UniverseWindow).__moshStore?.getState();
    if (!store) throw new Error("Mosh store is unavailable");
    for (let index = 4; index <= 15; index += 1) {
      const result = await store.exec("create_track", { name: `Universe ${index}` });
      if (!result.ok) throw new Error(result.error ?? `Track ${index} was not created`);
      const trackId = result.data?.trackId;
      if (trackId && [6, 10, 14].includes(index)) {
        const clip = await store.exec("add_test_tone_clip", {
          trackId,
          start: index - 4,
          seconds: 2,
        });
        if (!clip.ok) throw new Error(clip.error ?? `Track ${index} clip was not created`);
      }
    }
  });
  await expect(page.getByTestId("pt-track-header")).toHaveCount(15);

  await page.getByTestId("pt-universe-toggle").click();
  const rows = page.getByTestId("pt-universe-track");
  const range = page.locator(".pt-universe-label span");
  let up = page.getByTestId("pt-universe-scroll-up");
  let down = page.getByTestId("pt-universe-scroll-down");
  await expect(rows).toHaveCount(10);
  await expect(range).toHaveText("Tracks 1–10 of 15");
  await expect(up).toBeDisabled();
  await expect(down).toBeEnabled();
  const firstTrack = await rows.first().getAttribute("data-track-id");
  const commandsBeforeScroll = await commandCount(page);

  await down.focus();
  await page.keyboard.press("Space");
  await expect(range).toHaveText("Tracks 2–11 of 15");
  await expect(rows.first()).not.toHaveAttribute("data-track-id", firstTrack ?? "");
  await expect(up).toBeEnabled();
  for (let step = 0; step < 4; step += 1) await down.click();
  await expect(range).toHaveText("Tracks 6–15 of 15");
  await expect(down).toBeDisabled();
  await expect(page.getByTestId("pt-universe-clip")).toHaveCount(3);

  const resizer = page.getByTestId("pt-universe-resizer");
  await resizer.focus();
  await page.keyboard.press("End");
  await expect(rows).toHaveCount(15);
  await expect(page.getByTestId("pt-universe-scroll-up")).toHaveCount(0);
  await page.keyboard.press("Home");
  await expect(rows).toHaveCount(5);
  await expect(page.getByTestId("pt-universe-scroll-down")).toBeVisible();
  await resizer.dblclick();
  await expect(rows).toHaveCount(10);

  up = page.getByTestId("pt-universe-scroll-up");
  down = page.getByTestId("pt-universe-scroll-down");
  for (let step = 0; step < 5; step += 1) await down.click();
  const field = page.getByTestId("pt-universe-field");
  const fieldBounds = await field.boundingBox();
  if (!fieldBounds) throw new Error("Large-session Universe bounds are unavailable");
  await page.mouse.click(
    fieldBounds.x + fieldBounds.width * 0.3,
    fieldBounds.y + fieldBounds.height * 0.5,
  );
  await expect.poll(() => page.getByTestId("pt-timeline").evaluate((node) => node.scrollTop))
    .toBeGreaterThan(0);
  await expect(page.getByTestId("pt-universe-frame")).toHaveAttribute("data-visible", "true");
  expect(await commandCount(page)).toBe(commandsBeforeScroll);
  await page.screenshot({
    path: testInfo.outputPath("protools-universe-scroll-wide.png"),
    animations: "disabled",
  });

  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.setViewportSize({ width: 720, height: 720 });
  await page.getByTestId("pt-universe-toggle").scrollIntoViewIfNeeded();
  const upBounds = await up.boundingBox();
  const downBounds = await down.boundingBox();
  if (!upBounds || !downBounds) throw new Error("Compact Universe scroll controls are unavailable");
  expect(upBounds.width).toBeGreaterThanOrEqual(24);
  expect(upBounds.height).toBeGreaterThanOrEqual(24);
  expect(downBounds.width).toBeGreaterThanOrEqual(24);
  expect(downBounds.height).toBeGreaterThanOrEqual(24);
  await expect(range).toHaveText("Tracks 6–15 of 15");
  await page.screenshot({
    path: testInfo.outputPath("protools-universe-scroll-compact.png"),
    animations: "disabled",
  });
  expect(await commandCount(page)).toBe(commandsBeforeScroll);
});
