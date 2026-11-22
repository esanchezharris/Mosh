import { test, expect, type Page } from "@playwright/test";
import { bootV3, clipNum, expectDispatched } from "./helpers";

// Ported from history-jump, engine-backed-controls, crop-and-grid, gesture-marquee,
// anchored-panel-scroll-race, arrange and smoke (v2 / classic shells, retired).
//
//   history-jump        PORT: V3's History flyout restores to a row (jump_to_history), counting undo
//                       TRANSACTIONS rather than log rows.
//   engine-backed       Select similar: NO-V3-UI (UI-local predicate in v2/lanes/selectSimilar.ts, no
//     controls          command; its unit test goes with v2). Quantize swing: PORT (the shared piano
//                       roll V3 opens on a MIDI clip). Quantize STRENGTH: NO-V3-UI (the piano roll
//                       never had a strength control; the v2 Inspector did) - quantize_notes{strength}
//                       is kept through the store. Clip play-start offset: NO-V3-UI as a field; V3's
//                       left-edge trim sends trim_clip{offset} and is PORTed; the slide-inside-the-
//                       clip form is kept through the store.
//   crop-and-grid       Crop to range: NO-V3-UI (V3 has no time-range band, so nothing can ask for
//                       it); crop_clip is kept through the store. Grid: PORT for the division picker;
//                       "Auto" (snapAuto) has NO V3 control, so the store behaviour is asserted.
//   gesture-marquee     Marquee lasso and the Range tool: NO-V3-UI (v2 only; V3 has no empty-lane
//                       drag, no range band). A plain click on empty lane space clears the selection:
//                       PORT.
//   anchored-panel-     v2 useAnchoredPanel / MoshMenu only. V3 has no panel that dismisses on scroll;
//     scroll-race       the V3 equivalent (a menu opened in the same task as a scroll survives) is a
//                       cheap regression guard, PORT below.
//   arrange             ALREADY COVERED: drag move + right-edge trim + split (v3-timeline.spec.ts:35,
//                       :61), delete (v3-timeline.spec.ts:83, context menu; V3 has no Delete-key
//                       binding on a clip, so the key itself is NO-V3-UI).
//   smoke               ALREADY COVERED: boot + seeded Drums/Bass/Keys (v3-shell.spec.ts), File > New
//                       (v3-session.spec.ts:44), add audio/MIDI track + MIDI clip (v3-core-loop.spec.ts).

type Clip = { id: string; start: number; length: number; offset: number; type?: string; notes?: { start: number; pitch: number }[] };
type Trk = { id: string; name: string; clips: Clip[] };
type Res = { ok: boolean; error?: string; data?: Record<string, unknown> };
type St = { snapshot: { tracks: Trk[] }; exec: (c: string, a?: object) => Promise<Res>; snapDivision: string; snapAuto: boolean;
  setSnapAuto: (b: boolean) => void; setPxPerSec: (p: number) => void; effectiveSnapDivision: () => string; selectedClipIds?: string[]; selection?: unknown; editingClipId?: string };
type MoshWindow = Window & { __moshStore: { getState: () => St } };

const state = <T,>(page: Page, f: (s: St) => T) => page.evaluate((src) => (new Function("s", `return (${src})(s)`))((window as unknown as MoshWindow).__moshStore.getState()), f.toString()) as Promise<T>;
const tracks = (page: Page) => state(page, (s) => JSON.parse(JSON.stringify(s.snapshot.tracks)) as Trk[]);
const exec = (page: Page, command: string, args: object = {}) =>
  page.evaluate(([c, a]) => (window as unknown as MoshWindow).__moshStore.getState().exec(c as string, a as object), [command, args] as const);
const undo = (page: Page) => page.keyboard.press("ControlOrMeta+z");
const keysClip = async (page: Page) => (await tracks(page)).find((t) => t.name === "Keys")!.clips[0];
const trackCount = (page: Page) => page.getByTestId("v3-track").count();

// ── history jump ────────────────────────────────────────────────────────────
async function openHistory(page: Page) {
  const flyout = page.getByTestId("v3-history-flyout");
  if (await flyout.isVisible().catch(() => false)) return;
  await page.getByTestId("v3-history").click();
  await expect(flyout).toBeVisible();
}

