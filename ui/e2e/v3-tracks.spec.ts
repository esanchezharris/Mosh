import { test, expect, type Page } from "@playwright/test";
import { bootV3, expectDispatched } from "./helpers";

// Ported from master-bus, record-arm, uireach-input-monitor and uireach-remove-track
// (v2 shell, retired).
//
//   master-bus       master fader/pan: PORT (V3 Mixer view). Master plugin chain: NO-V3-UI (the
//                    V3 Mixer has a master volume/pan strip but no master rack) — kept through
//                    the store. Sends: ALREADY COVERED by v3-mix.spec.ts ("+ Bus creates a
//                    return, Add routes a send ..." — create_bus / add_send / set_send_level).
//                    Meters: V3's Mixer draws no meters; the only V3 meter is the Booth input
//                    meter (v3-keys-dock / v3-record), so the v2 ".v2-meter" check has no home.
//   record-arm       Record button: ALREADY COVERED (v3-shell.spec.ts:12, :84-85). Takes tab:
//                    ALREADY COVERED (v3-record.spec.ts "keep one pass and redo another").
//                    Per-track arm, input picker: PORT below.
//   input-monitor    Hear switch on an armed track: PORT below (also v3-checklist.spec.ts:239).
//   remove-track     NO-V3-UI: V3 has no delete-track control (only the clip context menu's
//                    Delete -> remove_clip). Kept through the store, with the one-undo contract.

type Track = { id: string; name: string; armed?: boolean; monitor?: string; input?: { deviceID: string }; plugins?: { index: number; enabled: boolean; name: string; params?: { index: number; value: number }[] }[] };
type Snap = { tracks: Track[]; master?: { volumeDb?: number; pan?: number; plugins?: Track["plugins"] } };
type Res = { ok: boolean; error?: string; data?: Record<string, unknown> };
type MoshWindow = Window & { __moshStore: { getState: () => { snapshot: Snap; exec: (c: string, a?: object) => Promise<Res> } } };

const snap = (page: Page) => page.evaluate(() => (window as unknown as MoshWindow).__moshStore.getState().snapshot);
const exec = (page: Page, command: string, args: object = {}) =>
  page.evaluate(([c, a]) => (window as unknown as MoshWindow).__moshStore.getState().exec(c as string, a as object), [command, args] as const);
const row = (page: Page, name: string) => page.getByTestId("v3-track").filter({ hasText: name });
const undo = (page: Page) => page.keyboard.press("ControlOrMeta+z");

// ── master bus ──────────────────────────────────────────────────────────────

test("master fader and pan: set_master_volume / set_master_pan read back through the snapshot and undo in one step", async ({ page }) => {
  await bootV3(page);
  await page.getByTestId("v3-rail-mixer").click();
  const strip = page.getByTestId("master-strip");
  await expect(strip).toBeVisible();
  expect((await snap(page)).master?.volumeDb).toBe(0);                       // anti-vacuity baseline

  const vol = strip.getByTitle("Master volume");
  await vol.fill("-6");
  await vol.blur();                                                          // ⌘Z is ignored while an input has focus
  await expect(strip).toContainText("-6.0 dB");                              // the control reflects the snapshot
  expect((await snap(page)).master?.volumeDb).toBe(-6);
  await expectDispatched(page, "set_master_volume", { db: -6 });
  await undo(page);
  await expect(strip).toContainText("0.0 dB");
  expect((await snap(page)).master?.volumeDb).toBe(0);

  const pan = strip.getByTitle("Master pan");
  await pan.fill("0.5");
  await pan.blur();
  await expectDispatched(page, "set_master_pan", { pan: 0.5 });
  expect((await snap(page)).master?.pan).toBe(0.5);
  await undo(page);
  expect((await snap(page)).master?.pan).toBe(0);
});

// NO-V3-UI — no master rack in V3; the commands the v2 RightRail MasterCard sent.
test("master plugin chain: add builtin + VST3, reorder, bypass, set a param, remove, undo (NO-V3-UI)", async ({ page }) => {
  await bootV3(page);
  const masterPlugins = async () => (await snap(page)).master?.plugins ?? [];
  expect(await masterPlugins()).toHaveLength(0);

  expect((await exec(page, "load_master_builtin", { type: "compressor" })).ok).toBe(true);
  expect((await exec(page, "load_master_plugin", { pluginId: "ott" })).ok).toBe(true);
  expect((await masterPlugins()).map((p) => p.name)).toHaveLength(2);
  const first = (await masterPlugins())[0].name;
  const second = (await masterPlugins())[1].name;

  expect((await exec(page, "reorder_master_plugin", { index: 1, toIndex: 0 })).ok).toBe(true);
  expect((await masterPlugins()).map((p) => p.name)).toEqual([second, first]);

  expect((await exec(page, "bypass_master_plugin", { index: 0, bypassed: true })).ok).toBe(true);
  expect((await masterPlugins())[0].enabled).toBe(false);

  const paramIndex = (await masterPlugins())[1].params![0].index;
  expect((await exec(page, "set_master_plugin_param", { index: 1, paramIndex, value: 0.25 })).ok).toBe(true);
  expect((await masterPlugins())[1].params!.find((p) => p.index === paramIndex)!.value).toBe(0.25);

  expect((await exec(page, "open_master_plugin_editor", { index: 0 })).ok).toBe(true);

  expect((await exec(page, "remove_master_plugin", { index: 0 })).ok).toBe(true);
  expect(await masterPlugins()).toHaveLength(1);
  await undo(page);                                                          // one undo: the plugin is back
  await expect.poll(async () => (await masterPlugins()).length).toBe(2);

  // A bad index is an error result, never a silent no-op.
  expect((await exec(page, "remove_master_plugin", { index: 99 })).ok).toBe(false);
});

