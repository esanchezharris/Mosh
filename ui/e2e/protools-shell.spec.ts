import { expect, test, type Locator, type Page } from "@playwright/test";
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
  __moshShellStore?: {
    getState: () => { timeRange: { start: number; end: number } | null };
  };
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

async function canvasInkHeight(canvas: Locator): Promise<number> {
  return canvas.evaluate((element) => {
    if (!(element instanceof HTMLCanvasElement)) throw new Error("clip canvas is unavailable");
    const context = element.getContext("2d", { willReadFrequently: true });
    if (!context || element.width <= 0 || element.height <= 0) return 0;
    const pixels = context.getImageData(0, 0, element.width, element.height).data;
    let first = element.height;
    let last = -1;
    for (let y = 0; y < element.height; y += 1) {
      for (let x = 0; x < element.width; x += 1) {
        if (pixels[(y * element.width + x) * 4 + 3] <= 8) continue;
        first = Math.min(first, y);
        last = Math.max(last, y);
        break;
      }
    }
    return last < first ? 0 : last - first + 1;
  });
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
  await expect(page.locator("[data-ruler]")).toHaveCount(5);

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

test("tutorial-backed Memory Locations persist markers and recall the timeline", async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await bootProTools(page);
  await execInPage(page, "set_transport", { position: 3 });

  await page.getByTestId("pt-memory-toggle").click();
  const memoryWindow = page.getByTestId("pt-memory-locations");
  await expect(memoryWindow).toBeVisible();
  await page.getByTestId("pt-memory-add").click();
  const dialog = page.getByTestId("pt-memory-dialog");
  await expect(dialog).toBeVisible();
  await expect(page.getByTestId("pt-memory-name")).toBeFocused();
  await page.getByTestId("pt-memory-name").fill("Verse In");
  await page.locator("#pt-memory-color").selectOption("#4a90d9");
  await page.getByTestId("pt-memory-save").click();

  const row = memoryWindow.locator("li").filter({ hasText: "Verse In" });
  await expect(row).toBeVisible();
  await expect(page.locator('[data-ruler="markers"]')).toContainText("Verse In");
  await execInPage(page, "set_transport", { position: 0 });
  await row.locator(".pt-memory-recall").click();
  await expect.poll(() => storeVal<number>(page, "transport.position")).toBe(3);

  await row.getByRole("button", { name: "Edit" }).click();
  await page.getByTestId("pt-memory-name").fill("Verse Pickup");
  await page.getByTestId("pt-memory-save").click();
  await expect(memoryWindow).toContainText("Verse Pickup");
  await page.getByTestId("pt-memory-search").fill("pickup");
  const editedRow = memoryWindow.locator("li").filter({ hasText: "Verse Pickup" });
  await expect(editedRow).toHaveCount(1);
  await page.screenshot({ path: testInfo.outputPath("protools-memory-locations-wide.png"), animations: "disabled" });

  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.setViewportSize({ width: 720, height: 720 });
  await expect(memoryWindow).toBeVisible();
  const compactBox = await memoryWindow.boundingBox();
  if (!compactBox) throw new Error("compact Memory Locations bounds are missing");
  expect(compactBox.x).toBe(0);
  expect(compactBox.width).toBe(720);
  await page.screenshot({ path: testInfo.outputPath("protools-memory-locations-compact.png"), animations: "disabled" });

  await editedRow.getByRole("button", { name: "Remove" }).click();
  await expect(memoryWindow.locator("li")).toHaveCount(0);
  const commands = await page.evaluate(() =>
    (window as ProToolsWindow).__moshCmdTrace?.map((entry) => entry.command) ?? []);
  expect(commands).toEqual(expect.arrayContaining([
    "create_annotation",
    "edit_annotation",
    "remove_annotation",
    "set_transport",
  ]));
});

