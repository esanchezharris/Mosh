import { test, expect } from "@playwright/test";
import { bootV3, clipNum, dragClipBy, trimClipRightBy } from "./helpers";

// V3 parity brief row 11 — zoom on the shared pxPerSec, and pointer move / trim / split through
// the same gesture table, drag commit and command seam v2 uses. At 120 BPM the default snap
// grid is a beat = 0.5 s, and 80 px = 1 s at the default zoom.

type MoshWindow = Window & { __moshStore?: { getState: () => { pxPerSec: number; snapshot?: { session: { length?: number } } } } };
const pxPerSec = (page: Parameters<typeof bootV3>[0]) =>
  page.evaluate(() => (window as unknown as MoshWindow).__moshStore!.getState().pxPerSec);

const chords = (page: Parameters<typeof bootV3>[0]) =>
  page.locator('[data-testid="v3-track"]').filter({ hasText: "Keys" }).getByTestId("v3-clip").first();

test("zoom in / out scales the lanes on the shared pxPerSec and the ruler follows", async ({ page }) => {
  await bootV3(page);
  expect(await pxPerSec(page)).toBe(80);
  const clip = chords(page);
  const before = (await clip.boundingBox())!;
  expect(Math.round(before.width)).toBe(480);                              // 6 s × 80 px (anti-vacuity)

  await page.getByTestId("v3-zoom-in").click();
  await expect.poll(() => pxPerSec(page)).toBe(100);
  await expect(page.getByTestId("v3-arrangement")).toHaveAttribute("data-px-per-sec", "100");
  await expect.poll(async () => Math.round((await clip.boundingBox())!.width)).toBe(600);
  expect(Math.round((await clip.boundingBox())!.x - before.x)).toBe(40);   // start 2 s: 160 → 200 px
  const sessionSec = await page.evaluate(() => (window as unknown as MoshWindow).__moshStore!.getState().snapshot!.session.length ?? 32);
  await expect(page.getByTestId("v3-ruler")).toHaveCSS("width", `${Math.ceil(sessionSec * 100)}px`);   // the whole session at this zoom

  await page.getByTestId("v3-zoom-out").click();
  await expect.poll(() => pxPerSec(page)).toBe(80);
  await expect.poll(async () => Math.round((await clip.boundingBox())!.width)).toBe(480);
});

test("pointer move and trim commit through move_clip / trim_clip and undo one step each", async ({ page }) => {
  await bootV3(page);
  const clip = chords(page);
  expect(await clipNum(clip, "data-clip-start")).toBe(2);
  expect(await clipNum(clip, "data-clip-length")).toBe(6);

  await dragClipBy(page, clip, 80);                                          // +1 s, on the beat grid
  await expect.poll(() => clipNum(clip, "data-clip-start")).toBe(3);
  await page.keyboard.press("ControlOrMeta+z");
  await expect.poll(() => clipNum(clip, "data-clip-start")).toBe(2);

  await trimClipRightBy(page, clip, -80);                                    // −1 s from the right edge
  await expect.poll(() => clipNum(clip, "data-clip-length")).toBe(5);
  expect(await clipNum(clip, "data-clip-start")).toBe(2);                    // a right trim keeps the start
  await page.keyboard.press("ControlOrMeta+z");
  await expect.poll(() => clipNum(clip, "data-clip-length")).toBe(6);
});

test("Split here in the context menu splits at the pointer's snapped time and one undo rejoins", async ({ page }) => {
  await bootV3(page);
  const keys = page.locator('[data-testid="v3-track"]').filter({ hasText: "Keys" });
  const clips = keys.getByTestId("v3-clip");
  await expect(clips).toHaveCount(1);
  const b = (await clips.first().boundingBox())!;
  await page.mouse.click(b.x + b.width / 2, b.y + b.height / 2, { button: "right" });
  await page.getByTestId("v3-context-split").click();
  await expect(clips).toHaveCount(2);
  expect(await clipNum(clips.nth(0), "data-clip-length")).toBe(3);          // 2 → 5 s
  expect(await clipNum(clips.nth(1), "data-clip-start")).toBe(5);
  await page.keyboard.press("ControlOrMeta+z");
  await expect(clips).toHaveCount(1);
});

