import { test, expect } from "@playwright/test";
import { bootV2 } from "./helpers";

// A mouse-only producer's actual path: make an instrument track, discover it has no
// synth, and pick one — no keyboard, no agent. This is the end-to-end proof for the
// LANE_NEW gesture wiring: the resolveLaneNew planner, the picker pre-filter, the lane
// menu, and the Inspector's pinned instrument slot are all covered piecemeal by unit
// tests (T1-T7) — this file is the only place that drives them through real pointer
// events on the actual DOM, the way a mouse-only user would.
//
// No newProject() here: that drives the CLASSIC shell's File menu ("File" button),
// which v2 does not render at all (v2's equivalent, if any, is the SessionPicker's
// "New" button, testid v2-picker-new — but the picker doesn't appear against the e2e
// mock backend, matching every other bootV2-only spec in this suite). bootV2's fresh
// page load already gives a deterministic seeded session.
test.beforeEach(async ({ page }) => {
  await bootV2(page);
  await page.getByTestId("v2-track-add").click();
  await page.getByTestId("v2-track-add-midi").click();
});

test("empty-lane double-click on a bare track offers instrument vs audio", async ({ page }) => {
  const lane = page.getByTestId("v2-lane").last();
  await expect(lane).toBeVisible();
  await lane.dblclick({ position: { x: 300, y: 20 } });
  await expect(page.getByTestId("v2-lane-menu")).toBeVisible();
  await expect(page.getByTestId("lane-add-instrument")).toHaveText("Add instrument…");
  await page.getByTestId("lane-add-instrument").click();
  // The drawer opens on the plugins tab, pre-filtered to Instruments.
  await expect(page.getByTestId("v2-plugin-dock")).toBeVisible();
});

test("the Inspector FX tab shows an empty instrument slot on a bare track", async ({ page }) => {
  // store.ts's refresh() only reassigns selectedTrackId when the current one no longer
  // exists in the snapshot, so bootV2's seeded first track stays selected even after
  // beforeEach creates the new bare Instrument track. Select it explicitly, or the
  // Inspector below (and this whole test) would silently be looking at the wrong track.
  const lane = page.getByTestId("v2-lane").last();
  const trackId = await lane.getAttribute("data-track-id");
  const header = page.locator(`[data-testid="v2-track-header"][data-track-id="${trackId}"]`);
  await header.click();
  await expect(page.getByTestId("v2-inspector")).toContainText("Inspector · Instrument");
  await page.getByTestId("v2-insp-tab-fx").click();
  await expect(page.getByTestId("instslot-choose")).toBeVisible();
});

// Covers wiring behaviour #2 (setSelectedTrack fires before any picker opens): double-
// clicking a specific lane must select THAT track, not leave whatever was selected
// before. bootV2's seeded session already has at least one track before this suite's
// beforeEach adds the Instrument track, so if the wrong lane's gesture handler fired
// (or fired on the wrong track), the header for that pre-existing track — not the
// Instrument track this test targets — would end up selected instead.
test("double-clicking a lane selects that lane's track, not whatever was selected before", async ({ page }) => {
  const laneCount = await page.getByTestId("v2-lane").count();
  expect(laneCount).toBeGreaterThan(1); // bootV2 seeds at least one track before beforeEach adds the Instrument track
  const lastLane = page.getByTestId("v2-lane").last();
  const wantTrackId = await lastLane.getAttribute("data-track-id");
  await lastLane.dblclick({ position: { x: 300, y: 20 } });
  await expect(page.getByTestId("v2-lane-menu")).toBeVisible();
  await page.keyboard.press("Escape"); // close the menu without mutating state
  await expect(page.getByTestId("v2-lane-menu")).toHaveCount(0);
  const header = page.locator(`[data-testid="v2-track-header"][data-track-id="${wantTrackId}"]`);
  await expect(header).toHaveAttribute("aria-pressed", "true");
});

// Covers wiring behaviour #3 (the snapped `start` shared by both the direct-clip and
// the menu path): right-clicking mid-lane, then choosing "Add MIDI clip" from the menu,
// must land the clip where the pointer was — not at bar 1. v2's ClipView carries no
// data-clip-start attribute (that's a classic-shell-only testid — see helpers.ts's
// clipNum, which reads it off the CLASSIC clip), so the clip's actual `start` is read
// out of the store via the dev-only window.__moshStore handle (same handle
// piano-roll.spec.ts uses).
test("the lane menu's Add MIDI clip lands at the snapped pointer position, not bar 1", async ({ page }) => {
  const lane = page.getByTestId("v2-lane").last();
  const trackId = await lane.getAttribute("data-track-id");
  await lane.click({ position: { x: 600, y: 20 }, button: "right" });
  await expect(page.getByTestId("v2-lane-menu")).toBeVisible();
  await page.getByTestId("lane-add-midi-clip").click();
  const clip = lane.locator("[data-clip-id]").first();
  await expect(clip).toBeVisible();
  const clipId = await clip.getAttribute("data-clip-id");
  const start = await page.evaluate(
    ({ trackId, clipId }) => {
      const store = (window as unknown as { __moshStore: { getState: () => { snapshot: { tracks: { id: string; clips: { id: string; start: number }[] }[] } } } }).__moshStore;
      const track = store.getState().snapshot.tracks.find((t) => t.id === trackId);
      return track?.clips.find((c) => c.id === clipId)?.start;
    },
    { trackId, clipId },
  );
  expect(start).toBeGreaterThan(0); // bar 1 (start 0) would mean the menu path ignored the pointer
});