test("jump_to_history: a History row restores to that point, counting transactions not rows", async ({ page }) => {
  await bootV3(page);
  const before = await trackCount(page);

  await page.getByTestId("v3-add-audio").click();
  await expect(page.getByTestId("v3-track")).toHaveCount(before + 1);
  // The non-undoable pair: two more LOG LINES, zero undo transactions. A panel that restored by
  // row position would undo three times here and delete a track the producer never touched.
  await page.getByTestId("v3-play").click();
  await page.getByTestId("v3-stop").click();
  await page.getByTestId("v3-add-audio").click();
  await expect(page.getByTestId("v3-track")).toHaveCount(before + 2);

  await openHistory(page);
  const flyout = page.getByTestId("v3-history-flyout");
  await expect(flyout).toContainText("set_transport");
  const restores = page.getByTestId("v3-history-undo");
  await expect(restores.first()).toBeVisible();
  const rows = await flyout.locator(".hist-row").count();
  expect(await restores.count()).toBeLessThan(rows);                         // the set_transport rows offer nothing

  await restores.first().click();
  await expectDispatched(page, "jump_to_history");
  await expect(page.getByTestId("v3-track")).toHaveCount(before + 1);       // one transaction back, not four rows

  // Reopened, the panel agrees with where the session now is, so the producer can walk forward again.
  await openHistory(page);
  await expect(flyout).toContainText("create_track");
  await expect(restores.first()).toBeVisible();
});

test("jump_to_history refuses an unknown point and leaves the session alone", async ({ page }) => {
  await bootV3(page);
  const before = await trackCount(page);
  expect((await exec(page, "jump_to_history", { txn: "" })).ok).toBe(false);
  expect((await exec(page, "jump_to_history", { txn: "someone-elses-session:7" })).ok).toBe(false);
  expect(await trackCount(page)).toBe(before);
});

// ── quantize ────────────────────────────────────────────────────────────────
async function addMidiClipAndOpenEditor(page: Page): Promise<{ clipId: string }> {
  await page.getByTestId("v3-add-midi").click();
  await page.getByTestId("v3-add-midi-clip").click();
  const clip = page.getByTestId("v3-clip").last();
  await expect(clip).toBeVisible();
  const clipId = (await clip.getAttribute("data-clip-id"))!;
  await clip.dblclick();
  await expect(page.getByTestId("piano-roll")).toBeVisible();
  return { clipId };
}
const noteStarts = async (page: Page, clipId: string) =>
  (await tracks(page)).flatMap((t) => t.clips).find((c) => c.id === clipId)!.notes!.map((n) => n.start);

test("quantize swing: the control is reachable, defaults to straight, and rides quantize_notes", async ({ page }) => {
  await bootV3(page);
  const { clipId } = await addMidiClipAndOpenEditor(page);
  expect((await exec(page, "add_note", { clipId, notes: [{ pitch: 60, start: 0.1, length: 0.25 }, { pitch: 62, start: 0.6, length: 0.25 }] })).ok).toBe(true);
  const raw = await noteStarts(page, clipId);

  const swing = page.getByTestId("pr-quantize-swing");
  await expect(swing).toBeVisible();
  await expect(swing).toHaveValue("0");                                      // 0 = straight, so the old behaviour is the default
  await expect(page.getByTestId("pr-quantize-swing-val")).toHaveText("straight");
  await swing.fill("60");
  await expect(page.getByTestId("pr-quantize-swing-val")).toHaveText("swing 60");

  await page.getByTestId("pr-quantize").click();
  await expectDispatched(page, "quantize_notes", { clipId, swing: 60 });     // swing is a term OF quantize, not a separate command
  await expect.poll(() => noteStarts(page, clipId)).not.toEqual(raw);       // the notes actually moved
  await undo(page);
  await expect.poll(() => noteStarts(page, clipId)).toEqual(raw);           // one undo
});