test("tutorial-backed Zoom controls preserve the editing focus workflow", async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await bootProTools(page);
  const timeline = page.getByTestId("pt-timeline");
  await timeline.focus();
  const traceBefore = await page.evaluate(() => (window as ProToolsWindow).__moshCmdTrace?.length ?? 0);

  await page.keyboard.press("r");
  await expect.poll(() => storeVal<number>(page, "pxPerSec")).toBe(56);
  await page.keyboard.press("t");
  await expect.poll(() => storeVal<number>(page, "pxPerSec")).toBe(80);

  await page.getByTestId("pt-zoom-preset-5").click();
  await expect.poll(() => storeVal<number>(page, "pxPerSec")).toBe(320);
  await page.getByTestId("pt-zoom-preset-3").click();
  await expect.poll(() => storeVal<number>(page, "pxPerSec")).toBe(80);
  await page.getByTestId("pt-lower-zoom-in").click();
  await expect.poll(() => storeVal<number>(page, "pxPerSec")).toBe(112);
  await page.getByTestId("pt-lower-zoom-out").click();
  await expect.poll(() => storeVal<number>(page, "pxPerSec")).toBe(80);
  const firstHeader = page.getByTestId("pt-track-header").first();
  const firstLane = page.getByTestId("pt-lane").first();
  const baseHeaderHeight = (await firstHeader.boundingBox())?.height;
  await page.getByTestId("pt-lower-track-height-in").click();
  const enlargedHeaderHeight = (await firstHeader.boundingBox())?.height;
  const enlargedLaneHeight = (await firstLane.boundingBox())?.height;
  if (!baseHeaderHeight || !enlargedHeaderHeight || !enlargedLaneHeight) {
    throw new Error("track-height zoom bounds are missing");
  }
  expect(enlargedHeaderHeight).toBeGreaterThan(baseHeaderHeight);
  expect(enlargedLaneHeight).toBe(enlargedHeaderHeight);
  await page.getByTestId("pt-lower-track-height-out").click();
  await expect.poll(async () => (await firstHeader.boundingBox())?.height).toBe(baseHeaderHeight);

  await timeline.focus();
  await page.keyboard.press("F5");
  await expect(page.getByRole("button", { name: "Zoomer", exact: true })).toHaveAttribute("aria-pressed", "true");
  await page.getByTestId("pt-single-zoom").click();
  await expect(page.getByTestId("pt-single-zoom")).toHaveAttribute("aria-pressed", "true");
  const bounds = await timeline.boundingBox();
  if (!bounds) throw new Error("timeline bounds are missing");
  const y = bounds.y + Math.min(150, bounds.height / 2);
  await page.mouse.move(bounds.x + 160, y);
  await page.mouse.down();
  await page.mouse.move(bounds.x + Math.min(bounds.width - 80, 680), y, { steps: 4 });
  await expect(page.locator(".pt-zoom-marquee")).toBeVisible();
  await page.mouse.up();
  await expect(page.locator(".pt-zoom-marquee")).toHaveCount(0);
  await expect(page.getByTestId("pt-smart-tool")).toHaveAttribute("aria-pressed", "true");
  const afterRange = await storeVal<number>(page, "pxPerSec");
  expect(afterRange).toBeGreaterThan(80);

  await page.keyboard.down("Alt");
  await page.mouse.wheel(0, 100);
  await page.keyboard.up("Alt");
  await expect.poll(() => storeVal<number>(page, "pxPerSec")).toBeLessThan(afterRange);

  const waveformCanvas = page.locator('.pt-lane [data-testid="v2-clip"].wave canvas').first();
  const midiCanvas = page.locator('.pt-lane [data-testid="v2-clip"].midi canvas, .pt-lane [data-testid="v2-clip"].drum canvas').first();
  await expect(waveformCanvas).toBeVisible();
  await expect(midiCanvas).toBeVisible();

  const waveformOut = page.getByTestId("pt-waveform-zoom-out");
  const waveformIn = page.getByTestId("pt-waveform-zoom-in");
  await waveformOut.click();
  await waveformOut.click();
  await expect(waveformIn).toHaveAttribute("aria-label", /50 percent/);
  const waveformLow = await canvasInkHeight(waveformCanvas);
  expect(waveformLow).toBeGreaterThan(0);
  for (let step = 0; step < 4; step += 1) await waveformIn.click();
  await expect(waveformIn).toHaveAttribute("aria-label", /200 percent/);
  await expect.poll(() => canvasInkHeight(waveformCanvas)).toBeGreaterThan(waveformLow);

  const midiOut = page.getByTestId("pt-midi-zoom-out");
  const midiIn = page.getByTestId("pt-midi-zoom-in");
  await midiOut.click();
  await midiOut.click();
  await expect(midiIn).toHaveAttribute("aria-label", /50 percent/);
  const midiLow = await canvasInkHeight(midiCanvas);
  expect(midiLow).toBeGreaterThan(0);
  for (let step = 0; step < 4; step += 1) await midiIn.click();
  await expect(midiIn).toHaveAttribute("aria-label", /200 percent/);
  await expect.poll(() => canvasInkHeight(midiCanvas)).toBeGreaterThan(midiLow);
  await page.getByTestId("pt-lower-track-height-in").click();
  await expect(page.getByLabel("Track height scale")).toHaveText("125%");
  await page.screenshot({ path: testInfo.outputPath("protools-zoom-wide.png"), animations: "disabled" });

  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.setViewportSize({ width: 720, height: 720 });
  const zoomGroup = page.getByRole("group", { name: "Horizontal Zoom", exact: true });
  await zoomGroup.scrollIntoViewIfNeeded();
  await expect(zoomGroup).toBeInViewport();
  await expect(page.getByTestId("pt-zoom-in")).toBeVisible();
  await expect(page.getByTestId("pt-zoom-preset-5")).toBeVisible();
  await expect(page.getByRole("group", { name: "Vertical media zoom" })).toBeInViewport();
  await page.getByTestId("pt-lower-track-height-out").click();
  await page.getByTestId("pt-lower-track-height-out").click();
  await expect(page.getByLabel("Track height scale")).toHaveText("75%");
  await page.screenshot({ path: testInfo.outputPath("protools-zoom-compact.png"), animations: "disabled" });

  const traceAfter = await page.evaluate(() => (window as ProToolsWindow).__moshCmdTrace?.length ?? 0);
  expect(traceAfter).toBe(traceBefore);
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

test("tutorial-backed pre-roll and Punch preserve context before a bounded record range", async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await bootProTools(page);

  const waveClip = page.locator('[data-testid="v2-clip"].wave').first();
  const clipBox = await waveClip.boundingBox();
  if (!clipBox) throw new Error("audio clip bounds are unavailable for the Punch selection");
  const selectionY = clipBox.y + Math.min(8, clipBox.height / 4);
  await page.mouse.move(clipBox.x + clipBox.width * 0.2, selectionY);
  await page.mouse.down();
  await page.mouse.move(clipBox.x + clipBox.width * 0.75, selectionY, { steps: 4 });
  await page.mouse.up();

  const editSelection = await page.evaluate(() =>
    (window as ProToolsWindow).__moshShellStore?.getState().timeRange ?? null);
  if (!editSelection) throw new Error("Selector drag did not create an Edit selection");
  expect(editSelection.end).toBeGreaterThan(editSelection.start);

  const punch = page.getByTestId("pt-punch-toggle");
  await punch.scrollIntoViewIfNeeded();
  await punch.click();
  await expect.poll(() => storeVal<boolean>(page, "snapshot.session.project.recordOptions.punchInOut"))
    .toBe(true);
  await expect.poll(() => storeVal<boolean>(page, "transport.looping")).toBe(false);
  await expect.poll(() => storeVal<number>(page, "transport.loopStart"))
    .toBeCloseTo(editSelection.start, 4);
  await expect.poll(() => storeVal<number>(page, "transport.loopEnd"))
    .toBeCloseTo(editSelection.end, 4);
  await expect(page.getByTestId("pt-punch-overlay")).toBeVisible();

  await page.getByTestId("pt-preroll-select").selectOption("1");
  await expect.poll(() => storeVal<number>(page, "snapshot.session.countInBars")).toBe(1);
  await expect(page.getByTestId("pt-preroll-overlay")).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath("protools-punch-preroll-wide.png"), animations: "disabled" });

  const trace = await page.evaluate(() => (window as ProToolsWindow).__moshCmdTrace ?? []);
  const punchCommands = trace.filter((entry) =>
    ["set_transport", "set_record_options", "set_count_in"].includes(entry.command));
  expect(punchCommands.slice(-3).map((entry) => [entry.command, entry.args])).toEqual([
    ["set_transport", {
      loop: false,
      loopStart: editSelection.start,
      loopEnd: editSelection.end,
    }],
    ["set_record_options", { punchInOut: true }],
    ["set_count_in", { bars: 1 }],
  ]);
  expect(punchCommands.filter((entry) => !entry.ok)).toEqual([]);

  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.setViewportSize({ width: 720, height: 720 });
  await punch.scrollIntoViewIfNeeded();
  await expect(punch).toBeInViewport();
  await expect(punch).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByTestId("pt-preroll-select")).toHaveValue("1");
  await page.screenshot({ path: testInfo.outputPath("protools-punch-preroll-compact.png"), animations: "disabled" });
});