// ── playhead, ruler seek, sections (2026-09-21) ─────────────────────────────────────────
type TransportWindow = Window & { __moshStore?: { getState: () => {
  pxPerSec: number; setPxPerSec: (v: number) => void; transport: { position: number };
  exec: (c: string, a?: Record<string, unknown>) => Promise<unknown>;
} } };
const position = (page: Parameters<typeof bootV3>[0]) =>
  page.evaluate(() => (window as unknown as TransportWindow).__moshStore!.getState().transport.position);
const seek = (page: Parameters<typeof bootV3>[0], sec: number) =>
  page.evaluate((s) => (window as unknown as TransportWindow).__moshStore!.getState().exec("set_transport", { position: s }), sec);

test("the playhead line follows the transport on the shared zoom, and the ruler seeks on click", async ({ page }) => {
  await bootV3(page);
  const playhead = page.getByTestId("v3-playhead");
  const marker = page.getByTestId("v3-ruler-marker");
  const lane = page.locator('[data-testid="v3-track"]').first().locator(".lane");
  const laneX = (await lane.boundingBox())!.x + 1;                       // lane CONTENT starts inside its 1 px border (where clips and grid marks are)
  // The line is 2 px wide, centred on the position (margin-left −1): x + 1 is the position.
  const headPx = async () => Math.round((await playhead.boundingBox())!.x + 1 - laneX);
  expect(await headPx()).toBe(0);                                             // parked at 0
  await seek(page, 2);
  await expect.poll(headPx).toBe(160);                                        // 2 s × 80 px
  await expect.poll(async () => Math.round((await marker.boundingBox())!.x + 5 - laneX)).toBe(160);   // the ruler marker agrees
  await page.getByTestId("v3-zoom-in").click();
  await expect.poll(headPx).toBe(200);                                        // 2 s × 100 px — zoom moves it
  await page.getByTestId("v3-zoom-out").click();
  await expect.poll(headPx).toBe(160);

  // Ruler click → seek on the beat grid (0.5 s at 120 BPM): bar 3 starts at 4 s = 320 px.
  const ruler = page.getByTestId("v3-ruler");
  await ruler.click({ position: { x: 320 + 3, y: 10 } });
  await expect.poll(() => position(page)).toBe(4);
  await expect.poll(headPx).toBe(320);

  // Under 14 px per beat cell the ruler drops its ".2 .3 .4" labels (bars stay). The lane never
  // narrows below the viewport, so the 16 s seed needs more beats to get there: 400 BPM makes
  // 107 cells, and at 20 px/s they are ~10 px each.
  await expect(ruler).toHaveAttribute("data-beat-labels", "1");
  await page.evaluate(async () => {
    const st = (window as unknown as TransportWindow).__moshStore!.getState();
    await st.exec("set_tempo", { bpm: 400 }); st.setPxPerSec(20);
  });
  await expect(ruler).toHaveAttribute("data-beat-labels", "0");
  await expect(ruler.locator(".rn.bar").first()).toHaveText("1");
  await expect(ruler.locator(".rn.beat")).toHaveCount(0);
});

test("sections render over the ruler from the snapshot and a click jumps the transport there", async ({ page }) => {
  await bootV3(page);
  const secs = page.getByTestId("v3-section");
  await expect(secs).toHaveCount(3);                                          // the seed's Intro / Verse / Hook
  await expect(secs.nth(0)).toHaveText("Intro");
  await expect(secs.nth(1)).toHaveText("Verse");
  const intro = (await secs.nth(0).boundingBox())!;
  const verse = (await secs.nth(1).boundingBox())!;
  expect(Math.round(intro.width)).toBe(320);                                  // 8 beats × 0.5 s × 80 px
  expect(Math.round(verse.width)).toBe(640);                                  // 16 beats
  expect(Math.round(verse.x - intro.x)).toBe(320);                            // Verse starts where Intro ends
  const lane = page.locator('[data-testid="v3-track"]').first().locator(".lane");
  expect(Math.round(intro.x - ((await lane.boundingBox())!.x + 1))).toBe(0);  // the strip sits on the lane scale (content origin, inside the border)
  await secs.nth(1).click();
  await expect.poll(() => position(page)).toBe(4);                            // beat 8 at 120 BPM
  await expect.poll(async () => Math.round((await page.getByTestId("v3-playhead").boundingBox())!.x + 1 - ((await lane.boundingBox())!.x + 1))).toBe(320);
});