// NO-V3-UI: the piano roll has no strength control (the v2 Inspector had one).
test("quantize_notes{strength} moves notes part of the way, and full strength lands them on the grid (NO-V3-UI)", async ({ page }) => {
  await bootV3(page);
  const { clipId } = await addMidiClipAndOpenEditor(page);
  expect((await exec(page, "add_note", { clipId, pitch: 60, start: 0.1, length: 0.25 })).ok).toBe(true);
  expect((await noteStarts(page, clipId))[0]).toBeCloseTo(0.1, 5);

  expect((await exec(page, "quantize_notes", { clipId, division: 0.5, strength: 0.5 })).ok).toBe(true);
  expect((await noteStarts(page, clipId))[0]).toBeCloseTo(0.05, 5);          // halfway to the grid line at 0
  expect((await exec(page, "quantize_notes", { clipId, division: 0.5 })).ok).toBe(true);   // default strength is full
  expect((await noteStarts(page, clipId))[0]).toBeCloseTo(0, 5);
  expect((await exec(page, "quantize_notes", { clipId: "no-such-clip", division: 0.5 })).ok).toBe(false);
});

// ── clip play-start offset ──────────────────────────────────────────────────
test("trimming the left edge slides the source under the boundary: trim_clip carries a larger offset", async ({ page }) => {
  await bootV3(page);
  const before = await keysClip(page);
  const clip = page.locator('[data-testid="v3-track"]').filter({ hasText: "Keys" }).getByTestId("v3-clip").first();
  const b = (await clip.boundingBox())!;
  const y = b.y + b.height / 2;
  await page.mouse.move(b.x + 3, y);                                         // inside the left edge-grab band
  await page.mouse.down();
  await page.mouse.move(b.x + 3 + 80, y, { steps: 12 });                     // +1 s at the default zoom
  await page.mouse.up();

  await expectDispatched(page, "trim_clip", { clipId: before.id });
  await expect.poll(async () => (await keysClip(page)).start).toBeGreaterThan(before.start);
  const after = await keysClip(page);
  expect(after.offset).toBeGreaterThan(before.offset);                       // the audio under the boundary did not move
  expect(after.start + after.length).toBeCloseTo(before.start + before.length, 5);   // the right edge stayed put
  await undo(page);
  await expect.poll(async () => (await keysClip(page)).start).toBe(before.start);
  expect((await keysClip(page)).offset).toBe(before.offset);
});

// NO-V3-UI: the v2 Inspector's "play-start offset" field.
test("trim_clip{offset} alone slides the audio inside a clip without moving it (NO-V3-UI)", async ({ page }) => {
  await bootV3(page);
  const before = await keysClip(page);
  const clipEl = page.locator(`[data-clip-id="${before.id}"]`);
  const x0 = (await clipEl.boundingBox())!.x;

  expect((await exec(page, "trim_clip", { clipId: before.id, offset: 0.25 })).ok).toBe(true);
  const after = await keysClip(page);
  expect(after.offset).toBe(0.25);
  expect(after.start).toBe(before.start);
  expect(after.length).toBe(before.length);
  await expect.poll(async () => (await clipEl.boundingBox())!.x).toBeCloseTo(x0, 0);   // the clip did NOT move
  await undo(page);
  await expect.poll(async () => (await keysClip(page)).offset).toBe(before.offset);
});

// ── crop to range ───────────────────────────────────────────────────────────
// NO-V3-UI: V3 has no time-range band to crop to.
test("crop_clip trims a straddling clip to the range in one undo step, and refuses the degenerate cases (NO-V3-UI)", async ({ page }) => {
  await bootV3(page);
  const before = await keysClip(page);                                       // seed: start 2 s, length 6 s
  const start = before.start + 1, end = before.start + before.length - 2;

  expect((await exec(page, "crop_clip", { clipIds: [before.id], start, end })).ok).toBe(true);
  const after = await keysClip(page);
  expect(after.start).toBeCloseTo(start, 5);
  expect(after.start + after.length).toBeCloseTo(end, 5);
  await expect.poll(async () => clipNum(page.locator(`[data-clip-id="${before.id}"]`), "data-clip-start")).toBeCloseTo(start, 5);   // the lane follows

  await undo(page);                                                          // one undo restores the whole clip
  await expect.poll(async () => (await keysClip(page)).length).toBe(before.length);
  expect((await keysClip(page)).start).toBe(before.start);

  // Refused without touching anything: an inverted range, a range past the clip, a range that covers it.
  const len = (await keysClip(page)).length;
  expect((await exec(page, "crop_clip", { clipIds: [before.id], start: end, end: start })).ok).toBe(false);
  expect((await exec(page, "crop_clip", { clipIds: [before.id], start: 100, end: 110 })).ok).toBe(false);
  expect((await exec(page, "crop_clip", { clipIds: [before.id], start: 0, end: 100 })).ok).toBe(false);
  expect((await exec(page, "crop_clip", { clipIds: [] , start, end })).ok).toBe(false);
  expect((await keysClip(page)).length).toBe(len);
});