test("double-clicking a MIDI clip opens the piano roll, not the lane menu", async ({ page }) => {
  const lane = page.getByTestId("v2-lane").last();
  // The Instrument track lands BARE after Task 7, so make a clip explicitly first.
  await lane.dblclick({ position: { x: 300, y: 20 } });
  await page.getByTestId("lane-add-midi-clip").click();
  const clip = lane.locator("[data-clip-id]").first();
  await expect(clip).toBeVisible();
  await clip.dblclick();
  // The e.target === e.currentTarget guard is what keeps this from being treated as an
  // empty-lane gesture (which — because add_midi_clip's DRM-001 policy has, by this
  // point, loaded a default instrument onto the track — would silently add a SECOND,
  // redundant clip at the click position instead of opening the piano roll).
  await expect(page.getByTestId("piano-roll")).toBeVisible();
  await expect(lane.locator("[data-clip-id]")).toHaveCount(1);
});

// Final-review finding 4: the HEADLINE gesture — double-clicking an empty lane on a
// track that already carries an instrument lands a clip immediately, no menu — was
// exercised by NO test at any layer. laneGesture.test.ts never mounts the handler that
// runs it, and every other case in this file drives only the {kind:"menu"} branch (a
// bare track). A wrong or missing trackId in that direct `exec("add_midi_clip", ...)`
// call would land the clip on tracks[0] in the mock and on some other track natively —
// this test is the only place that would catch it.
test("double-clicking an instrument-bearing lane a second time lands a clip directly on THAT track, with no menu", async ({ page }) => {
  const lane = page.getByTestId("v2-lane").last();
  const trackId = await lane.getAttribute("data-track-id");

  // bootV2's seeded tracks (Drums/Bass/Keys) already carry clips of their own — capture
  // the OTHER tracks' total before touching anything, so the post-assertion is "this
  // test added nothing elsewhere", not the wrong claim "every other track has zero".
  const otherTracksClipCountBefore = await page.evaluate((wantId) => {
    const store = (window as unknown as {
      __moshStore: { getState: () => { snapshot: { tracks: { id: string; clips: unknown[] }[] } } };
    }).__moshStore;
    return store.getState().snapshot.tracks
      .filter((t) => t.id !== wantId)
      .reduce((sum, t) => sum + t.clips.length, 0);
  }, trackId);

  // Give the track a real instrument the same way the piano-roll test above does: land
  // the first clip via the bare-track menu, which trips DRM-001's default-instrument
  // load in the same transaction. One clip, one instrument, same as any producer's
  // actual first click-through.
  await lane.dblclick({ position: { x: 200, y: 20 } });
  await page.getByTestId("lane-add-midi-clip").click();
  const firstClip = lane.locator("[data-clip-id]").first();
  await expect(firstClip).toBeVisible();
  await expect(lane.locator("[data-clip-id]")).toHaveCount(1);

  // Double-click a DIFFERENT x on the SAME lane, clear of the first clip so the hit
  // lands on the empty lane (e.target === e.currentTarget), not on the clip itself.
  const firstBox = (await firstClip.boundingBox())!;
  const laneBox = (await lane.boundingBox())!;
  const secondX = Math.round(firstBox.x + firstBox.width - laneBox.x) + 80;

  await lane.dblclick({ position: { x: secondX, y: 20 } });

  // (c) no menu — the track already carries an instrument, so resolveLaneNew resolves
  // straight to {kind:"clip"} and the direct exec("add_midi_clip", ...) branch fires.
  await expect(page.getByTestId("v2-lane-menu")).toHaveCount(0);
  // (a) a second clip appears
  await expect(lane.locator("[data-clip-id]")).toHaveCount(2);

  // (b) both clips belong to THIS track, not tracks[0] or any other track — the
  // failure mode a wrong/omitted trackId in the direct branch would produce. Every
  // other track's clip count must be EXACTLY what it was before this test touched
  // anything (bootV2's seeded tracks already carry their own clips).
  const otherTracksClipCountAfter = await page.evaluate((wantId) => {
    const store = (window as unknown as {
      __moshStore: { getState: () => { snapshot: { tracks: { id: string; clips: unknown[] }[] } } };
    }).__moshStore;
    return store.getState().snapshot.tracks
      .filter((t) => t.id !== wantId)
      .reduce((sum, t) => sum + t.clips.length, 0);
  }, trackId);
  expect(otherTracksClipCountAfter).toBe(otherTracksClipCountBefore);
});