test("Track Views follow contextual selectors, Minus toggles, and automation disclosure", async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await bootProTools(page);

  const keysHeader = page.getByTestId("pt-track-header").filter({ hasText: "Keys" });
  const keysTrackId = await keysHeader.getAttribute("data-track-id");
  if (!keysTrackId) throw new Error("Keys track id is absent");
  const keysLane = page.locator(`[data-testid="pt-lane"][data-track-id="${keysTrackId}"]`);
  const keysView = keysHeader.getByTestId("pt-track-view");

  await expect(keysView).toHaveValue("waveform");
  await expect(keysLane).toHaveAttribute("data-track-view", "waveform");
  await expect(keysLane).toHaveAttribute("data-secondary-automation", "false");
  await expect(keysLane.getByTestId("v2-clip")).toBeVisible();

  // The native fader target is intentionally lazy. A normal inspector adjustment
  // materializes it before the producer opens Volume automation.
  await keysHeader.getByTestId("pt-track-select").click();
  await page.getByTestId("pt-track-volume").fill("-7");
  await keysView.selectOption("volume");
  await expect(keysLane).toHaveAttribute("data-track-view", "volume");
  await expect(keysLane.getByTestId("v2-clip")).toHaveCount(0);
  await expect(keysLane.getByTestId("pt-automation-lane-frame")).toHaveAttribute("data-primary", "true");
  await expect(keysLane.getByRole("button", { name: /Keys automation, Volume\./ })).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath("protools-track-views-wide.png"), animations: "disabled" });

  await keysHeader.getByTestId("pt-track-select").click();
  await page.keyboard.press("-");
  await expect(keysView).toHaveValue("waveform");
  await expect(keysLane.getByTestId("v2-clip")).toBeVisible();

  await keysHeader.getByTestId("pt-automation-lanes").click();
  await expect(keysLane).toHaveAttribute("data-secondary-automation", "true");
  await expect(keysLane.getByTestId("pt-automation-lane-frame")).toHaveAttribute("data-primary", "false");

  const drumsHeader = page.getByTestId("pt-track-header").filter({ hasText: "Drums" });
  const drumsTrackId = await drumsHeader.getAttribute("data-track-id");
  if (!drumsTrackId) throw new Error("Drums track id is absent");
  const drumsLane = page.locator(`[data-testid="pt-lane"][data-track-id="${drumsTrackId}"]`);
  const drumsView = drumsHeader.getByTestId("pt-track-view");
  await expect(drumsView).toHaveValue("clips");
  await drumsHeader.getByTestId("pt-track-select").click();
  await page.keyboard.press("-");
  await expect(drumsView).toHaveValue("notes");
  await expect(drumsLane).toHaveAttribute("data-track-view", "notes");
  await expect(drumsLane.getByTestId("v2-clip")).toBeVisible();

  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.setViewportSize({ width: 720, height: 720 });
  await expect(page.getByTestId("pt-clip-list")).toHaveClass(/is-closed/);
  await page.screenshot({ path: testInfo.outputPath("protools-track-views-compact.png"), animations: "disabled" });
});

