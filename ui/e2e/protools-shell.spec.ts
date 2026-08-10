import { expect, test, type Page } from "@playwright/test";
import { bootProTools } from "./helpers";
import type { Snapshot } from "../src/types";

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

async function storeVal<T>(page: Page, path: string): Promise<T> {
  return page.evaluate(
    (value) => value.split(".").reduce(
      (object: unknown, key) => (object as Record<string, unknown>)?.[key],
      (window as unknown as { __moshStore: { getState: () => unknown } }).__moshStore.getState(),
    ),
    path,
  ) as Promise<T>;
}

async function clipStart(page: Page, clipId: string): Promise<number> {
  return page.evaluate((id) => {
    const snapshot = (window as ProToolsWindow).__moshStore?.getState().snapshot;
    if (!snapshot) throw new Error("__moshStore snapshot is unavailable");
    const clip = snapshot.tracks.flatMap((track) => track.clips)
      .find((candidate) => candidate.id === id);
    if (!clip) throw new Error(`clip ${id} is absent`);
    return clip.start;
  }, clipId);
}

async function sessionAction(page: Page, id: string): Promise<void> {
  await page.getByTestId("pt-session-menu").click();
  await page.locator(`[data-pt-session-action="${id}"]`).locator("..").click();
}

async function execInPage(page: Page, command: string, args: Record<string, unknown> = {}): Promise<void> {
  await page.evaluate(async ({ name, payload }) => {
    const store = (window as ProToolsWindow).__moshStore;
    if (!store) throw new Error("__moshStore is unavailable");
    await store.getState().exec(name, payload);
  }, { name: command, payload: args });
}

test("?shell=protools boots the Edit Window zones with left track headers", async ({ page }) => {
  await bootProTools(page);
  await expect(page.getByTestId("pt-toolbar")).toBeVisible();
  await expect(page.getByTestId("pt-track-list")).toBeVisible();
  await expect(page.getByTestId("pt-clip-list")).toBeVisible();
  await expect(page.getByTestId("pt-status-bar")).toBeVisible();
  await expect(page.getByTestId("live-browser")).toHaveCount(0);
  await expect(page.getByTestId("pt-track-header")).toHaveCount(3);
  await expect(page.getByTestId("pt-lane")).toHaveCount(3);
  await expect(page.locator("[data-ruler]")).toHaveCount(4);

  const header = await page.getByTestId("pt-track-header").first().boundingBox();
  const lane = await page.getByTestId("pt-lane").first().boundingBox();
  if (!header || !lane) throw new Error("Edit Window bounds are missing");
  expect(header.x).toBeLessThan(lane.x);
  expect(Math.abs(header.y - lane.y)).toBeLessThanOrEqual(2);

  // Broad envelopes derived from uncropped V01 Edit Window frames keep the
  // hierarchy recognizable without treating compressed tutorial pixels as art.
  const viewport = page.viewportSize();
  const toolbar = await page.getByTestId("pt-toolbar").boundingBox();
  const rulers = await page.getByRole("region", { name: "Timeline rulers" }).boundingBox();
  const trackList = await page.getByTestId("pt-track-list").boundingBox();
  const clipList = await page.getByTestId("pt-clip-list").boundingBox();
  if (!viewport || !toolbar || !rulers || !trackList || !clipList) {
    throw new Error("Edit Window parity-zone bounds are missing");
  }
  expect(toolbar.height / viewport.height).toBeGreaterThan(0.05);
  expect(toolbar.height / viewport.height).toBeLessThan(0.13);
  expect(rulers.height / viewport.height).toBeGreaterThan(0.05);
  expect(rulers.height / viewport.height).toBeLessThan(0.12);
  expect(trackList.width / viewport.width).toBeGreaterThan(0.07);
  expect(trackList.width / viewport.width).toBeLessThan(0.16);
  expect(clipList.width / viewport.width).toBeGreaterThan(0.09);
  expect(clipList.width / viewport.width).toBeLessThan(0.18);
});

