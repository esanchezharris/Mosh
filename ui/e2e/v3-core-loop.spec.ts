import { test, expect } from "@playwright/test";
import { bootV3, clipNum } from "./helpers";

// V3 parity brief §4 — the generic DAW rows of the Pro Tools matrix, mirrored for V3: clip
// navigation opens the shared editor and closes cleanly; keyboard nudge goes through the
// command seam; a compact window keeps every entry point reachable. Pro-Tools-specific idioms
// (Smart Tool, Playlists, Spot mode) are deliberately not ported.

type MoshWindow = Window & { __moshStore?: { getState: () => Record<string, unknown> } };
const storeVal = <T,>(page: Parameters<typeof bootV3>[0], path: string) =>
  page.evaluate((p) => p.split(".").reduce((o: unknown, k) => (o as Record<string, unknown>)?.[k],
    (window as unknown as MoshWindow).__moshStore!.getState()), path) as Promise<T>;

test("a MIDI clip opens the shared editor on double-click, Escape closes it, and track selection reads back", async ({ page }) => {
  await bootV3(page);
  const bass = page.locator('[data-testid="v3-track"]').filter({ hasText: "Bass" });
  await bass.getByTestId("v3-clip").first().dblclick();
  await expect.poll(() => storeVal<string | null>(page, "editingClipId")).not.toBeNull();
  await expect(page.getByTestId("piano-roll")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect.poll(() => storeVal<string | null>(page, "editingClipId")).toBeNull();
  await expect(page.getByTestId("piano-roll")).toHaveCount(0);

  const keys = page.locator('[data-testid="v3-track"]').filter({ hasText: "Keys" });
  await keys.getByRole("button", { name: /^Select track/ }).click();
  await expect.poll(() => storeVal<string | null>(page, "selectedTrackId")).toBe(await keys.getAttribute("data-track-id"));
  await expect.poll(() => storeVal<number>(page, "selection.size")).toBe(0);      // a track select clears the clip selection
  await expect(page.getByTestId("v3-inspector")).toHaveAttribute("data-track-id", (await keys.getAttribute("data-track-id"))!);
});

test("arrow keys nudge the selected clip through move_clip and one undo restores it", async ({ page }) => {
  await bootV3(page);
  const clip = page.locator('[data-testid="v3-track"]').filter({ hasText: "Keys" }).getByTestId("v3-clip").first();
  await clip.click();
  await expect.poll(() => storeVal<number>(page, "selection.size")).toBe(1);
  const start = await clipNum(clip, "data-clip-start");
  await page.keyboard.press("ArrowRight");
  await expect.poll(() => clipNum(clip, "data-clip-start")).toBeGreaterThan(start);   // anti-vacuity: it moved
  await page.keyboard.press("ArrowLeft");
  await expect.poll(() => clipNum(clip, "data-clip-start")).toBeCloseTo(start, 5);
  await page.keyboard.press("ArrowRight");
  await expect.poll(() => clipNum(clip, "data-clip-start")).toBeGreaterThan(start);
  await page.keyboard.press("ControlOrMeta+z");
  await expect.poll(() => clipNum(clip, "data-clip-start")).toBeCloseTo(start, 5);
});

test("a compact 720 px window keeps the rail, the track toolbar, the dock and the inspector reachable", async ({ page }) => {
  await page.setViewportSize({ width: 720, height: 720 });
  await bootV3(page);
  for (const id of ["v3-rail-mixer", "v3-add-audio", "v3-add-midi", "v3-add-drum-beat", "v3-moshi-field", "v3-moshi-send", "v3-mp-trigger", "v3-history"])
    await expect(page.getByTestId(id), id).toBeInViewport();
  const toolbar = page.getByRole("toolbar", { name: "Tracks" });
  const metrics = await toolbar.evaluate((el) => ({ client: el.clientWidth, scroll: el.scrollWidth }));
  expect(metrics.scroll).toBeLessThanOrEqual(metrics.client + 1);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true);   // no page-level horizontal scroll
  await expect(page.getByTestId("v3-inspector")).toBeVisible();
});