// ── recording: arm, input, monitor ──────────────────────────────────────────

test("arm_track: the track header's R toggles arm, and arming is per track", async ({ page }) => {
  await bootV3(page);
  const bass = row(page, "Bass").getByRole("button", { name: "Arm" });
  const keys = row(page, "Keys").getByRole("button", { name: "Arm" });
  await expect(bass).not.toHaveClass(/arm/);
  await expect(keys).not.toHaveClass(/arm/);

  await bass.click();
  await expectDispatched(page, "arm_track", { armed: true });
  await expect(bass).toHaveClass(/arm/);
  await expect(keys).not.toHaveClass(/arm/);                                 // one track's arm never arms another
  expect((await snap(page)).tracks.filter((t) => t.armed).map((t) => t.name)).toEqual(["Bass"]);

  await keys.click();
  await expect(keys).toHaveClass(/arm/);
  await expect(bass).toHaveClass(/arm/);                                     // both at once: what a multi-track take needs
  expect((await snap(page)).tracks.filter((t) => t.armed)).toHaveLength(2);

  await bass.click();
  await expect(bass).not.toHaveClass(/arm/);
  expect((await snap(page)).tracks.filter((t) => t.armed).map((t) => t.name)).toEqual(["Keys"]);
});

test("set_track_input: an audio track exposes an input picker in the Inspector and the choice reads back", async ({ page }) => {
  await bootV3(page);
  const bass = row(page, "Keys");
  await bass.getByRole("button", { name: /^Select track/ }).click();
  const id = (await bass.getAttribute("data-track-id"))!;
  const inspector = page.getByTestId("v3-inspector");
  await expect(inspector).toHaveAttribute("data-track-id", id);

  const input = inspector.getByLabel("Input");
  await expect(input).toBeVisible();
  await input.focus();                                                       // loads the routing choices on focus
  await expect(input.locator('option[value="in-3-4"]')).toHaveCount(1);   // "None" alone would pass vacuously
  await input.selectOption("in-3-4");
  await expectDispatched(page, "set_track_input", { trackId: id, deviceID: "in-3-4" });
  expect((await snap(page)).tracks.find((t) => t.id === id)?.input?.deviceID).toBe("in-3-4");
  await expect(input).toHaveValue("in-3-4");
});

test("set_input_monitor: an armed audio track shows Hear, and it flips the track's monitor mode", async ({ page }) => {
  await bootV3(page);
  const bass = row(page, "Keys");
  const id = (await bass.getAttribute("data-track-id"))!;
  await expect(bass.getByTestId("v3-track-hear")).toHaveCount(0);            // only a track that is taking the mic has it
  const monitor = async () => (await snap(page)).tracks.find((t) => t.id === id)?.monitor;
  expect(["automatic", undefined]).toContain(await monitor());              // unset in the seed project (reads as automatic)

  await bass.getByRole("button", { name: "Arm" }).click();
  const hear = bass.getByTestId("v3-track-hear");
  await expect(hear).toBeVisible();
  await expect(hear).toHaveAttribute("aria-pressed", "true");

  await hear.click();
  await expectDispatched(page, "set_input_monitor", { trackId: id, mode: "off" });
  await expect(hear).toHaveAttribute("aria-pressed", "false");
  expect(await monitor()).toBe("off");

  await hear.click();
  await expect(hear).toHaveAttribute("aria-pressed", "true");
  expect(await monitor()).toBe("automatic");

  // The mode "on" (always monitor) has no V3 control; the command still takes it.
  expect((await exec(page, "set_input_monitor", { trackId: id, mode: "on" })).ok).toBe(true);
  expect(await monitor()).toBe("on");
});

// ── remove_track ────────────────────────────────────────────────────────────

// NO-V3-UI — V3 has no delete-track control. The v2 spec pinned the confirm gate and the
// removal; here the command itself: the track goes, and one undo brings it back.
test("remove_track removes the track, one undo restores it, and an unknown id is refused (NO-V3-UI)", async ({ page }) => {
  await bootV3(page);
  await expect(page.getByTestId("v3-track")).toHaveCount(3);                 // anti-vacuity baseline
  const bass = row(page, "Bass");
  const id = (await bass.getAttribute("data-track-id"))!;

  expect((await exec(page, "remove_track", { trackId: id })).ok).toBe(true);
  await expect(page.getByTestId("v3-track")).toHaveCount(2);
  await expect(page.locator(`[data-testid="v3-track"][data-track-id="${id}"]`)).toHaveCount(0);
  expect((await snap(page)).tracks.map((t) => t.id)).not.toContain(id);

  await undo(page);
  await expect(page.getByTestId("v3-track")).toHaveCount(3);
  await expect(page.locator(`[data-testid="v3-track"][data-track-id="${id}"]`)).toHaveCount(1);

  expect((await exec(page, "remove_track", { trackId: "no-such-track" })).ok).toBe(false);
  await expect(page.getByTestId("v3-track")).toHaveCount(3);
});
