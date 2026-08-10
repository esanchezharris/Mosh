import { expect, test, type Page } from "@playwright/test";
import type { Snapshot } from "../src/types";
import { bootProTools } from "./helpers";

type ProToolsGroupingWindow = Window & {
  __moshStore?: {
    getState: () => { snapshot: Snapshot | null };
  };
  __moshCmdTrace?: Array<{ command: string }>;
};

test("Avid track-group shortcut never creates a hidden Mosh routing group", async ({ page }) => {
  await bootProTools(page);
  const headerCount = await page.getByTestId("pt-track-header").count();

  await page.getByTestId("pt-track-header").first().click();
  const traceLength = await commandTraceLength(page);
  await page.keyboard.press("Meta+G");

  await expect(page.getByTestId("pt-track-header")).toHaveCount(headerCount);
  await expect.poll(() => commandTraceLength(page)).toBe(traceLength);
  await expect.poll(() => groupTrackCount(page)).toBe(0);
});

async function commandTraceLength(page: Page): Promise<number> {
  return page.evaluate(() => (
    (window as ProToolsGroupingWindow).__moshCmdTrace?.length ?? 0
  ));
}

async function groupTrackCount(page: Page): Promise<number> {
  return page.evaluate(() => (
    (window as ProToolsGroupingWindow).__moshStore?.getState().snapshot?.tracks
      .filter((track) => track.isGroup).length ?? 0
  ));
}