test("Playlists audition whole takes and promote a selected phrase into the main comp", async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await bootProTools(page);
  await sessionAction(page, "new_project");
  await page.getByTestId("pt-add-track").click();
  await page.getByTestId("pt-add-track-audio").click();

  const header = page.getByTestId("pt-track-header").first();
  const trackId = await header.getAttribute("data-track-id");
  if (!trackId) throw new Error("recorded playlist track id is absent");
  const lane = page.locator(`[data-testid="pt-lane"][data-track-id="${trackId}"]`);
  await header.getByTestId("pt-track-select").click();
  await page.getByTestId("pt-io-input").click();
  await page.getByTestId("pt-io-input-option").filter({ hasText: "Input 1-2" }).click();
  await header.getByTestId("pt-track-arm").click();

  const toolbar = page.getByTestId("pt-toolbar");
  const record = toolbar.getByRole("button", { name: "Record", exact: true });
  const stop = toolbar.getByRole("button", { name: "Stop", exact: true });
  for (let take = 0; take < 2; take += 1) {
    await record.click();
    await expect.poll(() => storeVal<boolean>(page, "transport.recording")).toBe(true);
    await stop.click();
    await expect.poll(() => storeVal<boolean>(page, "transport.recording")).toBe(false);
  }
  await expect.poll(() => storeVal<number>(page, "snapshot.tracks.0.clips.0.numTakes")).toBe(2);
  await expect.poll(() => storeVal<number>(page, "snapshot.tracks.0.clips.0.currentTakeIndex")).toBe(1);

  await header.getByTestId("pt-track-view").selectOption("playlists");
  await expect(header).toHaveAttribute("data-track-view", "playlists");
  await expect(lane).toHaveAttribute("data-track-view", "playlists");
  await expect(header).toHaveCSS("height", "144px");
  await expect(lane).toHaveCSS("height", "144px");
  const playlists = lane.getByTestId("pt-playlists");
  await expect(playlists.getByTestId("pt-playlist-bar")).toHaveCount(2);
  await expect(playlists.getByRole("button", { name: /Take 2 on Audio, current/ })).toHaveAttribute("aria-pressed", "true");

  await playlists.getByRole("button", { name: /Take 1 on Audio/ }).click();
  await expect.poll(() => storeVal<number>(page, "snapshot.tracks.0.clips.0.currentTakeIndex")).toBe(0);
  await expect(playlists.getByRole("button", { name: /Take 1 on Audio, current/ })).toHaveAttribute("aria-pressed", "true");

  const alternate = playlists.getByRole("button", { name: /Take 2 on Audio/ });
  const alternateBox = await alternate.boundingBox();
  if (!alternateBox) throw new Error("alternate playlist bounds are absent");
  const selectionY = alternateBox.y + alternateBox.height / 2;
  await page.mouse.move(alternateBox.x + alternateBox.width * 0.25, selectionY);
  await page.mouse.down();
  await page.mouse.move(alternateBox.x + alternateBox.width * 0.75, selectionY, { steps: 4 });
  await page.mouse.up();
  const compSelection = playlists.getByTestId("pt-playlist-comp-selection");
  await expect(compSelection).toBeVisible();
  await expect(compSelection.getByTestId("pt-playlist-promote")).toHaveAccessibleName(/Promote Take 2/);
  await page.screenshot({ path: testInfo.outputPath("protools-playlists-comp-selection-wide.png"), animations: "disabled" });

  await compSelection.getByTestId("pt-playlist-promote").click();
  await expect.poll(() => storeVal<number>(page, "snapshot.tracks.0.clips.length")).toBe(3);
  await expect.poll(() => storeVal<number>(page, "snapshot.tracks.0.clips.0.currentTakeIndex")).toBe(0);
  await expect.poll(() => storeVal<number>(page, "snapshot.tracks.0.clips.1.currentTakeIndex")).toBe(1);
  await expect.poll(() => storeVal<number>(page, "snapshot.tracks.0.clips.2.currentTakeIndex")).toBe(0);
  await expect(compSelection).toHaveCount(0);
  await page.screenshot({ path: testInfo.outputPath("protools-playlists-wide.png"), animations: "disabled" });

  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.setViewportSize({ width: 720, height: 720 });
  await expect(page.getByTestId("pt-clip-list")).toHaveClass(/is-closed/);
  await expect(playlists).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath("protools-playlists-compact.png"), animations: "disabled" });

  await execInPage(page, "undo");
  await expect.poll(() => storeVal<number>(page, "snapshot.tracks.0.clips.length")).toBe(1);
  await expect.poll(() => storeVal<number>(page, "snapshot.tracks.0.clips.0.currentTakeIndex")).toBe(0);
  await execInPage(page, "redo");
  await expect.poll(() => storeVal<number>(page, "snapshot.tracks.0.clips.length")).toBe(3);

  const trace = await page.evaluate(() => (window as ProToolsWindow).__moshCmdTrace ?? []);
  expect(trace.map((entry) => entry.command)).toContain("set_current_take");
  expect(trace.map((entry) => entry.command)).toContain("promote_take_region");
  expect(trace.filter((entry) => !entry.ok)).toEqual([]);
});

