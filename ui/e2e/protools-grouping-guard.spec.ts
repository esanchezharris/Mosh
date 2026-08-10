import { expect, test, type Page } from "@playwright/test";
import type { Snapshot } from "../src/types";
import { bootProTools } from "./helpers";

type ProToolsGroupingWindow = Window & {
  __moshStore?: {
    getState: () => { snapshot: Snapshot | null };
  };
  __moshCmdTrace?: Array<{ command: string }>;
};

test("Avid Edit and Mix Track Groups link selection and controls without changing routing", async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await bootProTools(page);
  const headerCount = await page.getByTestId("pt-track-header").count();

  await page.getByTestId("pt-track-select").first().click();
  await page.getByTestId("pt-track-select").nth(1).click({ modifiers: ["Meta"] });
  const traceLength = await commandTraceLength(page);
  await page.keyboard.press("Meta+G");

  const dialog = page.getByTestId("pt-track-group-dialog");
  await expect(dialog).toBeVisible();
  await expect(page.getByTestId("pt-track-group-name")).toBeFocused();
  await expect(dialog).toHaveCSS("color", "rgb(192, 192, 192)");
  await expect(dialog).toHaveCSS("background-color", "rgb(37, 37, 37)");
  await expect(dialog).toContainText("Link 2 selected tracks");
  await expect(page.getByTestId("pt-track-header")).toHaveCount(headerCount);
  await expect.poll(() => commandTraceLength(page)).toBe(traceLength);
  await expect.poll(() => groupTrackCount(page)).toBe(0);

  await page.getByTestId("pt-track-group-name").fill("Rhythm");
  await page.getByTestId("pt-track-group-kind").selectOption("edit_mix");
  await expect(page.getByTestId("pt-track-group-create")).toHaveCSS("background-color", "rgb(74, 144, 217)");
  await expect(page.getByTestId("pt-track-group-create")).toHaveCSS("color", "rgb(16, 24, 32)");
  await page.screenshot({
    path: testInfo.outputPath("protools-track-group-dialog-wide.png"),
    animations: "disabled",
  });
  await page.getByTestId("pt-track-group-create").click();
  await expect(dialog).toBeHidden();
  await expect(page.getByTestId("pt-track-group-row")).toContainText("Rhythm");
  await expect.poll(() => trackGroupCount(page)).toBe(1);
  await expect.poll(() => groupTrackCount(page)).toBe(0);

  await page.getByTestId("pt-track-select").first().click();
  await expect(page.getByTestId("pt-track-select").first()).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByTestId("pt-track-select").nth(1)).toHaveAttribute("aria-pressed", "true");

  const before = await trackMix(page);
  const volume = page.getByTestId("pt-track-volume");
  await volume.evaluate((element) => {
    const input = element as HTMLInputElement;
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
    setter?.call(input, "-6");
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.dispatchEvent(new Event("change", { bubbles: true }));
  });
  await expect.poll(async () => {
    const mix = await trackMix(page);
    return mix[1]!.volumeDb! - mix[0]!.volumeDb!;
  }).toBeCloseTo(before[1]!.volumeDb! - before[0]!.volumeDb!, 5);
  await page.getByTestId("pt-track-mute").first().click();
  await expect.poll(async () => (await trackMix(page)).slice(0, 2).every((track) => track.mute)).toBe(true);

  await page.getByTestId("pt-track-group-suspend").click();
  await expect.poll(() => trackGroupsSuspended(page)).toBe(true);
  await page.getByTestId("pt-track-select").first().click();
  await expect(page.getByTestId("pt-track-select").first()).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByTestId("pt-track-select").nth(1)).toHaveAttribute("aria-pressed", "false");

  const commands = await page.evaluate(() => (
    (window as ProToolsGroupingWindow).__moshCmdTrace?.map((entry) => entry.command) ?? []
  ));
  expect(commands).toEqual(expect.arrayContaining([
    "create_track_group",
    "set_track_volume",
    "set_track_mute",
    "set_track_groups_suspended",
  ]));
  expect(commands).not.toContain("create_group_track");

  await page.screenshot({
    path: testInfo.outputPath("protools-track-groups-wide.png"),
    animations: "disabled",
  });

  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.setViewportSize({ width: 720, height: 720 });
  const panel = page.getByTestId("pt-track-groups");
  await expect(panel).toBeVisible();
  await expect(page.getByTestId("pt-track-group-row")).toContainText("Rhythm");
  await expect(page.getByTestId("pt-track-groups-new")).toBeVisible();
  await page.screenshot({
    path: testInfo.outputPath("protools-track-groups-compact.png"),
    animations: "disabled",
  });
  await page.getByTestId("pt-track-groups-new").click();
  const compactDialog = page.getByTestId("pt-track-group-dialog");
  await expect(compactDialog).toBeVisible();
  await expect.poll(async () => compactDialog.evaluate((element) => {
    const rect = element.getBoundingClientRect();
    return { left: rect.left, right: rect.right, viewport: window.innerWidth };
  })).toEqual({ left: 0, right: 720, viewport: 720 });
  await page.screenshot({
    path: testInfo.outputPath("protools-track-group-dialog-compact.png"),
    animations: "disabled",
  });
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("pt-track-group-dialog")).toBeHidden();
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

async function trackGroupCount(page: Page): Promise<number> {
  return page.evaluate(() => (
    (window as ProToolsGroupingWindow).__moshStore?.getState().snapshot?.trackGroups?.length ?? 0
  ));
}

async function trackGroupsSuspended(page: Page): Promise<boolean> {
  return page.evaluate(() => Boolean(
    (window as ProToolsGroupingWindow).__moshStore?.getState().snapshot?.trackGroupsSuspended,
  ));
}

async function trackMix(page: Page): Promise<Snapshot["tracks"]> {
  return page.evaluate(() => (
    (window as ProToolsGroupingWindow).__moshStore?.getState().snapshot?.tracks ?? []
  ));
}
