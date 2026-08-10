import { expect, test, type Page } from "@playwright/test";
import { bootProTools } from "./helpers";
import type { AutoPoint, Snapshot } from "../src/types";

type TraceEntry = {
  readonly command: string;
  readonly args: Record<string, unknown>;
  readonly ok: boolean;
};

type ProToolsWindow = Window & {
  __moshStore?: {
    getState: () => {
      snapshot: Snapshot | null;
      pxPerSec: number;
      exec: (command: string, args?: Record<string, unknown>) => Promise<unknown>;
    };
  };
  __moshCmdTrace?: TraceEntry[];
};

async function execInPage(page: Page, command: string, args: Record<string, unknown>): Promise<void> {
  await page.evaluate(async ({ name, payload }) => {
    const store = (window as ProToolsWindow).__moshStore;
    if (!store) throw new Error("__moshStore is unavailable");
    await store.getState().exec(name, payload);
  }, { name: command, payload: args });
}

async function automationPoints(page: Page, trackId: string): Promise<readonly AutoPoint[]> {
  return page.evaluate((id) => {
    const snapshot = (window as ProToolsWindow).__moshStore?.getState().snapshot;
    const track = snapshot?.tracks.find((candidate) => candidate.id === id);
    return track?.mixerPlugins?.[0].params[0].points ?? [];
  }, trackId);
}

test("Avid V07 automation selection, trim, nudge, move, and delete remain command-routed", async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await bootProTools(page);
  const trackId = await page.getByTestId("pt-track-header").first().getAttribute("data-track-id");
  if (!trackId) throw new Error("automation track id is absent");

  for (const [time, value] of [[1, 0.2], [3, 0.7], [5, 0.4]]) {
    await execInPage(page, "add_automation_point", {
      trackId, pluginIndex: 100, paramIndex: 0, time, value,
    });
  }

  const lane = page.locator(`[data-testid="protools-automation-lane"][data-track-id="${trackId}"]`);
  await expect(lane).toBeVisible();
  await expect(page.locator(".pt-automation-point")).toHaveCount(3);
  const pxPerSec = await page.evaluate(() =>
    (window as ProToolsWindow).__moshStore?.getState().pxPerSec ?? 0);
  const bounds = await lane.boundingBox();
  if (!bounds || pxPerSec <= 0) throw new Error("automation lane geometry is unavailable");

  // Before → during → after: the lower Smart Tool band leaves a persistent selection.
  await page.mouse.move(bounds.x + pxPerSec * 0.5, bounds.y + 20);
  await page.mouse.down();
  await page.mouse.move(bounds.x + pxPerSec * 3.5, bounds.y + 20, { steps: 8 });
  await page.mouse.up();
  await expect(page.getByTestId("pt-automation-selection")).toBeVisible();
  await expect(page.getByTestId("pt-automation-point-0")).toHaveAttribute("data-selected", "true");
  await expect(page.getByTestId("pt-automation-point-1")).toHaveAttribute("data-selected", "true");
  await expect(page.getByTestId("pt-automation-point-2")).toHaveAttribute("data-selected", "false");

  // Numeric Plus nudges the selected nodes by the toolbar's 250 ms value.
  await lane.press("+");
  await expect.poll(() => automationPoints(page, trackId)).toEqual([
    { t: 1.25, v: 0.2 }, { t: 3.25, v: 0.7 }, { t: 5, v: 0.4 },
  ]);

  // The upper band previews the value trim, then commits one whole-curve command.
  await page.mouse.move(bounds.x + pxPerSec * 2, bounds.y + 4);
  await page.mouse.down();
  await page.mouse.move(bounds.x + pxPerSec * 2, bounds.y + 2, { steps: 2 });
  await expect(page.locator(".pt-automation-trim-readout")).toHaveText("+0.10");
  await page.mouse.up();
  await expect.poll(() => automationPoints(page, trackId)).toEqual([
    { t: 1.25, v: 0.3 }, { t: 3.25, v: 0.8 }, { t: 5, v: 0.4 },
  ]);

  // A node drag previews locally and commits only after release.
  const firstPoint = page.getByTestId("pt-automation-point-0");
  const firstBounds = await firstPoint.boundingBox();
  if (!firstBounds) throw new Error("first breakpoint geometry is unavailable");
  await page.mouse.move(firstBounds.x + firstBounds.width / 2, firstBounds.y + firstBounds.height / 2);
  await page.mouse.down();
  await page.mouse.move(firstBounds.x + firstBounds.width / 2 + pxPerSec * 0.5,
    firstBounds.y + firstBounds.height / 2 - 2, { steps: 4 });
  const traceDuringDrag = await page.evaluate(() => (window as ProToolsWindow).__moshCmdTrace ?? []);
  expect(traceDuringDrag.filter((entry) => entry.command === "set_automation_point")).toHaveLength(0);
  await page.mouse.up();
  await expect.poll(() => automationPoints(page, trackId)).toEqual([
    { t: 1.75, v: 0.4 }, { t: 3.25, v: 0.8 }, { t: 5, v: 0.4 },
  ]);

  // Option/Alt-click removes one addressed node.
  await page.keyboard.down("Alt");
  await page.getByTestId("pt-automation-point-1").click();
  await page.keyboard.up("Alt");
  await expect.poll(() => automationPoints(page, trackId)).toEqual([
    { t: 1.75, v: 0.4 }, { t: 5, v: 0.4 },
  ]);

  await page.screenshot({ path: testInfo.outputPath("protools-automation-wide.png") });
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.setViewportSize({ width: 720, height: 720 });
  await expect(lane).toBeInViewport();
  await page.screenshot({ path: testInfo.outputPath("protools-automation-compact.png") });

  const trace = await page.evaluate(() => (window as ProToolsWindow).__moshCmdTrace ?? []);
  expect(trace.filter((entry) => entry.command === "write_automation_curve")).toHaveLength(2);
  expect(trace.filter((entry) => entry.command === "set_automation_point")).toHaveLength(1);
  expect(trace.filter((entry) => entry.command === "remove_automation_point")).toHaveLength(1);
  expect(trace.filter((entry) => !entry.ok)).toEqual([]);
});