test("Waveform comp target cycles alternate takes inside one selection", async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await bootProTools(page);
  await sessionAction(page, "new_project");
  await page.getByTestId("pt-add-track").click();
  await page.getByTestId("pt-add-track-audio").click();

  const header = page.getByTestId("pt-track-header").first();
  const trackId = await header.getAttribute("data-track-id");
  if (!trackId) throw new Error("recorded comp track id is absent");
  const lane = page.locator(`[data-testid="pt-lane"][data-track-id="${trackId}"]`);
  await header.getByTestId("pt-track-select").click();
  await page.getByTestId("pt-io-input").click();
  await page.getByTestId("pt-io-input-option").filter({ hasText: "Input 1-2" }).click();
  await header.getByTestId("pt-track-arm").click();

  const toolbar = page.getByTestId("pt-toolbar");
  const record = toolbar.getByRole("button", { name: "Record", exact: true });
  const stop = toolbar.getByRole("button", { name: "Stop", exact: true });
  for (let take = 0; take < 2; take += 1) {
    await record.click();
    await expect.poll(() => storeVal<boolean>(page, "transport.recording")).toBe(true);
    await stop.click();
    await expect.poll(() => storeVal<boolean>(page, "transport.recording")).toBe(false);
  }
  await expect.poll(() => storeVal<number>(page, "snapshot.tracks.0.clips.0.currentTakeIndex")).toBe(1);

  const clip = lane.getByTestId("v2-clip").first();
  const clipBox = await clip.boundingBox();
  if (!clipBox) throw new Error("waveform clip bounds are absent");
  const selectionY = clipBox.y + Math.min(8, clipBox.height / 4);
  await page.mouse.move(clipBox.x + clipBox.width * 0.25, selectionY);
  await page.mouse.down();
  await page.mouse.move(clipBox.x + clipBox.width * 0.75, selectionY, { steps: 4 });
  await expect(lane.getByTestId("pt-comp-range")).toHaveAttribute("data-dragging", "true");
  await page.mouse.up();

  const compRange = lane.getByTestId("pt-comp-range");
  await expect(compRange).toBeVisible();
  await expect(compRange.getByTestId("pt-comp-target")).toHaveText("Target: Main");
  await expect(compRange.getByTestId("pt-comp-current")).toHaveText("Take 2 of 2");
  await page.screenshot({
    path: testInfo.outputPath("protools-waveform-comp-target-before-wide.png"),
    animations: "disabled",
  });

  await page.keyboard.press("Meta+Shift+ArrowUp");
  await expect.poll(() => storeVal<number>(page, "snapshot.tracks.0.clips.length")).toBe(3);
  await expect.poll(() => storeVal<number>(page, "snapshot.tracks.0.clips.1.currentTakeIndex")).toBe(0);
  await expect(compRange.getByTestId("pt-comp-current")).toHaveText("Take 1 of 2");
  await page.keyboard.press("Meta+Shift+ArrowDown");
  await expect.poll(() => storeVal<number>(page, "snapshot.tracks.0.clips.1.currentTakeIndex")).toBe(1);
  await expect(compRange.getByTestId("pt-comp-current")).toHaveText("Take 2 of 2");

  const promotions = await page.evaluate(() =>
    (window as ProToolsWindow).__moshCmdTrace?.filter((entry) =>
      entry.command === "promote_take_region") ?? []);
  expect(promotions).toHaveLength(2);
  expect(promotions[0]?.args.takeIndex).toBe(0);
  expect(promotions[1]?.args.takeIndex).toBe(1);
  await page.screenshot({
    path: testInfo.outputPath("protools-waveform-comp-target-after-wide.png"),
    animations: "disabled",
  });

  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.setViewportSize({ width: 720, height: 720 });
  await expect(page.getByTestId("pt-clip-list")).toHaveClass(/is-closed/);
  const compactToolbar = await compRange.getByRole("group").boundingBox();
  if (!compactToolbar) throw new Error("compact comp controls are absent");
  expect(compactToolbar.x).toBeGreaterThanOrEqual(0);
  expect(compactToolbar.x + compactToolbar.width).toBeLessThanOrEqual(720);
  await page.screenshot({
    path: testInfo.outputPath("protools-waveform-comp-target-compact.png"),
    animations: "disabled",
  });

  await page.keyboard.press("Escape");
  await expect(compRange).toHaveCount(0);
});

