import { expect, test, type Page } from "@playwright/test";
import type { Snapshot } from "../src/types";
import { bootProTools } from "./helpers";

type ProToolsWindow = Window & {
  __moshStore?: {
    getState: () => {
      snapshot: Snapshot | null;
      exec: (command: string, args?: Record<string, unknown>) => Promise<unknown>;
    };
  };
  __moshCmdTrace?: Array<{
    command: string;
    args: Record<string, unknown>;
    ok: boolean;
  }>;
};

async function execInPage(page: Page, command: string, args: Record<string, unknown>): Promise<void> {
  await page.evaluate(async ({ name, payload }) => {
    const store = (window as ProToolsWindow).__moshStore;
    if (!store) throw new Error("__moshStore is unavailable");
    await store.getState().exec(name, payload);
  }, { name: command, payload: args });
}

async function toggleMainWindow(page: Page): Promise<void> {
  const modifier = process.platform === "darwin" ? "Meta" : "Control";
  await page.keyboard.down(modifier);
  await page.keyboard.press("=");
  await page.keyboard.up(modifier);
}

test("tutorial-backed Mix Window exposes real channel strips and the Edit/Mix workflow", async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await bootProTools(page);
  const trackId = await page.evaluate(() => {
    const snapshot = (window as ProToolsWindow).__moshStore?.getState().snapshot;
    if (!snapshot?.tracks[0]) throw new Error("seed track is unavailable");
    return snapshot.tracks[0].id;
  });

  for (const name of ["Lead Vocal", "Double", "Guitar", "Keys Print", "FX Print"])
    await execInPage(page, "create_track", { name, type: "audio" });
  await execInPage(page, "create_bus", { name: "Vocal Verb" });
  await execInPage(page, "load_builtin", { trackId, type: "compressor" });

  const editHeaders = page.getByTestId("pt-track-header");
  const additiveModifier = process.platform === "darwin" ? "Meta" : "Control";
  await editHeaders.nth(0).getByTestId("pt-track-select").click();
  await editHeaders.nth(1).getByTestId("pt-track-select").click({ modifiers: [additiveModifier] });

  await page.getByTestId("pt-window-mix").click();
  const shell = page.getByTestId("protools-shell");
  const mix = page.getByTestId("pt-mix-window");
  const strips = page.getByTestId("pt-mix-strip");
  const first = strips.first();
  await expect(shell).toHaveAttribute("data-main-window", "mix");
  await expect(mix).toBeVisible();
  await expect(page.getByTestId("pt-timeline")).toHaveCount(0);
  await expect(strips).toHaveCount(9);
  await expect(strips.nth(0)).toHaveAttribute("data-selected", "true");
  await expect(strips.nth(1)).toHaveAttribute("data-selected", "true");
  await expect(page.getByTestId("pt-mix-master-meter")).toBeVisible();
  await expect(first.getByTestId("pt-mix-volume")).toHaveAccessibleName("Volume for Drums");
  await expect(first.getByTestId("pt-mix-input")).toHaveAccessibleName("Input source for Drums");
  await expect(first.getByTestId("pt-mix-output")).toHaveAccessibleName("Output destination for Drums");
  await expect(first.getByTestId("pt-mix-mute")).toHaveAccessibleName("Mute Drums");
  await expect(page.getByTestId("pt-mix-master-meter")).toHaveAccessibleName("Master live stereo level");
  const master = page.getByTestId("pt-mix-master-strip");
  await expect(master).toHaveAccessibleName("Master channel strip");
  await expect(master.getByTestId("pt-mix-master-volume")).toHaveAccessibleName("Volume for Master");
  await expect(master.getByTestId("pt-mix-master-pan")).toHaveAccessibleName("Pan for Master");

  const ordered = await Promise.all([
    first.getByTestId("pt-mix-inserts").boundingBox(),
    first.getByTestId("pt-mix-sends").boundingBox(),
    first.getByTestId("pt-mix-input").boundingBox(),
    first.getByTestId("pt-mix-automation").boundingBox(),
    first.getByTestId("pt-mix-pan").boundingBox(),
    first.getByTestId("pt-mix-mute").boundingBox(),
    first.locator(".pt-mix-meter-fader").boundingBox(),
    first.locator(".pt-mix-track-name").boundingBox(),
  ]);
  if (ordered.some((box) => box === null)) throw new Error("channel-strip hierarchy bounds are missing");
  const y = ordered.map((box) => box!.y);
  expect(y).toEqual([...y].sort((left, right) => left - right));

  await first.getByTestId("pt-mix-input").selectOption("in-3-4");
  await first.getByTestId("pt-mix-output").selectOption("dev:out-3-4");
  await first.getByTestId("pt-mix-automation").selectOption("write");
  await first.getByTestId("pt-mix-pan").fill("-0.35");
  await first.getByTestId("pt-mix-volume").fill("-9");
  await first.getByTestId("pt-mix-mute").click();
  await first.getByTestId("pt-mix-add-send").selectOption("0");
  await first.getByTestId("pt-mix-send-level-0").fill("-8");
  await first.getByTestId("pt-mix-insert-open-0").click();
  await first.getByTestId("pt-mix-insert-bypass-0").click();

  await page.keyboard.down("Alt");
  await page.keyboard.down("Shift");
  await first.getByTestId("pt-mix-volume").fill("-5");
  await page.keyboard.up("Shift");
  await page.keyboard.up("Alt");

  await page.keyboard.down("Alt");
  await first.getByTestId("pt-mix-automation").selectOption("touch");
  await first.getByTestId("pt-mix-add-insert").click();
  await page.keyboard.up("Alt");
  await page.getByTestId("plugin-browser-search").fill("Delay");
  await page.getByTitle("Add Delay to 9 channel strips").click();

  await master.getByTestId("pt-mix-master-volume").fill("-2.5");
  await master.getByTestId("pt-mix-master-pan").fill("0.15");
  await master.getByTestId("pt-mix-master-add-insert").click();
  await page.getByTestId("plugin-browser-search").fill("Compressor");
  await page.getByTitle("Add Compressor to the master bus").click();
  await expect(master.getByTestId("pt-mix-master-inserts")).toContainText("Compressor");
  await master.getByTestId("pt-mix-master-insert-open-0").click();
  await master.getByTestId("pt-mix-master-insert-bypass-0").click();

  await expect.poll(() => page.evaluate((id) => {
    const track = (window as ProToolsWindow).__moshStore?.getState().snapshot?.tracks
      .find((candidate) => candidate.id === id);
    return {
      input: track?.input?.deviceID,
      output: track?.output?.deviceID,
      automation: track?.automationMode,
      pan: track?.pan,
      volume: track?.volumeDb,
      mute: track?.mute,
      send: track?.sends?.[0]?.db,
      insertEnabled: track?.plugins?.[0]?.enabled,
    };
  }, trackId)).toEqual({
    input: "in-3-4",
    output: "out-3-4",
    automation: "touch",
    pan: -0.35,
    volume: -5,
    mute: true,
    send: -8,
    insertEnabled: false,
  });
  await expect.poll(() => page.evaluate(() => {
    const tracks = (window as ProToolsWindow).__moshStore?.getState().snapshot?.tracks ?? [];
    const compatible = tracks.filter((track) => !track.isGroup);
    return {
      selectedVolumes: tracks.slice(0, 2).map((track) => track.volumeDb),
      allAutomation: compatible.every((track) => track.automationMode === "touch"),
      delayTargets: compatible.filter((track) => track.plugins?.some((plugin) => plugin.name === "Delay")).length,
      compatible: compatible.length,
    };
  })).toEqual({ selectedVolumes: [-5, -5], allAutomation: true, delayTargets: 9, compatible: 9 });
  await expect.poll(() => page.evaluate(() => {
    const masterState = (window as ProToolsWindow).__moshStore?.getState().snapshot?.master;
    return {
      volume: masterState?.volumeDb,
      pan: masterState?.pan,
      plugin: masterState?.plugins?.[0]?.name,
      enabled: masterState?.plugins?.[0]?.enabled,
    };
  })).toEqual({ volume: -2.5, pan: 0.15, plugin: "Compressor", enabled: false });

  await page.screenshot({ path: testInfo.outputPath("protools-mix-window-wide.png"), animations: "disabled" });

  await toggleMainWindow(page);
  await expect(shell).toHaveAttribute("data-main-window", "edit");
  await expect(page.getByTestId("pt-timeline")).toBeVisible();
  await expect(page.getByTestId("pt-mix-window")).toHaveCount(0);
  await toggleMainWindow(page);
  await expect(shell).toHaveAttribute("data-main-window", "mix");

  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.setViewportSize({ width: 720, height: 720 });
  const overflow = await page.getByTestId("pt-mix-window").evaluate((element) => ({
    clientWidth: element.clientWidth,
    scrollWidth: element.scrollWidth,
  }));
  expect(overflow.scrollWidth).toBeGreaterThan(overflow.clientWidth);
  await page.getByTestId("pt-mix-master-meter").scrollIntoViewIfNeeded();
  await expect(page.getByTestId("pt-mix-master-meter")).toBeInViewport();
  await page.screenshot({ path: testInfo.outputPath("protools-mix-window-compact.png"), animations: "disabled" });

  const trace = await page.evaluate(() => (window as ProToolsWindow).__moshCmdTrace ?? []);
  for (const command of [
    "set_track_input",
    "set_track_output",
    "set_track_automation_mode",
    "set_track_pan",
    "set_track_volume",
    "set_track_mute",
    "add_send",
    "set_send_level",
    "open_plugin_editor",
    "bypass_plugin",
    "set_master_volume",
    "set_master_pan",
    "load_master_builtin",
    "open_master_plugin_editor",
    "bypass_master_plugin",
  ]) expect(trace.map((entry) => entry.command)).toContain(command);
  expect(trace.filter((entry) => entry.command === "set_track_volume" && entry.args.db === -5)).toHaveLength(2);
  expect(trace.filter((entry) => entry.command === "set_track_automation_mode" && entry.args.mode === "touch"))
    .toHaveLength(9);
  expect(trace.filter((entry) => entry.command === "load_builtin" && entry.args.type === "delay"))
    .toHaveLength(9);
  expect(trace.filter((entry) => !entry.ok)).toEqual([]);
});
