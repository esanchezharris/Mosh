import { test, expect, type Page } from "@playwright/test";
import { bootV3, expectDispatched } from "./helpers";

// Ported from track-color, track-reorder, track-icon and audio-routing (v2 / classic shells, retired).
//
//   track-color      NO-V3-UI: V3 has no colour picker and its track rows do not render t.color.
//                    set_track_color is kept through the store with the old spec's contract
//                    (round-trip, uppercase normalises, bad value refused without half-applying,
//                    "" clears, undo restores the PREVIOUS colour, neighbours untouched).
//                    The engine half is also in SelfTest.cpp.
//   track-reorder    NO-V3-UI for the ▲▼ buttons and header drag. move_track is kept through the
//                    store; what V3 DOES own is that the arrangement rows follow the snapshot
//                    order, so that is asserted on the DOM (the old "lanes follow the headers").
//   track-icon       NO-V3-UI: same as colour. set_track_icon round-trip, unknown name refused,
//                    "" clears, undo restores the previous icon, neighbours untouched.
//   audio-routing    PORT: V3 Settings embeds the same AudioRouting block (set_audio_device,
//                    set_track_input).

type Trk = { id: string; name: string; color?: string; icon?: string; input?: { deviceID: string } };
type Res = { ok: boolean; error?: string };
type MoshWindow = Window & { __moshStore: { getState: () => { snapshot: { tracks: Trk[] }; exec: (c: string, a?: object) => Promise<Res> } } };

const tracks = (page: Page) => page.evaluate(() => (window as unknown as MoshWindow).__moshStore.getState().snapshot.tracks.map((t) => ({ ...t })));
const exec = (page: Page, command: string, args: object = {}) =>
  page.evaluate(([c, a]) => (window as unknown as MoshWindow).__moshStore.getState().exec(c as string, a as object), [command, args] as const);
const undo = (page: Page) => page.keyboard.press("ControlOrMeta+z");
const names = async (page: Page) => (await tracks(page)).map((t) => t.name);
const rowNames = (page: Page) => page.getByTestId("v3-track").evaluateAll((els) => els.map((e) => e.getAttribute("data-track-id") ?? ""));
const byName = async (page: Page, n: string) => (await tracks(page)).find((t) => t.name === n)!;

// ── track colour ────────────────────────────────────────────────────────────
// NO-V3-UI.
test("set_track_color: round-trips, normalises case, refuses a bad value, clears with \"\", and one undo restores the previous colour (NO-V3-UI)", async ({ page }) => {
  await bootV3(page);
  const [a, b] = await tracks(page);
  expect(a.color).toBeUndefined();                                           // anti-vacuity baseline

  expect((await exec(page, "set_track_color", { trackId: a.id, color: "#38bdf8" })).ok).toBe(true);
  expect((await byName(page, a.name)).color).toBe("#38bdf8");
  expect((await tracks(page)).find((t) => t.id === b.id)!.color).toBeUndefined();   // colouring one track leaves its neighbours alone

  expect((await exec(page, "set_track_color", { trackId: a.id, color: "#4ADE80" })).ok).toBe(true);
  expect((await byName(page, a.name)).color).toBe("#4ade80");                // uppercase normalises to lowercase

  const bad = await exec(page, "set_track_color", { trackId: a.id, color: "red" });
  expect(bad.ok).toBe(false);
  expect((await byName(page, a.name)).color).toBe("#4ade80");                // refused without half-applying
  expect((await exec(page, "set_track_color", { trackId: "no-such-track", color: "#38bdf8" })).ok).toBe(false);

  await undo(page);                                                          // undo restores the PREVIOUS colour, not the default
  await expect.poll(async () => (await byName(page, a.name)).color).toBe("#38bdf8");

  expect((await exec(page, "set_track_color", { trackId: a.id, color: "" })).ok).toBe(true);
  expect((await byName(page, a.name)).color).toBeUndefined();                // "" removes the property
  await expectDispatched(page, "set_track_color", { trackId: a.id, color: "" });
});

// ── track icon ──────────────────────────────────────────────────────────────
// NO-V3-UI.
test("set_track_icon: round-trips, normalises case, refuses an unknown name, clears with \"\", and one undo restores the previous icon (NO-V3-UI)", async ({ page }) => {
  await bootV3(page);
  const [a, b] = await tracks(page);
  expect(a.icon).toBeUndefined();

  expect((await exec(page, "set_track_icon", { trackId: a.id, icon: "guitar" })).ok).toBe(true);
  expect((await byName(page, a.name)).icon).toBe("guitar");
  expect((await tracks(page)).find((t) => t.id === b.id)!.icon).toBeUndefined();     // neighbours alone

  expect((await exec(page, "set_track_icon", { trackId: a.id, icon: "  KEYS " })).ok).toBe(true);
  expect((await byName(page, a.name)).icon).toBe("keys");                    // padded mixed case normalises

  const bad = await exec(page, "set_track_icon", { trackId: a.id, icon: "not-an-icon" });
  expect(bad.ok).toBe(false);
  expect((await byName(page, a.name)).icon).toBe("keys");                    // refused without half-applying
  expect((await exec(page, "set_track_icon", { trackId: "no-such-track", icon: "keys" })).ok).toBe(false);

  await undo(page);
  await expect.poll(async () => (await byName(page, a.name)).icon).toBe("guitar");   // the PREVIOUS icon, not the default

  expect((await exec(page, "set_track_icon", { trackId: a.id, icon: "" })).ok).toBe(true);
  expect((await byName(page, a.name)).icon).toBeUndefined();
  await expectDispatched(page, "set_track_icon", { trackId: a.id, icon: "" });
});

