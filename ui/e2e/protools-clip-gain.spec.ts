import { expect, test, type Page } from "@playwright/test";
import { bootProTools } from "./helpers";
import type { ClipGainPoint, Snapshot } from "../src/types";

type ProToolsWindow = Window & {
  __moshStore?: { getState: () => { snapshot: Snapshot | null } };
};

async function gainPoints(page: Page, clipId: string): Promise<ClipGainPoint[]> {
  return page.evaluate((id) => {
    const snapshot = (window as ProToolsWindow).__moshStore?.getState().snapshot;
    const clip = snapshot?.tracks.flatMap((track) => track.clips)
      .find((candidate) => candidate.id === id);
    return clip?.clipGainPoints ?? [];
  }, clipId);
}

test("Avid V06 clip gain line adds, rides, nudges, and clears clip-local breakpoints", async ({ page }) => {
  await bootProTools(page);
  const clip = page.locator('[data-testid="v2-clip"].wave').first();
  await clip.focus();
  await clip.press("Enter");
  await expect(clip).toHaveAttribute("aria-pressed", "true");
  const clipId = await clip.getAttribute("data-clip-id");
  if (!clipId) throw new Error("audio clip id is missing");

  const envelope = page.getByTestId("pt-clip-gain-envelope").first();
  const bounds = await envelope.boundingBox();
  if (!bounds) throw new Error("clip gain envelope has no Chromium bounds");
  await page.mouse.click(bounds.x + bounds.width / 2, bounds.y + bounds.height / 3);
  await expect.poll(() => gainPoints(page, clipId)).toHaveLength(1);

  const point = page.getByTestId("pt-clip-gain-point").first();
  await expect(point).toBeVisible();
  await point.focus();
  await point.press("ArrowUp");
  await expect.poll(async () => (await gainPoints(page, clipId))[0]?.gainDb).toBe(0.5);

  const pointBounds = await point.boundingBox();
  if (!pointBounds) throw new Error("clip gain breakpoint has no Chromium bounds");
  await page.mouse.move(pointBounds.x + pointBounds.width / 2, pointBounds.y + pointBounds.height / 2);
  await page.mouse.down();
  await page.mouse.move(pointBounds.x + pointBounds.width / 2 + 40,
    pointBounds.y + pointBounds.height / 2 - 16, { steps: 4 });
  await page.mouse.up();
  await expect.poll(async () => (await gainPoints(page, clipId))[0]?.gainDb).toBeGreaterThan(0.5);
  await expect.poll(async () => (await gainPoints(page, clipId))[0]?.t).toBeGreaterThan(0);

  await point.focus();
  await point.press("Delete");
  await expect.poll(() => gainPoints(page, clipId)).toEqual([]);
  await expect(page.getByTestId("pt-clip-gain-point")).toHaveCount(0);
});