test("mute and solo state are visible on the track header, and a muted lane sits back", async ({ page }) => {
  await bootV3(page);
  const keys = page.locator('[data-testid="v3-track"]').filter({ hasText: "Keys" });
  const mute = keys.getByRole("button", { name: "Mute" });
  await expect(mute).toHaveAttribute("aria-pressed", "false");
  const before = await mute.evaluate((el) => getComputedStyle(el).backgroundColor);
  await mute.click();
  await expect(mute).toHaveAttribute("aria-pressed", "true");
  await expect(keys).toHaveAttribute("data-mute", "true");
  await expect.poll(() => mute.evaluate((el) => getComputedStyle(el).backgroundColor)).not.toBe(before);   // the lit state is painted
  await expect(keys.locator(".lane")).toHaveCSS("opacity", "0.55");
  await page.keyboard.press("ControlOrMeta+z");
  await expect(mute).toHaveAttribute("aria-pressed", "false");
  await expect(keys).not.toHaveAttribute("data-mute", "true");
});

test("one grid: lane marks, ruler ticks and the playhead share pixel columns; it shows through clips", async ({ page }) => {
  await bootV3(page);
  const lane = page.locator('[data-testid="v3-track"]').filter({ hasText: "Keys" }).locator(".lane");
  const mark = (beat: number) => lane.locator(`[data-testid="v3-lane-grid"] i[data-beat="${beat}"]`);
  const tick = (beat: number) => page.locator(`[data-testid="v3-ruler"] .tick[data-beat="${beat}"]`);
  const x = async (l: ReturnType<typeof mark>) => (await l.boundingBox())!.x;
  const clip = chords(page);
  // 120 BPM at 80 px/s: a beat is 40 px. The 2 s clip starts exactly on beat 4's mark.
  expect(await x(mark(4)) - await x(mark(0))).toBeCloseTo(160, 1);
  expect(await x(clip)).toBeCloseTo(await x(mark(4)), 1);
  expect(await x(tick(4))).toBeCloseTo(await x(mark(4)), 1);               // the ruler lines up with the lanes
  expect(await x(tick(0))).toBeCloseTo(await x(mark(0)), 1);
  await seek(page, 2);                                                      // the playhead sits on beat 4 too
  await expect.poll(async () => { const b = (await page.getByTestId("v3-playhead").boundingBox())!; return Math.abs(b.x + b.width / 2 - (await x(mark(4)) + 0.5)); }).toBeLessThan(0.6);
  // Clips draw no grid of their own; their body is translucent so the lane's marks show through
  // (Ableton-style) — the same marks, so they cannot drift.
  await expect(page.locator('[data-testid="v3-clip"] line')).toHaveCount(0);
  const clipAlpha = await clip.evaluate((el) => {
    const c = document.createElement("canvas"); c.width = c.height = 1; const g = c.getContext("2d")!;
    g.fillStyle = getComputedStyle(el).backgroundColor; g.fillRect(0, 0, 1, 1); return g.getImageData(0, 0, 1, 1).data[3];
  });
  expect(clipAlpha).toBeLessThan(64);
  // No visible lane edge (it read as a double line next to the clip border, lime when selected).
  await page.getByRole("button", { name: "Select track Keys" }).click();
  await expect(lane).toHaveCSS("border-top-color", "rgba(0, 0, 0, 0)");
  await expect(lane).toHaveCSS("border-bottom-color", "rgba(0, 0, 0, 0)");
  // Beat marks at 40 px, bar marks every bar; marks are 1 px and on device pixels.
  await expect(lane.locator('[data-testid="v3-lane-grid"] i.beat').first()).toBeAttached();
  expect((await mark(4).boundingBox())!.width).toBe(1);
  // Zoomed out to 20 px/s a beat is 10 px: beat marks and beat labels go, bars thin to every 2nd (40 px bars).
  await page.evaluate(() => (window as unknown as TransportWindow).__moshStore!.getState().setPxPerSec(20));
  await expect(lane.locator('[data-testid="v3-lane-grid"] i.beat')).toHaveCount(0);
  await expect(page.getByTestId("v3-ruler")).toHaveAttribute("data-beat-labels", "0");
  await expect(mark(4)).toHaveCount(0);                                     // bar 2 is skipped…
  await expect(mark(8)).toHaveCount(1);                                     // …bar 3 is kept
  await expect(page.locator('[data-testid="v3-ruler"] .rn.bar').nth(1)).toHaveText("3");
  expect(await x(tick(8))).toBeCloseTo(await x(mark(8)), 1);
});