test("Sends route a track through a named Aux return and its insert rack", async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await bootProTools(page);

  const sourceHeader = page.getByTestId("pt-track-header").first();
  const sourceTrackId = await sourceHeader.getAttribute("data-track-id");
  if (!sourceTrackId) throw new Error("send source track id is absent");
  await sourceHeader.getByTestId("pt-track-select").click();
  const sends = page.getByTestId("pt-sends");
  await expect(sends).toBeVisible();
  await expect(sends).toContainText("No Aux returns");

  await sends.getByTestId("pt-add-bus").click();
  const busName = sends.getByTestId("pt-new-bus-name");
  await expect(busName).toBeFocused();
  await busName.fill("Vocal Plate");
  await busName.press("Enter");

  await expect(page.getByTestId("pt-aux-input")).toHaveText("Bus — Vocal Plate");
  await expect(page.locator(".pt-detail-title")).toHaveText("Aux — Vocal Plate");
  await expect(page.getByTestId("pt-device-rack")).toHaveAttribute("aria-label", "Inserts on Vocal Plate");
  await page.getByTestId("pt-add-insert").click();
  await page.getByTestId("plugin-browser-search").fill("Reverb");
  await page.locator(".prow-load").filter({ hasText: "Reverb" }).click();
  await expect(page.getByTestId("pt-device-rack")).toContainText("Reverb");

  await sourceHeader.getByTestId("pt-track-select").click();
  const assign = page.getByTestId("pt-add-send-0");
  await expect(assign).toBeVisible();
  await assign.click();
  await expect.poll(() => page.evaluate((trackId) => {
    const snapshot = (window as ProToolsWindow).__moshStore?.getState().snapshot;
    return snapshot?.tracks.find((track) => track.id === trackId)?.sends?.[0]?.bus;
  }, sourceTrackId)).toBe(0);

  const level = page.getByTestId("pt-send-level-0");
  await level.fill("-9");
  await expect.poll(() => page.evaluate((trackId) => {
    const snapshot = (window as ProToolsWindow).__moshStore?.getState().snapshot;
    return snapshot?.tracks.find((track) => track.id === trackId)?.sends?.[0]?.db;
  }, sourceTrackId)).toBe(-9);
  await expect(page.getByTestId("pt-send-level-readout-0")).toHaveText("-9.0 dB");
  await page.screenshot({ path: testInfo.outputPath("protools-sends-wide.png"), animations: "disabled" });

  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.setViewportSize({ width: 720, height: 720 });
  await level.scrollIntoViewIfNeeded();
  await expect(sends).toBeInViewport();
  await expect(level).toBeInViewport();
  await expect(page.getByTestId("pt-send-level-readout-0")).toHaveText("-9.0 dB");
  await expect(page.getByTestId("pt-clip-list")).toHaveClass(/is-closed/);
  await page.screenshot({ path: testInfo.outputPath("protools-sends-compact.png"), animations: "disabled" });

  const trace = await page.evaluate(() => (window as ProToolsWindow).__moshCmdTrace ?? []);
  const commands = trace.map((entry) => entry.command);
  for (const command of ["create_bus", "load_builtin", "add_send", "set_send_level"])
    expect(commands).toContain(command);
  expect(trace.filter((entry) => !entry.ok)).toEqual([]);
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