// ── grid / snap ─────────────────────────────────────────────────────────────
test("the Grid picker sets the snap division the clips and playhead snap to", async ({ page }) => {
  await bootV3(page);
  const sel = page.getByLabel("Grid", { exact: true });
  await expect(sel).toBeVisible();
  await expect(sel).toHaveValue("1/4");
  await sel.selectOption("1/8");
  await expect(sel).toHaveValue("1/8");
  expect(await state(page, (s) => s.snapDivision)).toBe("1/8");
  expect(await state(page, (s) => s.snapAuto)).toBe(false);                  // a concrete division is never "auto"
});

// NO-V3-UI: V3's picker has no Auto entry; the store behaviour behind it is kept.
test("snapAuto picks a FINER division as you zoom in, and choosing a concrete division turns it off (NO-V3-UI)", async ({ page }) => {
  await bootV3(page);
  await page.evaluate(() => (window as unknown as MoshWindow).__moshStore.getState().setSnapAuto(true));
  expect(await state(page, (s) => s.snapAuto)).toBe(true);

  const effectiveAt = (pps: number) => page.evaluate((p) => {
    const st = (window as unknown as MoshWindow).__moshStore.getState();
    st.setPxPerSec(p);
    return (window as unknown as MoshWindow).__moshStore.getState().effectiveSnapDivision();
  }, pps);
  const order = ["bar", "1/4", "1/8", "1/16", "1/32"];
  const wide = await effectiveAt(25);
  const tight = await effectiveAt(400);
  expect(order.indexOf(tight)).toBeGreaterThan(order.indexOf(wide));         // the same setting yields different grids at different zooms

  await page.getByLabel("Grid", { exact: true }).selectOption("1/16");
  expect(await state(page, (s) => s.snapAuto)).toBe(false);
});

// ── empty-lane gestures ─────────────────────────────────────────────────────
test("a plain click on empty lane space clears the clip selection (DESELECT)", async ({ page }) => {
  await bootV3(page);
  const keys = page.locator('[data-testid="v3-track"]').filter({ hasText: "Keys" });
  const clip = keys.getByTestId("v3-clip").first();
  await clip.click();
  await expect(clip).toHaveAttribute("aria-pressed", "true");

  const lane = keys.locator(".lane");
  const lb = (await lane.boundingBox())!;
  const cb = (await clip.boundingBox())!;
  await page.mouse.click(cb.x + cb.width + 100, lb.y + lb.height / 2);       // empty space to the right of the clip
  await expect(clip).toHaveAttribute("aria-pressed", "false");
});

// ── anchored panel vs the scroll its own click caused ───────────────────────
test("a menu opened in the same task as a scroll survives the scroll", async ({ page }) => {
  await bootV3(page);
  await page.evaluate(() => {
    const sc = document.querySelector(".v3-shell .tracks") as HTMLElement | null;
    if (sc) { if (sc.scrollHeight > sc.clientHeight) sc.scrollTop += 20; else if (sc.scrollWidth > sc.clientWidth) sc.scrollLeft += 20; }
    // ...and open the menu synchronously, before the queued scroll event is delivered.
    (document.querySelector('[data-testid="v3-file-trigger"]') as HTMLButtonElement).click();
  });
  await page.evaluate(() => document.dispatchEvent(new Event("scroll")));   // and one delivered after it is open
  await page.waitForTimeout(150);
  await expect(page.getByTestId("v3-open-settings")).toBeVisible();
});