// ── track reorder ───────────────────────────────────────────────────────────
// NO-V3-UI for the controls; the DOM-follows-snapshot half is real V3 behaviour.
test("move_track: down swaps with the one below, up is the exact inverse, the arrangement rows follow, one undo each (NO-V3-UI)", async ({ page }) => {
  await bootV3(page);
  const before = await names(page);
  const beforeRows = await rowNames(page);
  expect(before.length).toBeGreaterThanOrEqual(3);
  const first = (await tracks(page))[0];

  expect((await exec(page, "move_track", { trackId: first.id, toIndex: 1 })).ok).toBe(true);
  const expected = [before[1], before[0], ...before.slice(2)];
  expect(await names(page)).toEqual(expected);
  // The whole row moves, not just the label: V3's lanes are rendered in snapshot order.
  await expect.poll(() => rowNames(page)).toEqual([beforeRows[1], beforeRows[0], ...beforeRows.slice(2)]);

  expect((await exec(page, "move_track", { trackId: first.id, toIndex: 0 })).ok).toBe(true);   // no off-by-one going back
  expect(await names(page)).toEqual(before);
  await expect.poll(() => rowNames(page)).toEqual(beforeRows);

  expect((await exec(page, "move_track", { trackId: first.id, toIndex: 2 })).ok).toBe(true);
  await undo(page);
  await expect.poll(() => names(page)).toEqual(before);
  await expectDispatched(page, "move_track", { trackId: first.id, toIndex: 2 });
});

test("move_track: an out-of-range index clamps to the end, a same-index move succeeds, an unknown track is refused (NO-V3-UI)", async ({ page }) => {
  await bootV3(page);
  const before = await names(page);
  const [first] = await tracks(page);

  expect((await exec(page, "move_track", { trackId: first.id, toIndex: 0 })).ok).toBe(true);   // dropped where it started: ordinary
  expect(await names(page)).toEqual(before);

  expect((await exec(page, "move_track", { trackId: first.id, toIndex: 99 })).ok).toBe(true);  // "past the end" means last
  expect(await names(page)).toEqual([...before.slice(1), before[0]]);

  expect((await exec(page, "move_track", { trackId: "no-such-track", toIndex: 0 })).ok).toBe(false);
});

// ── audio routing in Settings ───────────────────────────────────────────────
test.describe("audio routing in Settings (set_audio_device / set_track_input)", () => {
  test.beforeEach(async ({ page }) => {
    await bootV3(page);
    await page.getByTestId("v3-file-trigger").click();
    await page.getByTestId("v3-open-settings").click();
    await expect(page.getByTestId("v3-settings")).toBeVisible();
  });

  test("the device selects are populated from list_audio_devices", async ({ page }) => {
    const out = page.getByLabel("Output device", { exact: true });
    await expect(out).toBeVisible();
    await expect(out.locator("option")).toHaveText(["MacBook Pro Speakers", "External Headphones"]);
    await expect(out).toHaveValue("MacBook Pro Speakers");
    await expect(page.getByLabel("Input device", { exact: true }).locator("option")).toHaveText(["MacBook Pro Microphone", "Scarlett 2i2"]);
  });

  test("changing the output device round-trips through set_audio_device", async ({ page }) => {
    const out = page.getByLabel("Output device", { exact: true });
    await out.selectOption("External Headphones");
    await expectDispatched(page, "set_audio_device", { outputDevice: "External Headphones" });
    await expect(out).toHaveValue("External Headphones");                   // list_audio_devices is re-fetched and the mock remembers it
  });

  test("each non-group track gets an input picker, and choosing one sticks", async ({ page }) => {
    const keysInput = page.getByLabel("Input for Keys", { exact: true });
    await expect(keysInput).toBeVisible();
    await expect(keysInput.locator("option")).toHaveText(["None", "Input 1-2", "Input 3-4", "Input 5 (disabled)"]);
    await expect(keysInput).toHaveValue("");                                // None by default

    await keysInput.selectOption("Input 3-4");
    await expectDispatched(page, "set_track_input", { deviceID: "in-3-4" });
    await expect(keysInput).toHaveValue("in-3-4");
    expect((await byName(page, "Keys")).input?.deviceID).toBe("in-3-4");
  });
});