test("mode, tool, Smart Tool, and resizable headers are keyboard operable", async ({ page }) => {
  await bootProTools(page);
  const shell = page.getByTestId("protools-shell");

  const editModes = [
    ["F1", "shuffle"],
    ["F2", "slip"],
    ["F3", "spot"],
    ["F4", "grid"],
  ] as const;
  for (const [key, mode] of editModes) {
    await page.keyboard.press(key);
    await expect(shell).toHaveAttribute("data-edit-mode", mode);
  }

  await expect(page.getByTestId("pt-smart-tool")).toHaveAttribute("aria-pressed", "true");

  const editTools = [
    ["F5", "Zoomer"],
    ["F6", "Trimmer"],
    ["F7", "Selector"],
    ["F8", "Grabber"],
    ["F9", "Scrubber"],
    ["F10", "Pencil"],
  ] as const;
  for (const [key, tool] of editTools) {
    await page.keyboard.press(key);
    await expect(page.getByTestId("pt-smart-tool")).toHaveAttribute("aria-pressed", "false");
    await expect(page.getByRole("button", { name: tool, exact: true })).toHaveAttribute("aria-pressed", "true");
  }

  const resizer = page.getByTestId("pt-track-head-resizer");
  await resizer.focus();
  const before = Number(await resizer.getAttribute("aria-valuenow"));
  await resizer.press("ArrowRight");
  await expect(resizer).toHaveAttribute("aria-valuenow", String(before + 8));
});

test("Spot mode opens a keyboard modal and moves the clip through the command seam", async ({ page }, testInfo) => {
  // Given: the Pro Tools shell is in Spot mode with a rendered clip focused.
  await page.setViewportSize({ width: 1440, height: 900 });
  await bootProTools(page);
  await page.keyboard.press("F3");
  const clip = page.getByTestId("pt-lane").first().getByTestId("v2-clip").first();
  const clipId = await clip.getAttribute("data-clip-id");
  if (!clipId) throw new Error("Spot clip id is absent");
  await clip.focus();

  // When: Enter activates the focused clip's Grabber placement path.
  await page.keyboard.press("Enter");

  // Then: a true fixed modal opens with Start focused.
  const backdrop = page.getByTestId("pt-spot-backdrop");
  const dialog = page.getByTestId("pt-spot-dialog");
  const start = page.getByTestId("pt-spot-start");
  await expect(dialog).toBeVisible();
  await expect(backdrop).toHaveCSS("position", "fixed");
  await expect(start).toBeFocused();
  await page.screenshot({ path: testInfo.outputPath("protools-spot-dialog-wide.png") });

  // And: the same modal remains contained at the compact shell breakpoint.
  await page.setViewportSize({ width: 720, height: 720 });
  await expect(dialog).toBeInViewport();
  await page.screenshot({ path: testInfo.outputPath("protools-spot-dialog-compact.png") });

  // When: a precise destination is confirmed.
  await start.fill("00:06.000");
  await dialog.getByRole("button", { name: "Spot", exact: true }).click();

  // Then: the backend snapshot reflects the move and focus returns to the clip.
  await expect(dialog).toHaveCount(0);
  await expect.poll(() => clipStart(page, clipId)).toBeCloseTo(6, 5);
  await expect(clip).toBeFocused();
});

test("clip navigation opens the shared editor and track selection closes it", async ({ page }) => {
  await bootProTools(page);
  const midiEntry = page.getByTestId("pt-clip-list-item").filter({ hasText: "MIDI" }).first();
  await midiEntry.click();
  await expect.poll(() => storeVal<string | null>(page, "editingClipId")).not.toBeNull();
  await expect(page.getByTestId("pt-detail-dock")).toBeVisible();
  await expect(page.locator(".protools-shell .pr.docked")).toBeVisible();

  await page.getByTestId("pt-track-select").first().click();
  await expect.poll(() => storeVal<string | null>(page, "editingClipId")).toBeNull();
  await expect(page.getByTestId("pt-detail-dock")).toBeVisible();
  await expect(page.getByTestId("pt-device-rack")).toBeVisible();
  await expect(page.getByTestId("pt-device-rack")).toContainText("Drums");
});

test("Tab navigates and Cmd/Ctrl plus nudges through the command seam", async ({ page }) => {
  await bootProTools(page);
  const clip = page.getByTestId("pt-lane").first().getByTestId("v2-clip").first();
  await clip.click();
  await expect.poll(() => storeVal<number>(page, "selection.size")).toBe(1);
  const clipId = await clip.getAttribute("data-clip-id");
  if (!clipId) throw new Error("selected clip id is absent");
  const start = await clipStart(page, clipId);
  await page.keyboard.press(process.platform === "darwin" ? "Meta++" : "Control++");
  await expect.poll(() => clipStart(page, clipId)).toBeCloseTo(start + 0.25, 5);

  const positionBefore = await storeVal<number>(page, "transport.position");
  await page.keyboard.press("Tab");
  await expect.poll(() => storeVal<number>(page, "transport.position")).toBeGreaterThan(positionBefore);
});

