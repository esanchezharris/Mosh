import { expect, test, type Page } from "@playwright/test";
import type { Snapshot } from "../src/types";
import { bootProTools } from "./helpers";

type ProToolsGroupingWindow = Window & {
  __moshStore?: {
    getState: () => {
      snapshot: Snapshot | null;
      exec: (command: string, args?: Record<string, unknown>) => Promise<{
        ok: boolean;
        error?: string;
      }>;
    };
  };
  __moshCmdTrace?: Array<{ command: string; args?: Record<string, unknown> }>;
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
  await page.getByTestId("pt-track-group-toggle").click();
  await expect.poll(async () => (await trackGroupDefinitions(page))[0]?.enabled).toBe(false);
  await page.getByTestId("pt-track-group-toggle").click();
  await expect.poll(async () => (await trackGroupDefinitions(page))[0]?.enabled).toBe(true);
  const createdGroupId = (await trackGroupDefinitions(page))[0]?.id;
  if (!createdGroupId) throw new Error("Created Track Group id is unavailable");
  await execInGroupingPage(page, "rename_track_group", {
    groupId: createdGroupId,
    name: "Rhythm Native Rename",
  });
  await expect(page.getByTestId("pt-track-group-row")).toContainText("Rhythm Native Rename");

  const [firstTrack, secondTrack] = await trackMix(page);
  if (!firstTrack || !secondTrack) throw new Error("Track Group fixtures are missing");
  await page.getByTestId("pt-track-group-suspend").click();
  await expect.poll(() => trackGroupsSuspended(page)).toBe(true);
  await page.getByTestId("pt-track-select").first().click();
  await page.getByTestId("pt-track-group-menu").click();
  await page.getByTestId("pt-track-group-modify").click();
  const modifyDialog = page.getByTestId("pt-track-group-modify-dialog");
  await expect(modifyDialog).toBeVisible();
  await expect(page.getByTestId("pt-track-group-modify-name")).toBeFocused();
  await expect(page.getByTestId("pt-track-group-selected")).toHaveText(firstTrack.name);
  await expect(page.getByTestId("pt-track-group-draft")).toContainText(`${firstTrack.name}, ${secondTrack.name}`);
  await page.getByTestId("pt-track-group-replace-selection").click();
  await expect(page.getByTestId("pt-track-group-draft")).toHaveText(firstTrack.name);
  await page.keyboard.press("r");
  await expect(page.getByTestId("pt-track-group-draft")).toHaveText("No tracks in group");
  await expect(page.getByTestId("pt-track-group-apply")).toBeDisabled();
  await page.keyboard.press("a");
  await expect(page.getByTestId("pt-track-group-draft")).toHaveText(firstTrack.name);
  await page.screenshot({
    path: testInfo.outputPath("protools-track-group-modify-wide.png"),
    animations: "disabled",
  });
  await page.getByTestId("pt-track-group-apply").click();
  await expect(modifyDialog).toBeHidden();
  await expect.poll(() => trackGroupMemberIds(page)).toEqual([firstTrack.id]);

  await page.getByTestId("pt-track-select").nth(1).click();
  await page.getByTestId("pt-track-group-menu").click();
  await page.getByTestId("pt-track-group-modify").click();
  await page.getByTestId("pt-track-group-add-selection").click();
  await expect(page.getByTestId("pt-track-group-draft"))
    .toHaveText(`${firstTrack.name}, ${secondTrack.name}`);
  await page.getByTestId("pt-track-group-apply").click();
  await expect.poll(() => trackGroupMemberIds(page)).toEqual([firstTrack.id, secondTrack.id]);
  await page.getByTestId("pt-track-group-suspend").click();
  await expect.poll(() => trackGroupsSuspended(page)).toBe(false);

  await page.getByTestId("pt-track-group-menu").click();
  await page.getByTestId("pt-track-group-modify").click();
  await page.getByTestId("pt-track-group-modify-name").fill("Rhythm Configured");
  await page.getByTestId("pt-track-group-modify-kind").selectOption("mix");
  await page.getByTestId("pt-track-group-tab-attributes").click();
  await page.getByTestId("pt-track-group-attribute-main_volume").uncheck();
  await page.getByTestId("pt-track-group-attribute-record_enable").check();
  await page.screenshot({
    path: testInfo.outputPath("protools-track-group-attributes-wide.png"),
    animations: "disabled",
  });
  await page.getByTestId("pt-track-group-apply").click();
  await expect(modifyDialog).toBeHidden();
  await expect(page.getByTestId("pt-track-group-row")).toContainText("Rhythm Configured");
  await expect.poll(async () => (await trackGroupDefinitions(page))[0]).toMatchObject({
    name: "Rhythm Configured",
    kind: "mix",
    mixAttributes: ["main_mute", "main_pan", "solo", "record_enable"],
  });

  const beforeGroupSelect = await commandTraceLength(page);
  await page.getByTestId("pt-track-group-select").click();
  await expect(page.getByTestId("pt-track-select").first()).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByTestId("pt-track-select").nth(1)).toHaveAttribute("aria-pressed", "true");
  await expect.poll(() => commandTraceLength(page)).toBe(beforeGroupSelect);

  const before = await trackMix(page);
  const volume = page.getByTestId("pt-track-volume");
  await volume.evaluate((element) => {
    if (!(element instanceof HTMLInputElement)) throw new Error("Track volume is not an input");
    const input = element;
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
    setter?.call(input, "-6");
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.dispatchEvent(new Event("change", { bubbles: true }));
  });
  await expect.poll(async () => (await trackMix(page))[0]?.volumeDb).toBe(before[0]?.volumeDb);
  await expect.poll(async () => (await trackMix(page))[1]?.volumeDb).toBe(-6);
  await page.getByTestId("pt-track-mute").first().click();
  await expect.poll(async () => (await trackMix(page)).slice(0, 2).every((track) => track.mute)).toBe(true);

  await page.getByTestId("pt-track-group-menu").click();
  await page.getByTestId("pt-track-group-duplicate").click();
  await expect(page.getByTestId("pt-track-group-modify-name")).toHaveValue("Rhythm Configured Copy");
  await page.getByTestId("pt-track-group-apply").click();
  await expect.poll(() => trackGroupCount(page)).toBe(2);
  const definitions = await trackGroupDefinitions(page);
  expect(definitions[1]).toMatchObject({
    name: "Rhythm Configured Copy",
    kind: "mix",
    mixAttributes: ["main_mute", "main_pan", "solo", "record_enable"],
  });
  expect(definitions[1]?.id).not.toBe(definitions[0]?.id);

  await page.getByTestId("pt-track-group-suspend").click();
  await expect.poll(() => trackGroupsSuspended(page)).toBe(true);
  await page.getByTestId("pt-track-select").first().click();
  await expect(page.getByTestId("pt-track-select").first()).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByTestId("pt-track-select").nth(1)).toHaveAttribute("aria-pressed", "false");

  await page.getByTestId("pt-track-group-menu").nth(1).click();
  await page.getByTestId("pt-track-group-remove").click();
  await expect.poll(() => trackGroupCount(page)).toBe(1);

  const commands = await page.evaluate(() => (
    (window as ProToolsGroupingWindow).__moshCmdTrace?.map((entry) => entry.command) ?? []
  ));
  expect(commands).toEqual(expect.arrayContaining([
    "create_track_group",
    "configure_track_group",
    "duplicate_track_group",
    "rename_track_group",
    "set_track_group_enabled",
    "set_track_group_members",
    "remove_track_group",
    "set_track_volume",
    "set_track_mute",
    "set_track_groups_suspended",
  ]));
  expect(commands).not.toContain("create_group_track");
  const membershipCommands = await page.evaluate(() => (
    (window as ProToolsGroupingWindow).__moshCmdTrace
      ?.filter((entry) => entry.command === "set_track_group_members")
      .map((entry) => entry.args?.trackIds) ?? []
  ));
  expect(membershipCommands).toEqual([
    [firstTrack.id],
    [firstTrack.id, secondTrack.id],
  ]);

  await page.screenshot({
    path: testInfo.outputPath("protools-track-groups-wide.png"),
    animations: "disabled",
  });

  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.setViewportSize({ width: 720, height: 720 });
  const panel = page.getByTestId("pt-track-groups");
  await expect(panel).toBeVisible();
  await expect(page.getByTestId("pt-track-group-row").first()).toContainText("Rhythm Configured");
  await expect(page.getByTestId("pt-track-groups-new")).toBeVisible();
  await page.screenshot({
    path: testInfo.outputPath("protools-track-groups-compact.png"),
    animations: "disabled",
  });
  await page.getByTestId("pt-track-group-menu").first().click();
  await page.getByTestId("pt-track-group-modify").click();
  const compactModify = page.getByTestId("pt-track-group-modify-dialog");
  await expect(compactModify).toBeVisible();
  await expect.poll(async () => compactModify.evaluate((element) => {
    const rect = element.getBoundingClientRect();
    return { left: rect.left, right: rect.right, viewport: window.innerWidth };
  })).toEqual({ left: 0, right: 720, viewport: 720 });
  await page.screenshot({
    path: testInfo.outputPath("protools-track-group-modify-compact.png"),
    animations: "disabled",
  });
  await page.keyboard.press("Escape");
  await expect(compactModify).toBeHidden();
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

async function execInGroupingPage(
  page: Page,
  command: string,
  args: Record<string, unknown>,
): Promise<void> {
  const result = await page.evaluate(async ({ commandName, commandArgs }) => {
    const store = (window as ProToolsGroupingWindow).__moshStore;
    if (!store) throw new Error("__moshStore is unavailable");
    return store.getState().exec(commandName, commandArgs);
  }, { commandName: command, commandArgs: args });
  if (!result.ok) throw new Error(result.error ?? `${command} failed`);
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

async function trackGroupMemberIds(page: Page): Promise<readonly string[]> {
  return page.evaluate(() => (
    (window as ProToolsGroupingWindow).__moshStore?.getState().snapshot?.trackGroups?.[0]?.trackIds ?? []
  ));
}

async function trackGroupDefinitions(page: Page): Promise<NonNullable<Snapshot["trackGroups"]>> {
  return page.evaluate(() => (
    (window as ProToolsGroupingWindow).__moshStore?.getState().snapshot?.trackGroups ?? []
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