test("one hairline separates adjacent tracks, centred in the gap between rows", async ({ page }) => {
  await bootV3(page);
  const rows = page.locator('[data-testid="v3-track"]');
  const sep = (i: number) => rows.nth(i).evaluate((el) => {
    const cs = getComputedStyle(el, "::before");
    return { content: cs.content, height: cs.height, top: cs.top };
  });
  expect((await sep(0)).content).toBe("none");                   // nothing above the first track
  const s1 = await sep(1);
  expect(s1.content).not.toBe("none");
  expect(s1.height).toBe("1px");
  // Centred in the 5 px gap: the line sits between the previous row's bottom and this row's top.
  const [a, b] = [(await rows.nth(0).boundingBox())!, (await rows.nth(1).boundingBox())!];
  const lineY = b.y + parseFloat(s1.top);
  expect(lineY).toBeGreaterThan(a.y + a.height);
  expect(lineY + 1).toBeLessThanOrEqual(b.y);
  // Nothing else in the gap: every lane is exactly its row's height (a global `.lane` height rule
  // once made lanes 4 px taller, so their grid marks poked out under the sticky headers).
  for (let i = 0; i < 3; i++) {
    const [row, lane] = [(await rows.nth(i).boundingBox())!, (await rows.nth(i).locator(".lane").boundingBox())!];
    expect(lane.height).toBe(row.height);
  }
});

test("the corner left of the ruler holds the timeline's grid, snap and zoom controls", async ({ page }) => {
  await bootV3(page);
  const corner = page.getByTestId("v3-timeline-corner");
  await expect(corner).toBeVisible();
  // The controls live here now, not in the top bar.
  await expect(corner.getByTestId("v3-zoom-in")).toBeVisible();
  await expect(corner.getByTestId("v3-zoom-out")).toBeVisible();
  await expect(page.getByTestId("v3-topbar").getByRole("button", { name: "Snap" })).toHaveCount(0);
  // It sits exactly over the track headers, so the ruler still starts where lane content does.
  const [c, hd] = [(await corner.boundingBox())!, (await page.locator('[data-testid="v3-track"] .hd').first().boundingBox())!];
  expect(Math.round(c.x)).toBe(Math.round(hd.x));
  expect(Math.round(c.width)).toBe(Math.round(hd.width));
  // Grid division: a real control over the store's snapDivision (1/4 by default).
  type W = Window & { __moshStore?: { getState: () => { snap: boolean; snapDivision: string } } };
  const st = () => page.evaluate(() => { const s = (window as unknown as W).__moshStore!.getState(); return { snap: s.snap, div: s.snapDivision }; });
  const grid = corner.getByRole("combobox", { name: "Grid" });
  await expect(grid).toHaveValue("1/4");
  await grid.selectOption("1/8");
  await expect.poll(async () => (await st()).div).toBe("1/8");
  const snap = corner.getByRole("button", { name: "Snap" });
  await expect(snap).toHaveAttribute("aria-pressed", "true");
  await snap.click();
  await expect.poll(async () => (await st()).snap).toBe(false);
  await expect(snap).toHaveAttribute("aria-pressed", "false");
  // Zoom from the corner moves the shared zoom.
  await corner.getByTestId("v3-zoom-in").click();
  await expect(page.getByTestId("v3-arrangement")).toHaveAttribute("data-px-per-sec", "100");
});