test("Classic theme and Clip List collapse stay available", async ({ page }) => {
  await bootProTools(page);
  const shell = page.getByTestId("protools-shell");
  await page.getByRole("button", { name: "Classic", exact: true }).click();
  await expect(shell).toHaveAttribute("data-pt-theme", "classic");

  const clipList = page.getByTestId("pt-clip-list");
  await page.getByTestId("pt-clip-list-toggle").click();
  await expect(clipList).toHaveClass(/is-closed/);
  await expect(page.getByTestId("pt-clip-list-item")).toHaveCount(0);
  await page.getByTestId("pt-clip-list-toggle").click();
  await expect(clipList).toHaveClass(/is-open/);
});

test("compact Edit Window keeps collapsed Clip List and overflow controls reachable", async ({ page }) => {
  await page.setViewportSize({ width: 720, height: 720 });
  await page.emulateMedia({ reducedMotion: "reduce" });
  await bootProTools(page);

  const clipList = page.getByTestId("pt-clip-list");
  await expect(clipList).toHaveClass(/is-closed/);
  await expect(page.getByTestId("pt-clip-list-toggle")).toBeVisible();
  await expect(page.getByTestId("pt-clip-list-toggle")).toHaveAttribute("aria-expanded", "false");

  const toolbar = page.getByTestId("pt-toolbar");
  const toolbarMetrics = await toolbar.evaluate((element) => ({
    clientWidth: element.clientWidth,
    scrollWidth: element.scrollWidth,
  }));
  expect(toolbarMetrics.scrollWidth).toBeGreaterThan(toolbarMetrics.clientWidth);
  await expect(toolbar).toHaveCSS("overflow-x", "auto");

  const rulers = page.getByRole("button", { name: "Rulers" });
  await rulers.scrollIntoViewIfNeeded();
  await expect(rulers).toBeInViewport();
  await rulers.click();
  const rulerMenu = page.getByRole("menu", { name: "Visible rulers" });
  await expect(rulerMenu).toBeVisible();
  const samplesRuler = rulerMenu.getByRole("menuitem", { name: "Toggle Samples ruler" });
  await samplesRuler.focus();
  await samplesRuler.press("Enter");
  await expect(page.locator('[data-ruler="samples"]')).toHaveCount(0);

  const interfaceOptions = page.getByRole("button", { name: "Interface options" });
  await interfaceOptions.scrollIntoViewIfNeeded();
  await expect(interfaceOptions).toBeInViewport();
  await interfaceOptions.click();
  await expect(page.getByRole("menu", { name: "Interface options" })).toContainText("Switch to Live (clone)");
  await page.keyboard.press("Escape");

  const settings = page.getByRole("button", { name: "Settings" });
  await settings.scrollIntoViewIfNeeded();
  await expect(settings).toBeInViewport();
  await settings.click();
  const dialog = page.getByTestId("pt-settings-dialog");
  await expect(dialog).toBeVisible();
  const controls = dialog.locator(
    "button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [href], [tabindex]:not([tabindex='-1'])",
  );
  const firstControl = controls.first();
  const lastControl = controls.last();
  await expect(firstControl).toBeFocused();
  await page.keyboard.press("Shift+Tab");
  await expect(lastControl).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(firstControl).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  await expect(settings).toBeFocused();
});

