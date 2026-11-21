import { test, expect, type Page } from "@playwright/test";
import { bootV3 } from "./helpers";

// Shell-retirement step 2: the automation write behaviours the old v2 automation-write spec
// pointed at (its two tests were test.fixme, "definition of done" for a v2 surface that
// never shipped): per-track write-arm, and bulk-authored curves on a parameter.
//
// NO-V3-UI: V3 has no automation write-arm control and no lane/curve surface. The commands
// are driven through the store.exec seam the UI would use and asserted on the snapshot, with
// one-⌘Z undo. The parameter is the track's built-in Volume (mixer plugin 100, param 0).

type Param = { index: number; points?: { t: number; v: number }[]; automated?: boolean };
type Trk = { id: string; name: string; automationMode?: string; mixerPlugins?: { index: number; params?: Param[] }[] };
const BASS = "12";
const P = { trackId: BASS, pluginIndex: 100, paramIndex: 0 };

const bass = (page: Page) =>
  page.evaluate((id) => (window as unknown as { __moshStore: { getState: () => { snapshot: { tracks: Trk[] } } } })
    .__moshStore.getState().snapshot.tracks.find((t) => t.id === id)!, BASS);
const points = async (page: Page) =>
  (await bass(page)).mixerPlugins?.find((p) => p.index === 100)?.params?.find((x) => x.index === 0)?.points ?? [];
const run = (page: Page, command: string, args: Record<string, unknown>) =>
  page.evaluate(([c, a]) => (window as unknown as { __moshStore: { getState: () => { exec: (c: string, a: Record<string, unknown>) => Promise<{ ok?: boolean; error?: string }> } } })
    .__moshStore.getState().exec(c as string, a as Record<string, unknown>), [command, args] as const);
const undo = async (page: Page) => { await page.locator("body").click({ position: { x: 1, y: 1 } }); await page.keyboard.press("ControlOrMeta+z"); };

test("set_track_automation_mode arms write, reads back, rejects a bad mode, and undoes", async ({ page }) => {
  await bootV3(page);
  expect((await bass(page)).automationMode ?? "read").toBe("read");        // anti-vacuity baseline
  expect((await run(page, "set_track_automation_mode", { trackId: BASS, mode: "write" })).ok).toBe(true);
  expect((await bass(page)).automationMode).toBe("write");
  expect((await run(page, "set_track_automation_mode", { trackId: BASS, mode: "scribble" })).ok).toBeFalsy();
  expect((await bass(page)).automationMode).toBe("write");                 // the refusal changed nothing
  await undo(page);
  expect((await bass(page)).automationMode ?? "read").toBe("read");
});

test("write_automation_curve authors a curve in one step, replace/merge semantics hold, and it undoes once", async ({ page }) => {
  await bootV3(page);
  expect(await points(page)).toEqual([]);
  const curve = [{ t: 0, v: 0.2 }, { t: 2, v: 0.8 }, { t: 4, v: 0.4 }];
  const r = await run(page, "write_automation_curve", { ...P, points: curve });
  expect(r.ok).toBe(true);
  expect(await points(page)).toEqual(curve);
  expect((await bass(page)).mixerPlugins?.find((p) => p.index === 100)?.params?.[0].automated).toBe(true);

  // merge keeps the existing points and sorts the new one in
  expect((await run(page, "write_automation_curve", { ...P, points: [{ t: 1, v: 0.5 }], apply: "merge" })).ok).toBe(true);
  expect((await points(page)).map((p) => p.t)).toEqual([0, 1, 2, 4]);
  // replace over a window drops the old points inside it
  expect((await run(page, "write_automation_curve", { ...P, points: [{ t: 1.5, v: 0.9 }], replaceStart: 1, replaceEnd: 3 })).ok).toBe(true);
  expect((await points(page)).map((p) => p.t)).toEqual([0, 1.5, 4]);

  await undo(page); await undo(page);                                      // replace, then merge
  expect(await points(page)).toEqual(curve);
  await undo(page);                                                        // the whole authored curve is ONE step
  expect(await points(page)).toEqual([]);
});

test("write_automation_curve rejects malformed curves without touching the lane", async ({ page }) => {
  await bootV3(page);
  expect((await run(page, "write_automation_curve", { ...P, points: [] })).ok).toBeFalsy();
  expect((await run(page, "write_automation_curve", { ...P, points: [{ t: 2, v: 0.5 }, { t: 1, v: 0.5 }] })).ok).toBeFalsy();   // not ascending
  expect((await run(page, "write_automation_curve", { ...P, points: [{ t: 0, v: 1.5 }] })).ok).toBeFalsy();                    // out of 0..1
  expect((await run(page, "write_automation_curve", { ...P, paramIndex: 99, points: [{ t: 0, v: 0.5 }] })).ok).toBeFalsy();    // no such param
  expect(await points(page)).toEqual([]);
});

test("point-level automation commands add, move, remove and clear, each one undo", async ({ page }) => {
  await bootV3(page);
  expect((await run(page, "add_automation_point", { ...P, time: 1, value: 0.3 })).ok).toBe(true);
  expect((await run(page, "add_automation_point", { ...P, time: 3, value: 0.6 })).ok).toBe(true);
  expect(await points(page)).toEqual([{ t: 1, v: 0.3 }, { t: 3, v: 0.6 }]);
  expect((await run(page, "set_automation_point", { ...P, pointIndex: 0, time: 1.5, value: 0.35 })).ok).toBe(true);
  expect((await points(page))[0]).toEqual({ t: 1.5, v: 0.35 });
  expect((await run(page, "remove_automation_point", { ...P, pointIndex: 1 })).ok).toBe(true);
  expect(await points(page)).toHaveLength(1);
  expect((await run(page, "clear_automation", P)).ok).toBe(true);
  expect(await points(page)).toEqual([]);
  await undo(page);
  expect(await points(page)).toHaveLength(1);
});