test("audio producer flow records, edits, mixes, inserts, saves, reloads, and undoes Moshi", async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await bootProTools(page);

  await sessionAction(page, "new_project");
  await expect(page.getByTestId("pt-track-header")).toHaveCount(0);

  await page.getByTestId("pt-add-track").click();
  await page.getByTestId("pt-add-track-audio").click();
  await expect(page.getByTestId("pt-track-header")).toHaveCount(1);
  const header = page.getByTestId("pt-track-header").first();
  const trackId = await header.getAttribute("data-track-id");
  if (!trackId) throw new Error("created audio track id is absent");
  await header.getByTestId("pt-track-select").click();
  await expect(page.getByTestId("pt-track-inspector")).toBeVisible();
  const toolbar = page.getByTestId("pt-toolbar");
  const recordButton = toolbar.getByRole("button", { name: "Record", exact: true });

  // Avid's recording tutorial starts with the track explicitly unassigned,
  // disarmed, and in Auto monitoring before the producer chooses physical I/O.
  await expect(page.getByTestId("pt-io-input")).toContainText("No Input");
  await expect(page.getByTestId("pt-io-output")).toContainText("Default output");
  await expect(page.getByTestId("pt-monitor-automatic")).toHaveAttribute("aria-pressed", "true");
  await expect(header.getByTestId("pt-track-arm")).toHaveAttribute("aria-pressed", "false");
  await expect(recordButton).toHaveAttribute("aria-pressed", "false");

  await page.getByTestId("pt-track-name").fill("Tonight Vocal");
  await page.getByTestId("pt-track-name").press("Enter");
  await expect.poll(() => storeVal<string>(page, "snapshot.tracks.0.name")).toBe("Tonight Vocal");

  await page.getByTestId("pt-io-input").click();
  await page.getByTestId("pt-io-input-option").filter({ hasText: "Input 1-2" }).click();
  await expect(page.getByTestId("pt-io-input")).toContainText("Input 1-2");
  await page.getByTestId("pt-io-output").click();
  await page.getByTestId("pt-io-output-option").filter({ hasText: "External Headphones" }).click();
  await expect(page.getByTestId("pt-io-output")).toContainText("External Headphones");
  await page.getByTestId("pt-monitor-on").click();
  await expect(page.getByTestId("pt-monitor-on")).toHaveAttribute("aria-pressed", "true");

  await page.getByTestId("pt-track-volume").fill("-6");
  await page.getByTestId("pt-track-pan").fill("0.25");
  await expect.poll(() => storeVal<number>(page, "snapshot.tracks.0.volumeDb")).toBe(-6);
  await expect.poll(() => storeVal<number>(page, "snapshot.tracks.0.pan")).toBe(0.25);

  await header.getByTestId("pt-track-arm").click();
  await expect(header.getByTestId("pt-track-arm")).toHaveAttribute("aria-pressed", "true");
  await recordButton.click();
  await expect.poll(() => storeVal<boolean>(page, "transport.recording")).toBe(true);
  await expect(recordButton).toHaveAttribute("aria-pressed", "true");
  await expect(header.getByTestId("pt-track-arm")).toHaveAttribute("aria-pressed", "true");
  await toolbar.getByRole("button", { name: "Stop", exact: true }).click();
  await expect.poll(() => storeVal<boolean>(page, "transport.recording")).toBe(false);
  await expect(recordButton).toHaveAttribute("aria-pressed", "false");
  await expect.poll(() => storeVal<number>(page, "snapshot.tracks.0.clips.length")).toBe(1);

  const clipEntry = page.getByTestId("pt-clip-list-item").first();
  await clipEntry.click();
  await expect(page.getByTestId("pt-audio-clip-inspector")).toBeVisible();
  const clipId = await page.getByTestId("pt-lane").first().getByTestId("v2-clip").getAttribute("data-clip-id");
  if (!clipId) throw new Error("recorded clip id is absent");

  await page.keyboard.press("F3");
  const timelineClip = page.getByTestId("pt-lane").first().getByTestId("v2-clip");
  await timelineClip.focus();
  await page.keyboard.press("Enter");
  await page.getByTestId("pt-spot-start").fill("00:01.000");
  await page.getByTestId("pt-spot-dialog").getByRole("button", { name: "Spot", exact: true }).click();
  await expect.poll(() => clipStart(page, clipId)).toBeCloseTo(1, 5);

  await page.getByTestId("pt-clip-name").fill("Tonight Take");
  await page.getByTestId("pt-clip-name").press("Enter");
  await page.getByTestId("pt-clip-gain-number").fill("3.5");
  await page.getByTestId("pt-clip-gain-number").press("Enter");
  await page.getByTestId("pt-clip-mute").click();
  await expect(page.getByTestId("pt-clip-mute")).toHaveAttribute("aria-pressed", "true");
  await page.getByTestId("pt-clip-mute").click();
  await expect.poll(() => storeVal<number>(page, "snapshot.tracks.0.clips.0.gainDb")).toBe(3.5);
  await expect.poll(() => storeVal<string>(page, "snapshot.tracks.0.clips.0.name")).toBe("Tonight Take");
  await expect.poll(() => storeVal<boolean>(page, "snapshot.tracks.0.clips.0.mute")).toBe(false);

  const inlineGain = page.getByTestId("pt-clip-gain-handle");
  await expect(inlineGain).toHaveAttribute("aria-valuenow", "3.5");
  await expect(inlineGain).toHaveAttribute("aria-valuetext", "3.5 dB");
  const waveformScale = await page.getByTestId("pt-audio-clip-stack").evaluate((element) =>
    Number((element as HTMLElement).style.getPropertyValue("--pt-clip-gain-scale")),
  );
  expect(waveformScale).toBeCloseTo(10 ** (3.5 / 20), 8);
  await inlineGain.focus();
  await page.keyboard.press("ArrowDown");
  await expect.poll(() => storeVal<number>(page, "snapshot.tracks.0.clips.0.gainDb")).toBe(3);
  await page.keyboard.press("ArrowUp");
  await expect.poll(() => storeVal<number>(page, "snapshot.tracks.0.clips.0.gainDb")).toBe(3.5);
  await page.screenshot({ path: testInfo.outputPath("protools-tutorial-parity-wide.png") });
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.setViewportSize({ width: 720, height: 720 });
  await expect(page.getByTestId("pt-clip-list")).toHaveClass(/is-closed/);
  await page.screenshot({ path: testInfo.outputPath("protools-tutorial-parity-compact.png") });
  await page.setViewportSize({ width: 1440, height: 900 });

  await header.getByTestId("pt-track-select").click();
  await page.getByTestId("pt-add-insert").click();
  await page.getByTestId("plugin-browser-search").fill("CLA-2A Stereo");
  await page.locator(".prow-load").filter({ hasText: "CLA-2A Stereo" }).click();
  await expect(page.getByTestId("pt-device-rack")).toContainText("CLA-2A Stereo");
  await page.getByTestId("pt-device-open-0").click();
  await page.getByTestId("pt-device-bypass-0").click();
  await expect(page.getByTestId("pt-device-bypass-0")).toHaveAttribute("aria-pressed", "true");
  await page.getByTestId("pt-device-bypass-0").click();
  await expect(page.getByTestId("pt-device-bypass-0")).toHaveAttribute("aria-pressed", "false");

  await sessionAction(page, "save_as");
  await expect.poll(() => storeVal<string>(page, "snapshot.session.editFile"))
    .toBe("/mock/sessions/protools-tonight.mosh");
  await sessionAction(page, "save");
  await sessionAction(page, "export_audio");

  await page.getByTestId("pt-track-volume").fill("-18");
  await expect.poll(() => storeVal<number>(page, "snapshot.tracks.0.volumeDb")).toBe(-18);
  await execInPage(page, "reload");
  await expect.poll(() => storeVal<number>(page, "snapshot.tracks.0.volumeDb")).toBe(-6);
  await expect(page.getByTestId("pt-device-rack")).toContainText("CLA-2A Stereo");

  await sessionAction(page, "new_project");
  await expect(page.getByTestId("pt-track-header")).toHaveCount(0);
  await sessionAction(page, "open_project");
  await expect(page.getByTestId("pt-track-header")).toHaveCount(1);
  await expect.poll(() => storeVal<string>(page, "snapshot.tracks.0.name")).toBe("Tonight Vocal");
  await expect.poll(() => storeVal<number>(page, "snapshot.tracks.0.clips.0.gainDb")).toBe(3.5);

  await page.getByTestId("pt-ask-moshi").click();
  await page.getByTestId("agent-input").fill("mute Tonight Vocal");
  await page.getByTestId("agent-send").click();
  await expect.poll(() => storeVal<boolean>(page, "snapshot.tracks.0.mute")).toBe(true);
  await page.getByTestId("v2-toast-undo").click();
  await expect.poll(() => storeVal<boolean>(page, "snapshot.tracks.0.mute")).toBe(false);

  const trace = await page.evaluate(() => (window as ProToolsWindow).__moshCmdTrace ?? []);
  const commands = trace.map((entry) => entry.command);
  for (const command of [
    "new_project", "create_track", "rename_track", "set_track_input", "set_track_output",
    "set_input_monitor", "arm_track", "stop_recording", "move_clip", "rename_clip",
    "set_clip_gain", "set_clip_mute", "load_plugin", "open_plugin_editor", "bypass_plugin",
    "save_as", "save", "export_audio", "reload", "open_project", "undo",
  ]) expect(commands).toContain(command);
  expect(trace.filter((entry) => !entry.ok)).toEqual([]);
});
