import { test, expect, type Page } from "@playwright/test";
import { bootLive } from "./helpers";

// E2E for the LIVE clone shell (ui/src/live — the Live 12 Arrangement-View clone,
// docs/live-clone/SPEC.md), driven via the dev `?shell=live` override against the
// in-memory mock backend — the same contract the native engine exposes. Covers the
// SPEC's zone model: control bar (28pt) · two-column browser · lanes with RIGHT-side
// track headers · detail dock placeholder · status bar.

// The store handle, for asserting UI-local state the DOM doesn't carry (editingClipId)
// or that only the snapshot reports (transport flags, rack contents). Dot-path read.
async function storeVal<T>(page: Page, path: string): Promise<T> {
  return page.evaluate(
    (p) => p.split(".").reduce((o: unknown, k) => (o as Record<string, unknown>)?.[k],
      (window as unknown as { __moshStore: { getState: () => unknown } }).__moshStore.getState()),
    path,
  ) as Promise<T>;
}

test("boots the zone model: control bar, browser, lanes, RIGHT headers, status bar", async ({ page }) => {
  await bootLive(page);
  await expect(page.getByTestId("live-controlbar")).toBeVisible();
  await expect(page.getByTestId("live-browser")).toBeVisible();
  await expect(page.getByTestId("live-arrangement")).toBeVisible();
  await expect(page.getByTestId("live-statusbar")).toBeVisible();
  // the mock's seed session: 3 tracks, 3 lanes, 3 RIGHT-side headers
  await expect(page.getByTestId("live-track-header")).toHaveCount(3);
  await expect(page.getByTestId("live-lane")).toHaveCount(3);
  // with no clip open, the dock shows the selected track's DEVICES view (Live's
  // device-view half) — the seed tracks carry no plugins, so the empty state shows
  await expect(page.getByTestId("live-dock")).toBeVisible();
  await expect(page.getByTestId("live-devices")).toContainText("No devices");
});

test("a new empty project keeps both arrangement rulers and advances one epoch", async ({ page }) => {
  await bootLive(page);
  const epochBefore = await storeVal<number>(page, "projectEpoch");
  await page.evaluate(async () => {
    await (window as any).__moshStore.getState().exec("new_project", { name: "empty-ruler-e2e" });
  });

  await expect.poll(() => storeVal<number>(page, "projectEpoch")).toBe(epochBefore + 1);
  await expect(page.getByTestId("live-lane")).toHaveCount(0);
  await expect(page.getByTestId("live-track-header")).toHaveCount(0);
  await expect(page.getByTestId("live-ruler")).toBeVisible();
  await expect(page.getByTestId("live-time-ruler")).toBeVisible();
  await expect(page.getByRole("status")).toContainText("No tracks yet");
  await page.getByRole("button", { name: "Add track" }).click();
  await page.getByTestId("live-track-add-audio").click();
  await expect.poll(() => commandLog(page, 10)).toContain("create_track");
  await expect(page.getByTestId("live-lane")).toHaveCount(1);
  await expect(page.getByTestId("live-ruler")).toBeVisible();
  await expect(page.getByTestId("live-time-ruler")).toBeVisible();
});

test("track headers sit on the RIGHT of the lanes (Live's signature)", async ({ page }) => {
  await bootLive(page);
  // The lane element itself spans the whole (horizontally scrolling) content, so the
  // honest comparison is the scroll VIEWPORT's right edge: the header column starts
  // where the visible lane area ends.
  const viewport = await page.getByTestId("live-timeline").boundingBox();
  const lane = await page.getByTestId("live-lane").first().boundingBox();
  const clip = await page.locator('.live-shell [data-testid="v2-clip"]').first().boundingBox();
  const header = await page.getByTestId("live-track-header").first().boundingBox();
  if (!viewport || !lane || !clip || !header) throw new Error("missing bounds");
  expect(header.x).toBeGreaterThan(clip.x);
  expect(header.x).toBeGreaterThanOrEqual(viewport.x + viewport.width - 1);
  // …and it is the same row: header and lane tops align.
  expect(Math.abs(header.y - lane.y)).toBeLessThanOrEqual(2);
});

test("transport: play/stop drive the store's transport", async ({ page }) => {
  await bootLive(page);
  const transport = page.getByTestId("live-transport");
  await expect(transport).toHaveAttribute("data-playing", "false");
  await page.getByTestId("live-play").click();
  await expect(transport).toHaveAttribute("data-playing", "true");
  await expect.poll(() => storeVal<boolean>(page, "transport.playing")).toBe(true);
  await page.getByTestId("live-stop").click();
  await expect(transport).toHaveAttribute("data-playing", "false");
  await expect.poll(() => storeVal<boolean>(page, "transport.playing")).toBe(false);
});

test("loop toggle arms a default 4-bar range and shows the ruler brace", async ({ page }) => {
  await bootLive(page);
  // fresh session: no loop range — the toggle must arm the first four bars
  // (loopToggleArgs; a zero-length loop would be invisible).
  await expect(page.getByTestId("live-loop")).toHaveAttribute("aria-pressed", "false");
  await page.getByTestId("live-loop").click();
  await expect(page.getByTestId("live-loop")).toHaveAttribute("aria-pressed", "true");
  await expect.poll(() => storeVal<boolean>(page, "transport.looping")).toBe(true);
  const start = await storeVal<number>(page, "transport.loopStart");
  const end = await storeVal<number>(page, "transport.loopEnd");
  expect(end - start).toBeGreaterThan(0);
  await expect(page.getByTestId("live-loop-brace")).toBeVisible();
  // toggle off → the brace goes
  await page.getByTestId("live-loop").click();
  await expect(page.getByTestId("live-loop-brace")).toHaveCount(0);
});

test("browser: Live's category column renders, and categories show Mosh's data", async ({ page }) => {
  await bootLive(page);
  // SPEC §4's Library list (subset Mosh has data for) + Places.
  await expect(page.locator('[data-testid="live-bcat"]')).toHaveCount(6);
  await expect(page.locator('[data-category="sounds"]')).toBeVisible();
  await expect(page.locator('[data-category="drums"]')).toBeVisible();
  await expect(page.locator('[data-category="samples"]')).toBeVisible();
  // Sounds (default) lists the built-in instruments…
  await expect(page.getByTestId("live-brow").first()).toBeVisible();
  // …Drums lists the kits, and double-clicking one loads the sampler onto the track
  // (Live's browser: single-click selects, double-click loads).
  await page.locator('[data-category="drums"]').click();
  const kit = page.getByTestId("live-brow").filter({ hasText: "mosh kit" });
  await expect(kit).toBeVisible();
  await kit.dblclick();
  await expect.poll(() =>
    storeVal<{ plugins?: { type: string }[] }[]>(page, "snapshot.tracks")
      .then((ts) => (ts[0]?.plugins ?? []).map((p) => p.type)),
  ).toContain("sampler");
  await expect(page.getByTestId("live-error")).toHaveCount(0);
});

test("double-clicking a MIDI clip replaces Devices with the real editor", async ({ page }) => {
  await bootLive(page);
  // no clip open → the dock is in its devices posture
  await expect(page.getByTestId("live-devices")).toBeVisible();
  const clip = page.locator('.live-shell [data-testid="v2-clip"]').first(); // the Drums "loop" MIDI clip
  await clip.dblclick();
  // the store field the PianoRoll reads — the dock reacts to it
  await expect.poll(() => storeVal<string | null>(page, "editingClipId")).not.toBeNull();
  const dock = page.getByTestId("live-dock");
  await expect(dock).toBeVisible();
  // The editor is the SAME PianoRoll component classic/v2 show as a modal, docked.
  // It replaces the Devices posture instead of stacking above it, preserving the
  // dock's full height for note editing.
  await expect(page.locator(".live-shell .pr.docked")).toBeVisible();
  await expect(page.locator(".live-shell .modal-backdrop")).toHaveCount(0);
  await expect(page.getByTestId("live-dock").getByTestId("live-dock-close")).toHaveCount(0);
  await expect(page.getByTestId("live-devpanel")).toHaveCount(0);
  await expect(page.getByTestId("live-devices")).toHaveCount(0);
  await expect(page.locator(".live-shell .pr.docked")).toContainText("loop");
  // the editor's own ✕ clears editingClipId and the dock falls back to devices
  await page.locator(".live-shell .pr.docked .pr-head .btn.x").click();
  await expect(page.locator(".live-shell .pr.docked")).toHaveCount(0);
  await expect(page.getByTestId("live-devices")).toBeVisible();
  await expect.poll(() => storeVal<string | null>(page, "editingClipId")).toBeNull();
});

test("Delete belongs exclusively to the focused arrangement while the MIDI editor is docked", async ({ page }) => {
  await bootLive(page);
  const arrangementClip = page.locator('.live-shell [data-testid="v2-clip"]').first();
  await arrangementClip.dblclick();

  const pianoRoll = page.getByTestId("piano-roll");
  await expect(pianoRoll).toBeVisible();
  const note = pianoRoll.getByTestId("pr-note").first();
  await note.click();
  await expect(note).toHaveClass(/\bsel\b/);

  await arrangementClip.click();
  await expect(arrangementClip).toBeFocused();
  await expect(note).toHaveClass(/\bsel\b/);
  await expect.poll(() => storeVal<number>(page, "selection.size")).toBe(1);
  await expect.poll(() => page.evaluate(() =>
    document.activeElement?.closest('[data-testid="piano-roll"]') != null,
  )).toBe(false);

  await page.keyboard.press("Delete");

  await expect.poll(async () => commandLog(page, 5)).toContain("remove_clip");
  expect(await commandLog(page, 5)).not.toContain("remove_note");
});

test("Escape closes the docked editor through the shared escape stack", async ({ page }) => {
  await bootLive(page);
  await page.locator('.live-shell [data-testid="v2-clip"]').first().dblclick();
  await expect(page.locator(".live-shell .pr.docked")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.locator(".live-shell .pr.docked")).toHaveCount(0);
  // the dock itself stays — in its devices posture (a track is still selected)
  await expect(page.getByTestId("live-devices")).toBeVisible();
  await expect.poll(() => storeVal<string | null>(page, "editingClipId")).toBeNull();
});

test("a wave clip opens a real audio editor through the Live double-click path", async ({ page }) => {
  await bootLive(page);
  const waveClip = page.getByTestId("live-lane").nth(2).getByTestId("v2-clip");
  await waveClip.dblclick();

  const editor = page.getByTestId("live-audio-clip-editor");
  await expect(editor).toBeVisible();
  await expect(editor.getByTestId("live-audio-waveform")).toBeVisible();
  await expect(editor.locator("canvas")).toBeVisible();
  const waveformContrast = await editor.getByTestId("live-audio-waveform").evaluate((waveform) => {
    const canvas = waveform.querySelector("canvas");
    if (!(canvas instanceof HTMLCanvasElement)) throw new Error("waveform canvas is absent");
    const channels = (color: string): { r: number; g: number; b: number; a: number } => {
      const parts = color.match(/[0-9.]+/g);
      if (!parts || parts.length < 3) throw new Error(`unparseable color: ${color}`);
      return {
        r: Number(parts[0]),
        g: Number(parts[1]),
        b: Number(parts[2]),
        a: parts[3] === undefined ? 1 : Number(parts[3]),
      };
    };
    const background = channels(getComputedStyle(waveform).backgroundColor);
    const ink = channels(getComputedStyle(canvas).getPropertyValue("--clip-ink-wave"));
    const composite = {
      r: ink.r * ink.a + background.r * (1 - ink.a),
      g: ink.g * ink.a + background.g * (1 - ink.a),
      b: ink.b * ink.a + background.b * (1 - ink.a),
    };
    return Math.hypot(composite.r - background.r, composite.g - background.g, composite.b - background.b);
  });
  expect(waveformContrast).toBeGreaterThan(25);

  await page.evaluate(() => {
    const store = (window as any).__moshStore;
    const snapshot = store.getState().snapshot;
    const tracks = snapshot.tracks.map((track: any) => ({
      ...track,
      clips: track.clips.map((clip: any) => clip.type === "wave" ? { ...clip, sourceMissing: true } : clip),
    }));
    store.setState({ snapshot: { ...snapshot, tracks } });
  });
  const status = editor.getByTestId("live-audio-waveform-status");
  await expect(status).toBeVisible();
  const statusContrast = await status.evaluate((element) => {
    const waveform = element.parentElement;
    if (!waveform) throw new Error("waveform ground is absent");
    const channels = (color: string): [number, number, number] => {
      const parts = color.match(/[0-9.]+/g);
      if (!parts || parts.length < 3) throw new Error(`unparseable color: ${color}`);
      return [Number(parts[0]), Number(parts[1]), Number(parts[2])];
    };
    const luminance = (color: [number, number, number]): number => {
      const [r, g, b] = color.map((channel) => {
        const normalized = channel / 255;
        return normalized <= 0.03928 ? normalized / 12.92 : ((normalized + 0.055) / 1.055) ** 2.4;
      });
      return r * 0.2126 + g * 0.7152 + b * 0.0722;
    };
    const text = luminance(channels(getComputedStyle(element).color));
    const ground = luminance(channels(getComputedStyle(waveform).backgroundColor));
    return (Math.max(text, ground) + 0.05) / (Math.min(text, ground) + 0.05);
  });
  expect(statusContrast).toBeGreaterThanOrEqual(4.5);

  const reverse = editor.getByTestId("live-audio-reverse");
  await expect(reverse).toHaveAttribute("aria-pressed", "false");
  await reverse.click();
  await expect(reverse).toHaveAttribute("aria-pressed", "true");

  await page.getByRole("button", { name: "Close the detail view" }).click();
  await expect(editor).toHaveCount(0);
  await waveClip.dblclick();
  await expect(page.getByTestId("live-audio-reverse")).toHaveAttribute("aria-pressed", "true");
});

test("a displayed generic clip never opens a MIDI or audio editor", async ({ page }) => {
  await bootLive(page);
  await page.evaluate(() => {
    const st = (window as any).__moshStore.getState();
    st.snapshot.tracks[2].clips[0].type = "clip";
    st.closePianoRoll();
  });

  await page.getByTestId("live-lane").nth(2).getByTestId("v2-clip").dblclick();
  await expect.poll(() => storeVal<string | null>(page, "editingClipId")).toBeNull();
  await expect(page.getByTestId("live-audio-clip-editor")).toHaveCount(0);
  await expect(page.locator(".live-shell .pr.docked")).toHaveCount(0);
});

// The two paint tests pin the editor's grid to a FIXED 1/4 division (snap on) so the
// expected beats are exact: beatPx is the store default 42 and stepBeats is 1.
const FIXED_GRID = { prGridAdaptive: false, prGridDivision: "1/4" };

/** The notes of the clip currently open in the docked editor. */
function editedNotes(page: Page): Promise<{ pitch: number; start: number; length: number }[]> {
  return page.evaluate(() => {
    const st = (window as any).__moshStore.getState();
    const clip = st.snapshot.tracks.flatMap((t: any) => t.clips).find((c: any) => c.id === st.editingClipId);
    return (clip?.notes ?? []).map((n: any) => ({ pitch: n.pitch, start: n.start, length: n.length }));
  });
}

/** Open the docked editor on the seed session's first MIDI clip ("loop"). */
async function openDockedEditor(page: Page): Promise<void> {
  await page.locator('.live-shell [data-testid="v2-clip"]').first().dblclick();
  await expect(page.locator(".live-shell .pr.docked")).toBeVisible();
}

/** A screen point inside the editor viewport on a row with NO note overlapping
 *  [fromBeat, toBeat] (the scroll centres on the clip's own notes, so the viewport
 *  middle is the worst place to aim — the pointerdown would grab a note instead of
 *  the grid). Row geometry mirrors the editor's unfolded axis: 128 rows of 15px,
 *  pitch 127 at the top. Fails loudly when the viewport is genuinely full. */
async function emptyGridPoint(
  page: Page, fromBeat: number, toBeat: number,
): Promise<{ x: number; y: number }> {
  // The dock's layout observer measures .pr-scroll a frame after the React commit
  // (the MIDI editor's header rows mount alongside it) — wait for a real viewport
  // before reading row geometry, or the scan degenerates to zero rows.
  await expect.poll(() =>
    page.evaluate(() => (document.querySelector(".live-shell .pr-scroll") as HTMLElement | null)?.clientHeight ?? 0),
  ).toBeGreaterThanOrEqual(45);
  const pt = await page.evaluate(({ from, to }) => {
    const st = (window as any).__moshStore.getState();
    const clip = st.snapshot.tracks.flatMap((t: any) => t.clips).find((c: any) => c.id === st.editingClipId);
    const notes: { pitch: number; start: number; length: number }[] = clip?.notes ?? [];
    const sc = document.querySelector(".live-shell .pr-scroll")!;
    // the clip's own notes cluster mid-range — scroll to the TOP (the unused high
    // rows) so an empty row is always in view, whatever the dock height
    sc.scrollTop = 0;
    const gb = document.querySelector(".live-shell .pr-grid")!.getBoundingClientRect();
    const ROW_H = 15;
    const topRow = Math.floor(sc.scrollTop / ROW_H);
    const visRows = Math.max(1, Math.floor(sc.clientHeight / ROW_H));
    for (let row = topRow + 1; row < topRow + visRows - 1; row++) {
      const pitch = 127 - row;
      const clash = notes.some((n) => n.pitch === pitch && n.start < to && n.start + n.length > from);
      if (!clash) return { x: gb.left + from * st.pianoRollBeatPx, y: gb.top + row * ROW_H + 7 };
    }
    return null;
  }, { from: fromBeat, to: toBeat });
  if (!pt) throw new Error("no empty visible row in the editor viewport");
  return pt;
}

test("double-clicking empty grid paints a floor-snapped, grid-step note", async ({ page }) => {
  await bootLive(page, { values: FIXED_GRID });
  await openDockedEditor(page);
  const before = await editedNotes(page);

  // aim inside step 4 (beat 4.2 floors to 4)
  const pt = await emptyGridPoint(page, 4.2, 4.3);
  await page.mouse.dblclick(pt.x, pt.y);

  await expect.poll(async () => (await editedNotes(page)).length).toBe(before.length + 1);
  // beat 4 can already hold a drum 16th from the seed pattern — the added note is the
  // one that is NOT in the pre-click set (identity: start+pitch+length).
  const added = (await editedNotes(page)).find(
    (n) => !before.some((b) => b.start === n.start && b.pitch === n.pitch && b.length === n.length),
  );
  expect(added, "no new note landed from the click").toBeDefined();
  expect(added!.start, "the start floors to the grid line below the click").toBe(4);
  expect(added!.length, "a double-click paints one grid step").toBe(1);
});

test("draw mode ON: a click-drag paints a note whose length follows the drag", async ({ page }) => {
  await bootLive(page, { values: FIXED_GRID });
  await openDockedEditor(page);
  const before = await editedNotes(page);

  // the control-bar pencil (also B) — the live shell's draw mode
  await page.getByTestId("live-draw").click();
  await expect(page.getByTestId("live-draw")).toHaveAttribute("aria-pressed", "true");

  const beatPx = await storeVal<number>(page, "pianoRollBeatPx");
  const pt = await emptyGridPoint(page, 4.2, 6.4);
  const x1 = pt.x + (6.3 - 4.2) * beatPx;   // beat 6.3 → snaps to 6 → length 2
  await page.mouse.move(pt.x, pt.y);
  await page.mouse.down();
  // the ghost tracks the drag while it is in flight
  await page.mouse.move(pt.x + 1.3 * beatPx, pt.y, { steps: 4 });
  await expect(page.getByTestId("pr-draw-ghost")).toBeVisible();
  await page.mouse.move(x1, pt.y, { steps: 6 });
  await page.mouse.up();

  await expect.poll(async () => (await editedNotes(page)).length).toBe(before.length + 1);
  const added = (await editedNotes(page)).find(
    (n) => n.start === 4 && !before.some((b) => b.start === n.start && b.pitch === n.pitch && b.length === n.length),
  );
  expect(added, "no note landed from the draw drag").toBeDefined();
  expect(added!.length, "the note's length follows the drag").toBe(2);

  // draw mode OFF again: the same drag is the marquee (selects, paints nothing)
  await page.getByTestId("live-draw").click();
  await expect(page.getByTestId("live-draw")).toHaveAttribute("aria-pressed", "false");
  const count = (await editedNotes(page)).length;
  const pt2 = await emptyGridPoint(page, 8.2, 10.6);
  await page.mouse.move(pt2.x, pt2.y - 20);
  await page.mouse.down();
  await page.mouse.move(pt2.x + 2.3 * beatPx, pt2.y + 20, { steps: 8 });
  await page.mouse.up();
  // a settled (non-async) assertion: the marquee adds no note
  expect((await editedNotes(page)).length, "draw off: a drag must not paint").toBe(count);
});

test("the Moshi button toggles the collapsed-by-default drawer in the dock", async ({ page }) => {
  await bootLive(page);
  await expect(page.getByTestId("live-moshi-panel")).toHaveCount(0);
  await page.getByTestId("live-moshi").click();
  await expect(page.getByTestId("live-dock")).toBeVisible();
  await expect(page.getByTestId("live-moshi-panel")).toBeVisible();
  await page.getByTestId("live-moshi").click();
  await expect(page.getByTestId("live-moshi-panel")).toHaveCount(0);
});

test("status bar: position readout at rest, clip readout once selected", async ({ page }) => {
  await bootLive(page);
  const readout = page.getByTestId("live-status-readout");
  await expect(readout).toHaveText("Position 1.1.1");
  // the current-track chip names the auto-selected first track
  await expect(page.getByTestId("live-status-track")).toContainText("Drums");
  // click a clip → the context line switches to the selection (SPEC §9)
  await page.locator('.live-shell [data-testid="v2-clip"]').first().click();
  await expect(readout).toContainText("Clip: loop");
});

test("the control-bar draw toggle flips on B and lights accent", async ({ page }) => {
  await bootLive(page);
  const draw = page.getByTestId("live-draw");
  await expect(draw).toHaveAttribute("aria-pressed", "false");
  await page.keyboard.press("b");
  await expect(draw).toHaveAttribute("aria-pressed", "true");
  await page.keyboard.press("b");
  await expect(draw).toHaveAttribute("aria-pressed", "false");
});

test("clip header-drag moves the clip (ableton gesture table, no hardcoding)", async ({ page }) => {
  await bootLive(page);
  const clip = page.locator('.live-shell [data-testid="v2-clip"]').first();
  const before = await clip.boundingBox();
  if (!before) throw new Error("no clip");
  // the name strip is the header drag zone under the ableton table
  const y = before.y + 9;
  await page.mouse.move(before.x + before.width / 2, y);
  await page.mouse.down();
  await page.mouse.move(before.x + before.width / 2 + 160, y, { steps: 10 });
  await page.mouse.up();
  await expect.poll(async () => {
    const b = await page.locator('.live-shell [data-testid="v2-clip"]').first().boundingBox();
    return b ? Math.round(b.x - before.x) : 0;
  }).toBeGreaterThan(40);
});

// ── Phase 3 — Live-12 interaction parity (docs/live-clone/PARITY.md) ───────────
// Every shortcut below resolves through the ableton keymap preset / gesture table
// (never an ad-hoc key check), and every mutation is an exec() command.

test("⌘E splits the selected clip at the playhead", async ({ page }) => {
  await bootLive(page);
  // park the playhead inside the clip (split at the playhead needs 0 < pos < end)
  await page.evaluate(async () => {
    await (window as any).__moshStore.getState().exec("set_transport", { position: 4 });
  });
  const lane = page.getByTestId("live-lane").first();
  const before = await lane.locator('[data-testid="v2-clip"]').count();
  await lane.locator('[data-testid="v2-clip"]').first().click(); // select
  await page.keyboard.press("Meta+e");
  await expect(lane.locator('[data-testid="v2-clip"]')).toHaveCount(before + 1);
});

test("empty-lane drag paints a time selection, and ⌘L loops exactly that span", async ({ page }) => {
  await bootLive(page);
  const lane = page.getByTestId("live-lane").nth(2); // Keys — empty past 8s
  const box = await lane.boundingBox();
  if (!box) throw new Error("no lane");
  const pps = await storeVal<number>(page, "pxPerSec");
  // grid-aligned points well inside the visible viewport (0.5s = 40px at 80pps):
  // 2.5s → 5.0s. (The header column is 279pt — time-based x past ~8s lands on it.)
  const x0 = box.x + 2.5 * pps, x1 = box.x + 5.0 * pps;
  await page.mouse.move(x0, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(x1, box.y + box.height / 2, { steps: 8 });
  await page.mouse.up();
  await expect(page.getByTestId("live-timerange")).toBeVisible();

  await page.keyboard.press("Meta+l");
  await expect.poll(() => storeVal<boolean>(page, "transport.looping")).toBe(true);
  expect(await storeVal<number>(page, "transport.loopStart")).toBeCloseTo(2.5, 3);
  expect(await storeVal<number>(page, "transport.loopEnd")).toBeCloseTo(5.0, 3);
  await expect(page.getByTestId("live-loop-brace")).toBeVisible();
});

test("double-click on an empty ordinary Audio lane leaves its clips and the dock unchanged", async ({ page }) => {
  await bootLive(page);
  // Keys is ordinary audio: unlike the Bass lane, it has neither an instrument nor
  // drum semantics, so an empty-ground MIDI gesture must not turn it into MIDI.
  await page.keyboard.press("Meta+-");
  await page.keyboard.press("Meta+-");
  const lane = page.getByTestId("live-lane").nth(2); // Keys — ordinary Audio
  const box = await lane.boundingBox();
  if (!box) throw new Error("no lane");
  const pps = await storeVal<number>(page, "pxPerSec");
  await expect(lane.locator('[data-testid="v2-clip"]')).toHaveCount(1);
  await expect.poll(() => storeVal<string | null>(page, "editingClipId")).toBeNull();

  await page.mouse.dblclick(box.x + 9 * pps, box.y + box.height / 2);

  await expect(lane.locator('[data-testid="v2-clip"]')).toHaveCount(1);
  await expect.poll(() => storeVal<string | null>(page, "editingClipId")).toBeNull();
  await expect(page.locator(".live-shell .pr.docked")).toHaveCount(0);
});

test("double-click on an empty instrument lane creates its clip and opens the docked editor", async ({ page }) => {
  await bootLive(page);
  // zoom out so empty ground past the seed clips is comfortably clickable (the
  // fixed 279pt header column eats the right side of the lanes viewport)
  await page.keyboard.press("Meta+-");
  await page.keyboard.press("Meta+-");
  // Make Bass taller than the first lane. A target is valid only when its actual
  // bounding box is used; dividing by the first lane's height lands on Keys here.
  const bassHeader = page.getByTestId("live-track-header").nth(1);
  const handle = bassHeader.getByTestId("live-lane-resize");
  const handleBox = await handle.boundingBox();
  if (!handleBox) throw new Error("no Bass lane resize handle");
  await page.mouse.move(handleBox.x + handleBox.width / 2, handleBox.y + handleBox.height / 2);
  await page.mouse.down();
  await page.mouse.move(handleBox.x + handleBox.width / 2, handleBox.y + handleBox.height / 2 + 120, { steps: 6 });
  await page.mouse.up();

  const lane = page.getByTestId("live-lane").nth(1); // Bass — audio type, but MIDI-capable via isInstrument
  const box = await lane.boundingBox();
  if (!box) throw new Error("no lane");
  const pps = await storeVal<number>(page, "pxPerSec");
  await expect(lane.locator('[data-testid="v2-clip"]')).toHaveCount(1);
  await page.mouse.dblclick(box.x + 9 * pps, box.y + box.height / 2);
  await expect(lane.locator('[data-testid="v2-clip"]')).toHaveCount(2);
  // the new clip lands at the snapped pointer position (9s on the 0.5s grid)
  await expect.poll(async () => {
    const starts = await page.evaluate(() => {
      const st = (window as any).__moshStore.getState();
      return st.snapshot.tracks[1].clips.map((c: any) => c.start).sort((a: number, b: number) => a - b);
    });
    return starts;
  }).toEqual([0, 9]);
  // …and its editor is already open in the dock
  await expect(page.locator(".live-shell .pr.docked")).toBeVisible();
});

test("0 deactivates (mutes) the selected clip, and again re-activates it", async ({ page }) => {
  await bootLive(page);
  await page.locator('.live-shell [data-testid="v2-clip"]').first().click();
  const muted = () => page.evaluate(() => {
    const st = (window as any).__moshStore.getState();
    return st.snapshot.tracks[0].clips[0].mute === true;
  });
  expect(await muted()).toBe(false);
  await page.keyboard.press("0");
  await expect.poll(muted).toBe(true);
  await page.keyboard.press("0");
  await expect.poll(muted).toBe(false);
});

test("⌘R renames the selected clip inline on the lane", async ({ page }) => {
  await bootLive(page);
  await page.locator('.live-shell [data-testid="v2-clip"]').first().click();
  await page.keyboard.press("Meta+r");
  const field = page.getByTestId("live-rename");
  await expect(field).toBeVisible();
  await expect(field).toBeFocused();
  await field.fill("Verse riff");
  await field.press("Enter");
  await expect(field).toHaveCount(0);
  await expect.poll(() => page.evaluate(() => {
    const st = (window as any).__moshStore.getState();
    return st.snapshot.tracks[0].clips[0].name;
  })).toBe("Verse riff");
  // the name strip follows
  await expect(page.locator('.live-shell [data-testid="v2-clip"]').first()).toContainText("Verse riff");
});

test("⌘1/⌘2 step the arrangement grid, ⌘4 toggles snap, ⌘+/− zoom the lanes", async ({ page }) => {
  await bootLive(page);
  expect(await storeVal<string>(page, "snapDivision")).toBe("1/4");
  await page.keyboard.press("Meta+1"); // narrow
  await expect.poll(() => storeVal<string>(page, "snapDivision")).toBe("1/8");
  await page.keyboard.press("Meta+2"); // widen
  await expect.poll(() => storeVal<string>(page, "snapDivision")).toBe("1/4");

  expect(await storeVal<boolean>(page, "snap")).toBe(true);
  await page.keyboard.press("Meta+4");
  await expect.poll(() => storeVal<boolean>(page, "snap")).toBe(false);
  await page.keyboard.press("Meta+4");
  await expect.poll(() => storeVal<boolean>(page, "snap")).toBe(true);

  const before = await storeVal<number>(page, "pxPerSec");
  await page.keyboard.press("Meta+=");
  await expect.poll(() => storeVal<number>(page, "pxPerSec")).toBeGreaterThan(before);
  await page.keyboard.press("Meta+-");
  await expect.poll(() => storeVal<number>(page, "pxPerSec")).toBe(before);
});

// ── Wave 0 — plugin usability, dock splitter, menu-key rollout ────────────────

/** The most-recent command names from the mock's command log (newest first). */
async function commandLog(page: Page, limit = 5): Promise<string[]> {
  return page.evaluate(async (n) => {
    const st = (window as any).__moshStore.getState();
    const res = await st.exec("get_command_log", { limit: n });
    return (res.data?.entries ?? []).map((e: any) => e.command);
  }, limit);
}

test("browser: the deep rescan (AU opt-in) drives progress → done and grows the catalog", async ({ page }) => {
  await bootLive(page);
  await page.locator('[data-category="effects"]').click();
  // before the sweep: the two quick-scan VST3s only
  await expect(page.getByTestId("live-brow").filter({ hasText: "Valhalla Supermassive" })).toHaveCount(0);
  await page.getByTestId("live-scan-au").check();
  await page.getByTestId("live-rescan").click();
  // the async sweep reports progress…
  await expect(page.getByTestId("live-scan-status")).toContainText("Scanning");
  // …then completes and the deep-only plugins join the list
  await expect(page.getByTestId("live-scan-status")).toHaveCount(0);
  await expect(page.getByTestId("live-rescan")).toHaveText("Rescan plugins");
  await expect(page.getByTestId("live-brow").filter({ hasText: "Valhalla Supermassive" })).toBeVisible();
});

test("browser: single-click selects, double-click loads — with feedback, and the device strip drives the plugin", async ({ page }) => {
  await bootLive(page);
  await page.locator('[data-category="instruments"]').click();
  const vital = page.getByTestId("live-brow").filter({ hasText: "Vital" });
  // single click SELECTS (visible state) but loads nothing — the accidental-stack fix
  await vital.click();
  await expect(vital).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByTestId("live-browser-hint")).toHaveCount(0);
  // double-click loads, and the hint names the target
  await vital.dblclick();
  await expect(page.getByTestId("live-browser-hint")).toContainText("Loaded Vital onto Drums");
  await expect.poll(() => page.evaluate(() => {
    const st = (window as any).__moshStore.getState();
    return st.snapshot.tracks[0].plugins.map((p: any) => p.name);
  })).toContain("Vital");

  // the devices view (dock, no clip open) shows the loaded plugin as a chip…
  const chip = page.getByTestId("live-device").filter({ hasText: "Vital" });
  await expect(chip).toBeVisible();
  // …double-click opens its editor…
  await chip.dblclick();
  await expect.poll(() => commandLog(page)).toContain("open_plugin_editor");
  // …and ⏻ bypasses it (the chip dims)
  await chip.getByTestId("live-device-bypass").click();
  await expect.poll(() => commandLog(page)).toContain("bypass_plugin");
  await expect(page.getByTestId("live-device").filter({ hasText: "Vital" })).toHaveClass(/off/);
});

test("device strip: click selects, Delete removes, right-click menu covers all three actions", async ({ page }) => {
  await bootLive(page);
  // put a plugin on the selected track (an EFFECT — the Keys audio track refuses instruments)
  await page.evaluate(async () => {
    const st = (window as any).__moshStore.getState();
    await st.exec("load_plugin", { trackId: st.snapshot.tracks[0].id, pluginId: "ott" });
  });
  const chip = page.getByTestId("live-device").filter({ hasText: "OTT" });
  await expect(chip).toBeVisible();
  // click selects (no editor, no command)
  await chip.click();
  await expect(chip).toHaveAttribute("data-selected", "true");
  // right-click → the chip menu
  await chip.click({ button: "right" });
  const menu = page.getByTestId("live-device-menu");
  await expect(menu).toBeVisible();
  await expect(menu.getByTestId("live-device-menu-open")).toBeVisible();
  await expect(menu.getByTestId("live-device-menu-bypass")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(menu).toHaveCount(0);
  // Delete on the focused chip removes the plugin
  await chip.focus();
  await page.keyboard.press("Delete");
  await expect(page.getByTestId("live-device").filter({ hasText: "OTT" })).toHaveCount(0);
  await expect.poll(() => commandLog(page)).toContain("remove_plugin");
  await expect(page.getByTestId("live-devices")).toContainText("No devices");
});

test("integrity guard: an instrument is refused on an audio track holding clips, allowed on a drum track", async ({ page }) => {
  await bootLive(page);
  const refusal = await page.evaluate(async () => {
    const st = (window as any).__moshStore.getState();
    const keys = st.snapshot.tracks.find((t: any) => t.clips.some((c: any) => c.type === "wave"));
    return st.exec("load_plugin", { trackId: keys.id, pluginId: "vital" });
  });
  expect(refusal.ok).toBe(false);
  expect(refusal.error).toContain("instrument tracks");
  // the drum track (and any track without wave clips) still loads instruments
  const allowed = await page.evaluate(async () => {
    const st = (window as any).__moshStore.getState();
    const drums = st.snapshot.tracks[0];
    return st.exec("load_plugin", { trackId: drums.id, pluginId: "vital" });
  });
  expect(allowed.ok).toBe(true);
});

test("dock splitter: drag resizes, arrow keys step, and the height survives a reload", async ({ page }) => {
  // Seed ONLY if absent — this test reloads, and the usual boot's unconditional
  // localStorage.clear() would erase the very persistence it pins.
  await page.addInitScript(() => {
    if (!window.localStorage.getItem("mosh.settings"))
      window.localStorage.setItem("mosh.settings", JSON.stringify({
        version: 2, template: null,
        values: { gestureTable: "ableton", keymap: "ableton" }, keyOverrides: {},
      }));
  });
  await page.goto("/?shell=live");
  await expect(page.getByTestId("live-shell")).toBeVisible();
  // The splitter belongs to the CLIP panel (WIDGETS §1: the device panel's edge
  // never drags), so open a clip first — devices-only posture has no splitter.
  await page.locator('.live-shell [data-testid="v2-clip"]').first().dblclick();
  await expect(page.locator(".live-shell .pr.docked")).toBeVisible();
  const dock = page.getByTestId("live-dock");
  const h0 = (await dock.boundingBox())!.height;

  const splitter = page.getByTestId("live-dock-splitter");
  const sb = (await splitter.boundingBox())!;
  await page.mouse.move(sb.x + sb.width / 2, sb.y + sb.height / 2);
  await page.mouse.down();
  await page.mouse.move(sb.x + sb.width / 2, sb.y - 100, { steps: 8 }); // drag UP = taller
  await page.mouse.up();
  const h1 = (await dock.boundingBox())!.height;
  expect(h1).toBeGreaterThan(h0 + 60);

  // keyboard: focused separator, arrows step the height
  await splitter.focus();
  await page.keyboard.press("ArrowDown");
  const h2 = (await dock.boundingBox())!.height;
  expect(h2).toBeLessThan(h1);

  // persistence: reload, re-open the editor (session state doesn't survive — the
  // HEIGHT does), and the clip panel keeps its dragged size
  await page.reload();
  await expect(page.getByTestId("live-shell")).toBeVisible();
  await page.locator('.live-shell [data-testid="v2-clip"]').first().dblclick();
  await expect(page.locator(".live-shell .pr.docked")).toBeVisible();
  const h3 = (await page.getByTestId("live-dock").boundingBox())!.height;
  expect(Math.abs(h3 - h2)).toBeLessThanOrEqual(2);
});

test("dock splitter: a short drag holds at the 226pt floor; a long one dismisses the view", async ({ page }) => {
  await bootLive(page);
  await page.locator('.live-shell [data-testid="v2-clip"]').first().dblclick();
  await expect(page.locator(".live-shell .pr.docked")).toBeVisible();
  const splitter = page.getByTestId("live-dock-splitter");

  // short drag below the floor → clamps at 226 (the persisted setting carries the
  // clamped value; the exclusive MIDI editor stays mounted)
  let sb = (await splitter.boundingBox())!;
  await page.mouse.move(sb.x + sb.width / 2, sb.y);
  await page.mouse.down();
  await page.mouse.move(sb.x + sb.width / 2, sb.y + 60, { steps: 6 });
  await page.mouse.up();
  const persisted = await page.evaluate(() =>
    JSON.parse(window.localStorage.getItem("mosh.settings")!).values.liveDockHeight);
  expect(persisted).toBe(226);
  await expect(page.locator(".live-shell .pr.docked")).toBeVisible(); // still open

  // LONG drag well past the floor → drag-to-close: the editor dismisses and the
  // dock falls back to the device panel
  sb = (await page.getByTestId("live-dock-splitter").boundingBox())!;
  await page.mouse.move(sb.x + sb.width / 2, sb.y);
  await page.mouse.down();
  await page.mouse.move(sb.x + sb.width / 2, sb.y + 400, { steps: 10 });
  await page.mouse.up();
  await expect(page.locator(".live-shell .pr.docked")).toHaveCount(0);
  await expect.poll(() => storeVal<string | null>(page, "editingClipId")).toBeNull();
  await expect(page.getByTestId("live-devpanel")).toBeVisible();
});

test("Expanded Clip View (⌥⌘E): the editor fills the window, sticky across close/reopen", async ({ page }) => {
  await bootLive(page);
  await page.locator('.live-shell [data-testid="v2-clip"]').first().dblclick();
  await expect(page.locator(".live-shell .pr.docked")).toBeVisible();
  await page.keyboard.press("Alt+Meta+e");
  // Browser + arrangement are hidden (CSS — they stay mounted); the MIDI editor
  // remains exclusive, so only the control bar + editor + status bar stay visible.
  await expect(page.locator(".live-shell")).toHaveAttribute("data-clip-expanded", "true");
  await expect(page.getByTestId("live-browser")).toBeHidden();
  await expect(page.getByTestId("live-arrangement")).toBeHidden();
  await expect(page.getByTestId("live-controlbar")).toBeVisible();
  await expect(page.locator(".live-shell .pr.docked")).toBeVisible();
  await expect(page.getByTestId("live-devpanel")).toHaveCount(0);
  await expect(page.getByTestId("live-statusbar")).toBeVisible();
  // sticky: close the editor, reopen — still expanded
  await page.locator(".live-shell .pr.docked .pr-head .btn.x").click();
  await expect(page.locator(".live-shell .pr.docked")).toHaveCount(0);
  await expect(page.locator(".live-shell")).toHaveAttribute("data-clip-expanded", "false");
  // the lanes are back while no clip is open…
  await expect(page.getByTestId("live-arrangement")).toBeVisible();
  // …and reopening a clip expands again without touching the key
  await page.locator('.live-shell [data-testid="v2-clip"]').first().dblclick();
  await expect(page.locator(".live-shell")).toHaveAttribute("data-clip-expanded", "true");
  // the header's ⤢ control toggles it back
  await page.getByTestId("pr-expand").click();
  await expect(page.locator(".live-shell")).toHaveAttribute("data-clip-expanded", "false");
  await expect(page.getByTestId("live-arrangement")).toBeVisible();
});

test("lane height: the header divider drags one lane (17–443pt), compact at the floor", async ({ page }) => {
  await bootLive(page);
  const lane = page.getByTestId("live-lane").first();
  const header = page.getByTestId("live-track-header").first();
  const h0 = (await lane.boundingBox())!.height;
  expect(Math.round(h0)).toBe(86); // the measured default

  const handle = header.getByTestId("live-lane-resize");
  const hb = (await handle.boundingBox())!;
  // drag down ~40px → the lane grows 1:1
  await page.mouse.move(hb.x + hb.width / 2, hb.y + hb.height / 2);
  await page.mouse.down();
  await page.mouse.move(hb.x + hb.width / 2, hb.y + 40, { steps: 6 });
  await page.mouse.up();
  const h1 = (await lane.boundingBox())!.height;
  expect(h1).toBeGreaterThan(h0 + 25);
  // the header follows its lane exactly
  expect(Math.round((await header.boundingBox())!.height)).toBe(Math.round(h1));
  // drag far up → clamps at 17 and the header collapses (no M/S row)
  const hb2 = (await header.getByTestId("live-lane-resize").boundingBox())!;
  await page.mouse.move(hb2.x + hb2.width / 2, hb2.y + hb2.height / 2);
  await page.mouse.down();
  await page.mouse.move(hb2.x + hb2.width / 2, hb2.y - 500, { steps: 8 });
  await page.mouse.up();
  expect(Math.round((await lane.boundingBox())!.height)).toBe(17);
  await expect(header.getByRole("button", { name: "Solo" })).toHaveCount(0);
  // keyboard restores: ArrowDown steps back up
  await header.getByTestId("live-lane-resize").focus();
  await page.keyboard.press("ArrowDown");
  expect(Math.round((await lane.boundingBox())!.height)).toBe(25);
});

test("track-header context menu: swatches recolor, Freeze row live, inserts work", async ({ page }) => {
  await bootLive(page);
  await page.getByTestId("live-track-header").first().click({ button: "right" });
  const menu = page.getByTestId("live-track-menu");
  await expect(menu).toBeVisible();
  // all 70 swatches from the extraction
  await expect(menu.getByTestId("live-swatch")).toHaveCount(70);
  // Freeze is REAL (freeze wave): freeze_track/unfreeze_track behind the row
  await expect(menu.getByTestId("live-tm-freeze")).toBeEnabled();
  // picking "Amethyst" recolors the track through set_track_color (exact: the
  // palette also has "Amethyst Smoke")
  await menu.getByRole("radio", { name: "Amethyst", exact: true }).click();
  await expect.poll(() => page.evaluate(() => {
    const st = (window as any).__moshStore.getState();
    return st.snapshot.tracks[0].color;
  })).toBe("#836ddd");
  // Insert MIDI Track lands a playable track
  const before = await page.getByTestId("live-track-header").count();
  await page.getByTestId("live-track-header").first().click({ button: "right" });
  await page.getByTestId("live-tm-insert-midi").click();
  await expect(page.getByTestId("live-track-header")).toHaveCount(before + 1);
});

test("track-header menu: ⌘R renames the track inline", async ({ page }) => {
  await bootLive(page);
  await page.getByTestId("live-track-header").first().click({ button: "right" });
  await page.getByTestId("live-tm-rename").click();
  const field = page.getByTestId("live-track-rename");
  await expect(field).toBeFocused();
  await field.fill("Rhodes");
  await field.press("Enter");
  await expect.poll(() => page.evaluate(() => {
    const st = (window as any).__moshStore.getState();
    return st.snapshot.tracks[0].name;
  })).toBe("Rhodes");
  await expect(page.getByTestId("live-track-header").first()).toContainText("Rhodes");
});

test("overview strip: clip blocks track clip positions; a click jumps playhead + view", async ({ page }) => {
  await bootLive(page);
  const strip = page.getByTestId("live-overview");
  await expect(strip).toBeVisible();
  const blocks = strip.getByTestId("live-ov-block");
  await expect(blocks).toHaveCount(3); // the seed session's three clips
  // block geometry correlates with clip start (left % ≈ start / contentSeconds)
  const corr = await page.evaluate(() => {
    const stripEl = document.querySelector('[data-testid="live-overview"]')!;
    const w = stripEl.getBoundingClientRect().width;
    return [...document.querySelectorAll('[data-testid="live-ov-block"]')].map((el) => ({
      start: Number((el as HTMLElement).dataset.clipStart),
      leftPx: (el as HTMLElement).getBoundingClientRect().left - stripEl.getBoundingClientRect().left,
      w,
    }));
  });
  for (const b of corr) {
    // contentSeconds ≈ 20 (16s session + tail) — just assert ordering and rough scale
    expect(b.leftPx).toBeGreaterThanOrEqual(0);
    expect(b.leftPx).toBeLessThanOrEqual(b.w);
  }
  expect(corr[1].start).toBeGreaterThanOrEqual(corr[0].start);
  // click partway across → the playhead leaves zero and the lanes scrolled to it
  const sb = (await strip.boundingBox())!;
  await page.mouse.click(sb.x + sb.width * 0.5, sb.y + sb.height / 2);
  await expect.poll(() => storeVal<number>(page, "transport.position")).toBeGreaterThan(1);
  const scrollLeft = await page.locator(".live-lanes-scroll").evaluate((el) => el.scrollLeft);
  expect(scrollLeft).toBeGreaterThan(0);
});

test("browser divider: pull far left hides the browser; the strip reopens it at the same width", async ({ page }) => {
  await bootLive(page);
  await expect(page.getByTestId("live-browser")).toBeVisible();
  const divider = page.getByTestId("live-browser-divider");
  const db = (await divider.boundingBox())!;
  // resize narrower first (to ~250) so "remembering" is observable
  await page.mouse.move(db.x + 3, db.y + 200);
  await page.mouse.down();
  await page.mouse.move(db.x + 3 - 80, db.y + 200, { steps: 6 });
  await page.mouse.up();
  const w1 = (await page.getByTestId("live-browser").boundingBox())!.width;
  expect(w1).toBeLessThan(331);
  // pull far left (to the screen edge) → hides entirely
  const db2 = (await page.getByTestId("live-browser-divider").boundingBox())!;
  await page.mouse.move(db2.x + 3, db2.y + 200);
  await page.mouse.down();
  await page.mouse.move(10, db2.y + 200, { steps: 8 });
  await page.mouse.up();
  await expect(page.getByTestId("live-browser")).toHaveCount(0);
  const reopen = page.getByTestId("live-browser-reopen");
  await expect(reopen).toBeVisible();
  await reopen.click();
  await expect(page.getByTestId("live-browser")).toBeVisible();
  const w2 = (await page.getByTestId("live-browser").boundingBox())!.width;
  expect(Math.abs(w2 - w1)).toBeLessThanOrEqual(2);
});

test("⌘D duplicates the selected clip", async ({ page }) => {
  await bootLive(page);
  const lane = page.getByTestId("live-lane").first();
  await lane.locator('[data-testid="v2-clip"]').first().click();
  await page.keyboard.press("Meta+d");
  await expect(lane.locator('[data-testid="v2-clip"]')).toHaveCount(2);
});

test("⌘T inserts an audio track; ⇧⌘T inserts a MIDI track that lands playable", async ({ page }) => {
  await bootLive(page);
  await expect(page.getByTestId("live-track-header")).toHaveCount(3);
  await page.keyboard.press("Meta+t");
  await expect(page.getByTestId("live-track-header")).toHaveCount(4);
  await page.keyboard.press("Meta+Shift+t");
  await expect(page.getByTestId("live-track-header")).toHaveCount(5);
  // the instrument track arrives with a clip ON IT (addTrackOfKind's contract)
  const newTrackId = await page.getByTestId("live-track-header").last().getAttribute("data-track-id");
  await expect(page.locator(`[data-testid="live-lane"][data-track-id="${newTrackId}"]`).locator('[data-testid="v2-clip"]')).toHaveCount(1);
});

test("⌘U quantizes the selected clip's notes (arrangement scope, through the seam)", async ({ page }) => {
  await bootLive(page);
  await page.locator('.live-shell [data-testid="v2-clip"]').first().click(); // the MIDI "loop"
  await page.keyboard.press("Meta+u");
  await expect.poll(() => commandLog(page)).toContain("quantize_notes");
});

test("⌘0 deactivates the selected clip, same as plain 0 (Live binds both)", async ({ page }) => {
  await bootLive(page);
  await page.locator('.live-shell [data-testid="v2-clip"]').first().click();
  const muted = () => page.evaluate(() => {
    const st = (window as any).__moshStore.getState();
    return st.snapshot.tracks[0].clips[0].mute === true;
  });
  expect(await muted()).toBe(false);
  await page.keyboard.press("Meta+0");
  await expect.poll(muted).toBe(true);
  await page.keyboard.press("Meta+0");
  await expect.poll(muted).toBe(false);
});

// ── Wave 2 — context menu, consolidate, ruler zoom, browser search, loop bar ──

test("clip context menu: Live's inventory, capability-gated", async ({ page }) => {
  await bootLive(page);
  const clip = page.locator('.live-shell [data-testid="v2-clip"]').first();
  await clip.click({ button: "right" });
  const menu = page.getByTestId("live-clip-menu");
  await expect(menu).toBeVisible();
  await expect(menu.getByTestId("live-ctx-rename")).toBeVisible();
  await expect(menu.getByTestId("live-ctx-split")).toBeVisible();
  await expect(menu.getByTestId("live-ctx-consolidate")).toBeVisible();
  await expect(menu.getByTestId("live-ctx-mute")).toContainText("Deactivate");
  await expect(menu.getByTestId("live-ctx-loop")).toBeVisible();
  await expect(menu.getByTestId("live-ctx-snap")).toBeVisible();
  await expect(menu.getByTestId("live-ctx-triplet")).toBeVisible();
  // Crop (crop wave), Bounce (bounce wave) and Freeze (freeze wave) are REAL
  await expect(menu.getByTestId("live-ctx-crop")).toBeEnabled();
  await expect(menu.getByTestId("live-ctx-bounce")).toBeEnabled();
  await expect(menu.getByTestId("live-ctx-freeze")).toBeEnabled();
  // Reverse is disabled with its reason on a MIDI clip (set_clip_reverse is wave-only)
  await expect(menu.getByTestId("live-ctx-reverse")).toBeDisabled();
  // Escape closes through the shared stack
  await page.keyboard.press("Escape");
  await expect(menu).toHaveCount(0);
});

test("context menu: Activate Loop loops the clip's span; Triplet Grid toggles ⌘3 state", async ({ page }) => {
  await bootLive(page);
  await page.locator('.live-shell [data-testid="v2-clip"]').first().click({ button: "right" });
  await page.getByTestId("live-ctx-loop").click();
  await expect.poll(() => storeVal<boolean>(page, "transport.looping")).toBe(true);
  expect(await storeVal<number>(page, "transport.loopStart")).toBeCloseTo(0, 3);
  expect(await storeVal<number>(page, "transport.loopEnd")).toBeCloseTo(8, 3);

  await page.locator('.live-shell [data-testid="v2-clip"]').first().click({ button: "right" });
  await page.getByTestId("live-ctx-triplet").click();
  await expect.poll(() => storeVal<boolean>(page, "snapTriplet")).toBe(true);
});

test("⌘J consolidates the selected MIDI clips into one (notes merged)", async ({ page }) => {
  await bootLive(page);
  // split the drum loop at 4s, select both halves, consolidate
  await page.evaluate(async () => {
    const st = (window as any).__moshStore.getState();
    const clip = st.snapshot.tracks[0].clips[0];
    await st.exec("split_clip", { clipId: clip.id, time: 4 });
  });
  const lane = page.getByTestId("live-lane").first();
  await expect(lane.locator('[data-testid="v2-clip"]')).toHaveCount(2);
  const noteTotal = await page.evaluate(() => {
    const st = (window as any).__moshStore.getState();
    return st.snapshot.tracks[0].clips.reduce((n: number, c: any) => n + (c.notes?.length ?? 0), 0);
  });
  await page.evaluate(() => {
    const st = (window as any).__moshStore.getState();
    st.select(st.snapshot.tracks[0].clips.map((c: any) => c.id));
  });
  await page.keyboard.press("Meta+j");
  await expect(lane.locator('[data-testid="v2-clip"]')).toHaveCount(1);
  await expect.poll(async () => page.evaluate(() => {
    const st = (window as any).__moshStore.getState();
    const c = st.snapshot.tracks[0].clips[0];
    return { notes: c.notes.length, start: c.start, length: c.length };
  })).toEqual({ notes: noteTotal, start: 0, length: 8 });
});

test("ruler: click seeks, vertical drag zooms anchored (Live's beat-time ruler)", async ({ page }) => {
  await bootLive(page);
  const ruler = page.getByTestId("live-ruler");
  const box = (await ruler.boundingBox())!;
  // click (no vertical travel) → playhead jumps to that time
  await page.mouse.click(box.x + 400, box.y + box.height / 2);
  await expect.poll(() => storeVal<number>(page, "transport.position")).toBeGreaterThan(1);
  // vertical drag down → zooms in (pxPerSec grows)
  const before = await storeVal<number>(page, "pxPerSec");
  await page.mouse.move(box.x + 300, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + 300, box.y + box.height / 2 + 80, { steps: 8 });
  await page.mouse.up();
  await expect.poll(() => storeVal<number>(page, "pxPerSec")).toBeGreaterThan(before);
});

test("bottom beat-time ruler mirrors scroll and keeps the zoom anchor", async ({ page }) => {
  await bootLive(page);
  const timeline = page.getByTestId("live-timeline");
  const body = page.locator(".live-arr-body");
  const clip = page.getByTestId("live-time-ruler-clip");
  const ruler = page.getByTestId("live-time-ruler");

  await expect(ruler).toBeVisible();
  await expect(ruler.locator(".live-time-label").first()).toHaveText("0:00");
  const bodyBox = (await body.boundingBox())!;
  const clipBox = (await clip.boundingBox())!;
  expect(clipBox.y).toBeGreaterThanOrEqual(bodyBox.y + bodyBox.height - 1);

  await timeline.evaluate((el) => {
    el.scrollLeft = 180;
    el.dispatchEvent(new Event("scroll"));
  });
  await expect.poll(() => clip.evaluate((el) => el.scrollLeft)).toBe(180);

  const pointerOffset = Math.min(300, clipBox.width * 0.55);
  const x = clipBox.x + pointerOffset;
  const y = clipBox.y + clipBox.height / 2;
  const before = await page.evaluate((offset) => {
    const st = (window as any).__moshStore.getState();
    const sc = document.querySelector(".live-lanes-scroll") as HTMLElement;
    return { pps: st.pxPerSec as number, scrollLeft: sc.scrollLeft, anchor: (sc.scrollLeft + offset) / st.pxPerSec };
  }, pointerOffset);
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x, y + 70, { steps: 7 });
  await page.mouse.up();
  await expect.poll(() => page.evaluate(({ offset, anchor }) => {
    const st = (window as any).__moshStore.getState();
    const sc = document.querySelector(".live-lanes-scroll") as HTMLElement;
    return Math.abs((sc.scrollLeft + offset) / st.pxPerSec - anchor);
  }, { offset: pointerOffset, anchor: before.anchor })).toBeLessThan(0.02);
  const after = await page.evaluate((offset) => {
    const st = (window as any).__moshStore.getState();
    const sc = document.querySelector(".live-lanes-scroll") as HTMLElement;
    return { pps: st.pxPerSec as number, scrollLeft: sc.scrollLeft, anchor: (sc.scrollLeft + offset) / st.pxPerSec };
  }, pointerOffset);
  expect(after.pps).toBeGreaterThan(before.pps);
  expect(Math.abs(after.anchor - before.anchor)).toBeLessThan(0.02);
  await expect.poll(() => clip.evaluate((el) => el.scrollLeft)).toBeCloseTo(after.scrollLeft, 0);
});

test("both arrangement rulers are focusable and the lower ruler exposes keyboard seek and zoom", async ({ page }) => {
  await bootLive(page);
  const top = page.getByTestId("live-ruler");
  const bottom = page.getByTestId("live-time-ruler");
  await expect(top).toHaveAttribute("tabindex", "0");
  await expect(bottom).toHaveAttribute("tabindex", "0");
  await bottom.focus();
  await expect(bottom).toBeFocused();

  await page.keyboard.press("End");
  await expect.poll(() => storeVal<number>(page, "transport.position")).toBeGreaterThan(0);
  const atEnd = await storeVal<number>(page, "transport.position");
  await page.keyboard.press("ArrowLeft");
  await expect.poll(() => storeVal<number>(page, "transport.position")).toBeLessThan(atEnd);
  await page.keyboard.press("Home");
  await expect.poll(() => storeVal<number>(page, "transport.position")).toBeCloseTo(0, 6);
  await page.keyboard.press("ArrowRight");
  await expect.poll(() => storeVal<number>(page, "transport.position")).toBeGreaterThan(0);
  const afterFirstRight = await storeVal<number>(page, "transport.position");
  await page.keyboard.press("ArrowRight");
  await expect.poll(() => storeVal<number>(page, "transport.position")).toBeGreaterThan(afterFirstRight);
  await page.keyboard.press("ArrowLeft");
  await expect.poll(() => storeVal<number>(page, "transport.position")).toBeCloseTo(afterFirstRight, 6);

  await page.evaluate(async () => {
    const st = (window as any).__moshStore.getState();
    st.setPxPerSec(200);
    await st.exec("set_transport", { position: 6 });
  });
  await expect.poll(() => storeVal<number>(page, "transport.position")).toBeCloseTo(6, 6);
  const timeline = page.getByTestId("live-timeline");
  await expect.poll(() => timeline.evaluate((el) => el.scrollWidth)).toBeGreaterThan(1500);
  await timeline.evaluate((el) => {
    el.scrollLeft = 900;
    el.dispatchEvent(new Event("scroll"));
  });
  await bottom.focus();
  const anchorOffset = 300;
  const beforeZoom = await storeVal<number>(page, "pxPerSec");
  await page.keyboard.press("ArrowUp");
  await expect.poll(() => storeVal<number>(page, "pxPerSec")).toBeGreaterThan(beforeZoom);
  await expect.poll(() => page.evaluate((offset) => {
    const st = (window as any).__moshStore.getState();
    const scroller = document.querySelector(".live-lanes-scroll") as HTMLElement;
    return Math.abs((scroller.scrollLeft + offset) / st.pxPerSec - st.transport.position);
  }, anchorOffset)).toBeLessThan(0.02);
  await page.keyboard.press("ArrowDown");
  await expect.poll(() => storeVal<number>(page, "pxPerSec")).toBeCloseTo(beforeZoom, 5);
  await expect.poll(() => page.evaluate((offset) => {
    const st = (window as any).__moshStore.getState();
    const scroller = document.querySelector(".live-lanes-scroll") as HTMLElement;
    return Math.abs((scroller.scrollLeft + offset) / st.pxPerSec - st.transport.position);
  }, anchorOffset)).toBeLessThan(0.02);
});

test("browser search (⌘F): focuses the field, filters across categories, Esc clears", async ({ page }) => {
  await bootLive(page);
  await page.keyboard.press("Meta+f");
  const field = page.getByTestId("live-bsearch");
  await expect(field).toBeFocused();
  await field.fill("ott");
  // hits from BOTH the built-in effects (Sounds→builtin / Audio Effects) and the scanned catalog
  const rows = page.getByTestId("live-brow");
  await expect(rows).toHaveCount(2);
  await expect(rows.filter({ hasText: "Mosh OTT" })).toBeVisible();
  await expect(rows.filter({ hasText: "OTT" }).first()).toBeVisible();
  // the hint column names the category while searching
  await expect(rows.first()).toContainText("Audio Effects");
  // Esc clears and returns to the category view
  await field.press("Escape");
  await expect(field).toHaveValue("");
  await expect(rows.first()).toBeVisible();
});

test("wave clip view: the loop bar toggles and repositions the clip loop (set_clip_loop)", async ({ page }) => {
  await bootLive(page);
  await page.evaluate(() => {
    const st = (window as any).__moshStore.getState();
    const wave = st.snapshot.tracks.flatMap((t: any) => t.clips).find((c: any) => c.type === "wave");
    st.openPianoRoll(wave.id);
  });
  await expect(page.getByTestId("live-loopbar")).toBeVisible();
  await expect(page.getByTestId("live-loopbar-brace")).toHaveCount(0); // loop off at seed
  // enable a 2s loop (a full-span loop has no room to move — the clamp is correct)
  await page.evaluate(async () => {
    const st = (window as any).__moshStore.getState();
    const wave = st.snapshot.tracks.flatMap((t: any) => t.clips).find((c: any) => c.type === "wave");
    await st.exec("set_clip_loop", { clipId: wave.id, enabled: true, start: 0, length: 2 });
  });
  await expect(page.getByTestId("live-loopbar-brace")).toBeVisible();
  // drag the brace right → set_clip_loop with a moved start
  const brace = page.getByTestId("live-loopbar-brace");
  const bb = (await brace.boundingBox())!;
  await page.mouse.move(bb.x + bb.width / 2, bb.y + bb.height / 2);
  await page.mouse.down();
  await page.mouse.move(bb.x + bb.width / 2 + 40, bb.y + bb.height / 2, { steps: 6 });
  await page.mouse.up();
  await expect.poll(() => commandLog(page)).toContain("set_clip_loop");
  const loopStart = await page.evaluate(() => {
    const st = (window as any).__moshStore.getState();
    return st.snapshot.tracks.flatMap((t: any) => t.clips).find((c: any) => c.type === "wave").loopStart;
  });
  expect(loopStart).toBeGreaterThan(0);
});

test("draw mode gives the editor grid a crosshair cursor (CSS affordance)", async ({ page }) => {
  await bootLive(page);
  await page.locator('.live-shell [data-testid="v2-clip"]').first().dblclick();
  await expect(page.locator(".live-shell .pr.docked")).toBeVisible();
  await page.getByTestId("live-draw").click();
  await expect
    .poll(() => page.locator(".live-shell .pr-grid").evaluate((el) => getComputedStyle(el).cursor))
    .toBe("crosshair");
  await page.getByTestId("live-draw").click();
  await expect
    .poll(() => page.locator(".live-shell .pr-grid").evaluate((el) => getComputedStyle(el).cursor))
    .not.toBe("crosshair");
});

test("hot-swap: a second instrument replaces the first; an effect still appends", async ({ page }) => {
  await bootLive(page);
  // the second mock instrument lives behind the deep scan (AU opt-in)
  await page.locator('[data-category="instruments"]').click();
  await page.getByTestId("live-scan-au").check();
  await page.getByTestId("live-rescan").click();
  await expect(page.getByTestId("live-brow").filter({ hasText: "Serum 2" })).toBeVisible();

  // instrument A loads (append — nothing to replace yet)
  await page.getByTestId("live-brow").filter({ hasText: "Vital" }).dblclick();
  await expect(page.getByTestId("live-device").filter({ hasText: "Vital" })).toBeVisible();

  // instrument B hot-swaps A: exactly one instrument chip, and it's B
  await page.getByTestId("live-brow").filter({ hasText: "Serum 2" }).dblclick();
  await expect(page.getByTestId("live-device").filter({ hasText: "Serum 2" })).toBeVisible();
  await expect(page.getByTestId("live-device").filter({ hasText: "Vital" })).toHaveCount(0);
  await expect.poll(() => page.evaluate(() => {
    const st = (window as any).__moshStore.getState();
    return st.snapshot.tracks[0].plugins.filter((p: any) => p.isInstrument).map((p: any) => p.name);
  })).toEqual(["Serum 2"]);

  // an EFFECT double-click still appends (chains of effects are legal). Exact-name
  // filter: the built-in "Mosh OTT" lists first and must not match.
  await page.locator('[data-category="effects"]').click();
  await page.getByTestId("live-brow")
    .filter({ has: page.locator(".live-brow-name") })
    .filter({ hasText: "OTT" })
    .filter({ has: page.getByText("OTT", { exact: true }) })
    .dblclick();
  await expect.poll(() => page.evaluate(() => {
    const st = (window as any).__moshStore.getState();
    return st.snapshot.tracks[0].plugins.map((p: any) => p.name);
  })).toEqual(["Serum 2", "OTT"]);

  // the swap was ONE transaction: after undoing the effect's append, ONE more undo
  // restores the pre-swap instrument
  await page.evaluate(async () => {
    const st = (window as any).__moshStore.getState();
    await st.exec("undo");   // removes the OTT append
    await st.exec("undo");   // reverts the swap
  });
  await expect.poll(() => page.evaluate(() => {
    const st = (window as any).__moshStore.getState();
    return st.snapshot.tracks[0].plugins.map((p: any) => p.name);
  })).toEqual(["Vital"]);
});

// ── Selection-follow: the dock's clip view tracks the CLIP SELECTION (Live 12) ─

test("single-click opens the clip's view (MIDI editor; wave audio editor)", async ({ page }) => {
  await bootLive(page);
  // devices posture at boot (nothing selected)
  await expect(page.getByTestId("live-devices")).toBeVisible();
  // single click — no double-click anywhere
  await page.locator('.live-shell [data-testid="v2-clip"]').first().click();
  await expect(page.locator(".live-shell .pr.docked")).toBeVisible();
  await expect.poll(() => storeVal<string | null>(page, "editingClipId")).not.toBeNull();
  // clicking the audio clip shows its wave editor instead
  await page.getByTestId("live-lane").nth(2).locator('[data-testid="v2-clip"]').click();
  await expect(page.getByTestId("live-audio-clip-editor")).toContainText("chords");
  await expect(page.locator(".live-shell .pr.docked")).toHaveCount(0);
});

test("clicking the current track name replaces the MIDI editor with Devices", async ({ page }) => {
  await bootLive(page);
  // Even if the user previously hid Devices on this same track, its name box is
  // the explicit way back to that posture.
  await page.getByRole("button", { name: "Hide the device view" }).click();
  await expect(page.getByTestId("live-devpanel")).toHaveCount(0);
  await page.locator('.live-shell [data-testid="v2-clip"]').first().click();
  await expect(page.locator(".live-shell .pr.docked")).toBeVisible();
  await expect(page.getByTestId("live-devpanel")).toHaveCount(0);
  await page.getByTestId("live-track-header").first().locator(".live-tname").click();
  await expect(page.locator(".live-shell .pr.docked")).toHaveCount(0);
  await expect.poll(() => storeVal<string | null>(page, "editingClipId")).toBeNull();
  await expect(page.getByTestId("live-devices")).toBeVisible();
  await expect(page.getByTestId("live-devpanel")).toBeVisible();
});

test("⌘-click on the shown clip keeps its view open (the ableton table has no toggle-off)", async ({ page }) => {
  await bootLive(page);
  const clip = page.locator('.live-shell [data-testid="v2-clip"]').first();
  await clip.click();
  await expect(page.locator(".live-shell .pr.docked")).toBeVisible();
  // The ableton gesture table binds no additive-toggle (a ⌘-click resolves to plain
  // SELECT — the codebase's additive select only ever ADDS), so the clip stays
  // selected and its view stays open. Deselect-close is reachable via empty-lane
  // click / track header / switching clips (all pinned elsewhere); the follow
  // logic's additive-deselect branch is unit-tested in selectionFollow.test.ts.
  await clip.click({ modifiers: ["Meta"] });
  await expect(page.locator(".live-shell .pr.docked")).toBeVisible();
  await expect.poll(() => storeVal<string | null>(page, "editingClipId")).not.toBeNull();
});

test("empty-lane CLICK closes the view; an empty-lane DRAG (time selection) keeps it", async ({ page }) => {
  await bootLive(page);
  await page.locator('.live-shell [data-testid="v2-clip"]').first().click();
  await expect(page.locator(".live-shell .pr.docked")).toBeVisible();

  // zoom out so REAL empty ground exists past the clips, and drive everything on
  // lane 0 — with the editor open the dock is ~480px and the lower lanes are
  // clipped behind it (clicks there hit the dock, not the lane).
  await page.keyboard.press("Meta+-");
  await page.keyboard.press("Meta+-");
  const lane = page.getByTestId("live-lane").nth(0);
  const box = (await lane.boundingBox())!;
  const pps = await storeVal<number>(page, "pxPerSec");

  // drag on empty ground → time selection paints, the view STAYS
  await page.mouse.move(box.x + 9 * pps, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + 11 * pps, box.y + box.height / 2, { steps: 6 });
  await page.mouse.up();
  await expect(page.getByTestId("live-timerange")).toBeVisible();
  await expect(page.locator(".live-shell .pr.docked")).toBeVisible();   // still open
  await expect.poll(() => storeVal<string | null>(page, "editingClipId")).not.toBeNull();

  // a plain click on empty ground (no travel) → deselect → the view CLOSES
  await page.mouse.click(box.x + 9.5 * pps, box.y + box.height / 2);
  await expect(page.locator(".live-shell .pr.docked")).toHaveCount(0);
  await expect.poll(() => storeVal<string | null>(page, "editingClipId")).toBeNull();
});

// ── Keymap-audit wave ─────────────────────────────────────────────────────────

test("↑/↓ nudge moves the selected clip to the adjacent track (boundary stays put)", async ({ page }) => {
  await bootLive(page);
  const clipId = await page.evaluate(() => {
    const st = (window as any).__moshStore.getState();
    const id = st.snapshot.tracks[0].clips[0].id;
    st.select([id]);
    return id;
  });
  // ↓: track 0 → track 1
  await page.keyboard.press("ArrowDown");
  await expect.poll(() => page.evaluate((id) => {
    const st = (window as any).__moshStore.getState();
    return st.snapshot.tracks.findIndex((t: any) => t.clips.some((c: any) => c.id === id));
  }, clipId)).toBe(1);
  // ↓ again → track 2; ↑ twice → back to track 0; ↑ at the boundary stays put
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("ArrowUp");
  await page.keyboard.press("ArrowUp");
  await expect.poll(() => page.evaluate((id) => {
    const st = (window as any).__moshStore.getState();
    return st.snapshot.tracks.findIndex((t: any) => t.clips.some((c: any) => c.id === id));
  }, clipId)).toBe(0);
  await page.keyboard.press("ArrowUp");
  await expect.poll(() => page.evaluate((id) => {
    const st = (window as any).__moshStore.getState();
    return st.snapshot.tracks.findIndex((t: any) => t.clips.some((c: any) => c.id === id));
  }, clipId)).toBe(0);
});

test("loop brace keys: ←/→ move by grid, ⌘←/⌘→ halve and double", async ({ page }) => {
  await bootLive(page);
  // arm a 2s loop at 2–4s via the seam, then drive the brace's keys
  await page.evaluate(async () => {
    await (window as any).__moshStore.getState().exec("set_transport", { loop: true, loopStart: 2, loopEnd: 4 });
  });
  const brace = page.getByTestId("live-loop-brace");
  await expect(brace).toBeVisible();
  await brace.focus();
  // grid = 1/4 division = 1 beat = 0.5s at 120bpm
  await page.keyboard.press("ArrowRight");
  await expect.poll(async () => [
    await storeVal<number>(page, "transport.loopStart"),
    await storeVal<number>(page, "transport.loopEnd"),
  ]).toEqual([2.5, 4.5]);
  await page.keyboard.press("Meta+ArrowRight");  // double: 2s → 4s
  await expect.poll(async () => [
    await storeVal<number>(page, "transport.loopStart"),
    await storeVal<number>(page, "transport.loopEnd"),
  ]).toEqual([2.5, 6.5]);
  await page.keyboard.press("Meta+ArrowLeft");   // halve back
  await expect.poll(async () => [
    await storeVal<number>(page, "transport.loopStart"),
    await storeVal<number>(page, "transport.loopEnd"),
  ]).toEqual([2.5, 4.5]);
  await page.keyboard.press("ArrowLeft");
  await expect.poll(async () => [
    await storeVal<number>(page, "transport.loopStart"),
    await storeVal<number>(page, "transport.loopEnd"),
  ]).toEqual([2, 4]);
});

test("loop brace drags: body moves the span, an edge resizes it", async ({ page }) => {
  await bootLive(page);
  await page.evaluate(async () => {
    await (window as any).__moshStore.getState().exec("set_transport", { loop: true, loopStart: 2, loopEnd: 4 });
  });
  const pps = await storeVal<number>(page, "pxPerSec");
  // body drag → move the whole 2s span right by 1s
  const body = page.getByTestId("live-loop-body");
  const bb = (await body.boundingBox())!;
  await page.mouse.move(bb.x + bb.width / 2, bb.y + bb.height / 2);
  await page.mouse.down();
  await page.mouse.move(bb.x + bb.width / 2 + pps, bb.y + bb.height / 2, { steps: 6 });
  await page.mouse.up();
  await expect.poll(async () => [
    await storeVal<number>(page, "transport.loopStart"),
    await storeVal<number>(page, "transport.loopEnd"),
  ]).toEqual([3, 5]);
  // right-edge drag → lengthen by 1s
  const edge = page.getByTestId("live-loop-edge-r");
  const eb = (await edge.boundingBox())!;
  await page.mouse.move(eb.x + eb.width / 2, eb.y + eb.height / 2);
  await page.mouse.down();
  await page.mouse.move(eb.x + eb.width / 2 + pps, eb.y + eb.height / 2, { steps: 6 });
  await page.mouse.up();
  await expect.poll(async () => [
    await storeVal<number>(page, "transport.loopStart"),
    await storeVal<number>(page, "transport.loopEnd"),
  ]).toEqual([3, 6]);
});

test("⌘I inserts silence over the time selection", async ({ page }) => {
  await bootLive(page);
  // paint the span through the lane empty-drag (the real gesture path)
  const lane = page.getByTestId("live-lane").nth(2);
  const box = (await lane.boundingBox())!;
  const pps = await storeVal<number>(page, "pxPerSec");
  await page.mouse.move(box.x + 1 * pps, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + 3 * pps, box.y + box.height / 2, { steps: 6 });
  await page.mouse.up();
  await expect(page.getByTestId("live-timerange")).toBeVisible();
  const before = await page.evaluate(() =>
    (window as any).__moshStore.getState().snapshot.tracks[2].clips[0].start);
  await page.keyboard.press("Meta+i");
  // insert_time opens 2s of space over the selection — the Keys clip (start 2) slides right
  await expect.poll(() => page.evaluate(() =>
    (window as any).__moshStore.getState().snapshot.tracks[2].clips[0].start)).toBe(before + 2);
});

test("⌘G groups the track selection when no clips are selected; ⇧⌘G ungroups", async ({ page }) => {
  await bootLive(page);
  // select track 0's header (no clip selection) and group it with track 1
  await page.getByTestId("live-track-header").nth(0).getByRole("button", { name: /Select track/ }).click();
  await page.keyboard.press("Meta+g");
  await expect.poll(() => page.evaluate(() => {
    const st = (window as any).__moshStore.getState();
    return {
      groups: st.snapshot.tracks.filter((t: any) => t.isGroup).length,
      parented: st.snapshot.tracks.filter((t: any) => t.parentId).length,
    };
  })).toEqual({ groups: 1, parented: 1 });
  // the group track is selected → ⇧⌘G unwraps it
  await page.keyboard.press("Meta+Shift+g");
  await expect.poll(() => page.evaluate(() => {
    const st = (window as any).__moshStore.getState();
    return {
      groups: st.snapshot.tracks.filter((t: any) => t.isGroup).length,
      parented: st.snapshot.tracks.filter((t: any) => t.parentId).length,
    };
  })).toEqual({ groups: 0, parented: 0 });
});

test("⌥⌘F applies Live's 4ms fade to selected audio clips only", async ({ page }) => {
  await bootLive(page);
  // select the wave clip on the Keys track
  await page.getByTestId("live-lane").nth(2).locator('[data-testid="v2-clip"]').click();
  await page.keyboard.press("Alt+Meta+f");
  await expect.poll(() => page.evaluate(() => {
    const st = (window as any).__moshStore.getState();
    const wave = st.snapshot.tracks[2].clips[0];
    return { fi: wave.fadeInSec, fo: wave.fadeOutSec };
  })).toEqual({ fi: 0.004, fo: 0.004 });
  // the MIDI clips on the other tracks were not faded
  await expect.poll(() => page.evaluate(() => {
    const st = (window as any).__moshStore.getState();
    return st.snapshot.tracks[0].clips[0].fadeInSec;
  })).toBeUndefined();
});

// ── Track-header I/O — real engine-backed routing, not stubs ──────────────────
// The header's I/O grid (TrackIoSection) replaces the old read-only stub cells.
// Every picker is REAL (options from the engine catalogs, the current value shown,
// the mutation through the one seam) or honestly DISABLED with the reason — the
// per-channel pickers Live shows have no engine command behind them yet.

test("header I/O: the input popup lists the catalogs and routes the pick through the seam", async ({ page }) => {
  await bootLive(page);
  const header = page.getByTestId("live-track-header").first();
  // closed popup = Live's "No Input" (the seed Drums track has no chosen input)
  const popup = header.getByTestId("live-io-in");
  await expect(popup).toContainText("No Input");
  await popup.click();
  // the menu is portaled to <body> (MoshMenu/Base UI) — locate it globally.
  // Drums is an instrument track, so MIDI inputs join the wave list; "None" leads.
  const opts = page.getByTestId("live-io-in-opt");
  await expect(opts.first()).toContainText("None");
  await expect(opts.filter({ hasText: "Mosh Keyboard" })).toHaveCount(1);
  await opts.filter({ hasText: "Input 1-2" }).click();
  await expect.poll(() => storeVal<string>(page, "snapshot.tracks.0.input.deviceID")).toBe("in-1-2");
  await expect(popup).toContainText("Input 1-2");
  await expect.poll(() => commandLog(page)).toContain("set_track_input");
  // reopen the SAME popup after the pick (the packaged-WKWebView regression this
  // pins: a stuck Root left the menu invisible on reopen — MoshMenu remounts on
  // close so no cross-close residue can persist; jsdom/Chromium never produced the
  // desync, which is why the original pins missed it)
  await popup.click();
  await expect(page.getByTestId("live-io-in-opt").first()).toBeVisible();
  await expect(page.getByTestId("live-io-in-opt").filter({ hasText: "Input 3-4" })).toHaveCount(1);
  await page.keyboard.press("Escape");
});

test("header I/O: a non-instrument track's input popup is wave-only", async ({ page }) => {
  await bootLive(page);
  // Keys (track 3) hosts no instrument → no MIDI inputs in its picker (CTL-001)
  const popup = page.getByTestId("live-track-header").nth(2).getByTestId("live-io-in");
  await popup.click();
  await expect(page.getByTestId("live-io-in-opt").filter({ hasText: "Mosh Keyboard" })).toHaveCount(0);
  await expect(page.getByTestId("live-io-in-opt").filter({ hasText: "Input 3-4" })).toHaveCount(1);
  await page.keyboard.press("Escape");
});

test("header I/O: the output popup routes to a hardware destination", async ({ page }) => {
  await bootLive(page);
  const header = page.getByTestId("live-track-header").first();
  const popup = header.getByTestId("live-io-out");
  await expect(popup).toContainText("Default output");
  await popup.click();
  await page.getByTestId("live-io-out-opt").filter({ hasText: "External Headphones" }).click();
  await expect.poll(() => storeVal<string>(page, "snapshot.tracks.0.output.deviceID")).toBe("out-3-4");
  await expect(popup).toContainText("External Headphones");
  await expect.poll(() => commandLog(page)).toContain("set_track_output");
});

test("header I/O: monitoring trio routes set_input_monitor", async ({ page }) => {
  await bootLive(page);
  const header = page.getByTestId("live-track-header").first();
  await header.getByTitle("Monitor In").click();
  await expect.poll(() => storeVal<string>(page, "snapshot.tracks.0.monitor")).toBe("on");
  await header.getByTitle("Monitor Off").click();
  await expect.poll(() => storeVal<string>(page, "snapshot.tracks.0.monitor")).toBe("off");
  await expect.poll(() => commandLog(page)).toContain("set_input_monitor");
});

test("header I/O: volume drags through the seam and double-click resets to unity", async ({ page }) => {
  await bootLive(page);
  const header = page.getByTestId("live-track-header").first();
  const vol = header.getByTestId("live-io-volume");
  await vol.fill("-10");
  await expect.poll(() => storeVal<number>(page, "snapshot.tracks.0.volumeDb")).toBe(-10);
  await expect.poll(() => commandLog(page)).toContain("set_track_volume");
  await vol.dblclick();
  await expect.poll(() => storeVal<number>(page, "snapshot.tracks.0.volumeDb")).toBe(0);
});

test("header I/O: pan drags through the seam and double-click resets to centre", async ({ page }) => {
  await bootLive(page);
  const pan = page.getByTestId("live-track-header").first().getByTestId("live-io-pan");
  await pan.fill("0.5");
  await expect.poll(() => storeVal<number>(page, "snapshot.tracks.0.pan")).toBe(0.5);
  await expect.poll(() => commandLog(page)).toContain("set_track_pan");
  await pan.dblclick();
  await expect.poll(() => storeVal<number>(page, "snapshot.tracks.0.pan")).toBe(0);
});

test("header I/O: per-channel pickers are honestly disabled (no engine command yet)", async ({ page }) => {
  await bootLive(page);
  const header = page.getByTestId("live-track-header").first();
  // Live shows a finer channel picker next to each routing popup; the engine only
  // takes a whole device/pair, so these cells are inert — never a fake popup.
  await expect(header.getByTestId("live-io-in-chan")).toBeDisabled();
  await expect(header.getByTestId("live-io-out-chan")).toBeDisabled();
});

// ── Crop Clip (⇧⌘J) — real engine-backed crop, arrangement-context ────────────
// The time selection is drawn on the Keys lane's empty ground (the span is
// global); clicking a clip afterwards selects it WITHOUT clearing the span
// (Live's rule — empty-ground clicks clear selections, clip clicks don't).

test("⇧⌘J crops the selected clip to the time selection; one undo restores bounds AND notes", async ({ page }) => {
  await bootLive(page);
  // Live's own workflow: click the Drums clip to select it, then drag the span
  // over its BODY — the ableton table maps a clip-body drag to TIME_SELECT, and a
  // drag (unlike a plain empty click) does not clear the clip selection.
  const lane = page.getByTestId("live-lane").nth(0);
  await lane.locator('[data-testid="v2-clip"]').click();
  const box = await lane.boundingBox();
  if (!box) throw new Error("no lane");
  const pps = await storeVal<number>(page, "pxPerSec");
  const y = box.y + box.height / 2;
  await page.mouse.move(box.x + 2.5 * pps, y);
  await page.mouse.down();
  await page.mouse.move(box.x + 5.0 * pps, y, { steps: 8 });
  await page.mouse.up();
  await expect(page.getByTestId("live-timerange")).toBeVisible();
  await expect(page.getByTestId("live-lane").nth(0).locator('[data-testid="v2-clip"].sel')).toHaveCount(1);

  const notesBefore = await storeVal<number>(page, "snapshot.tracks.0.clips.0.notes.length");
  await page.keyboard.press("Shift+Meta+j");
  await expect.poll(() => storeVal<number>(page, "snapshot.tracks.0.clips.0.start")).toBeCloseTo(2.5, 3);
  expect(await storeVal<number>(page, "snapshot.tracks.0.clips.0.length")).toBeCloseTo(2.5, 3);
  await expect.poll(() => storeVal<number>(page, "snapshot.tracks.0.clips.0.notes.length")).toBeLessThan(notesBefore);
  // every remaining note lives inside the crop, re-anchored clip-local (5 beats at 120bpm)
  const maxEnd = await page.evaluate(() => {
    const st = (window as any).__moshStore.getState();
    return Math.max(...st.snapshot.tracks[0].clips[0].notes.map((n: any) => n.start + n.length));
  });
  expect(maxEnd).toBeLessThanOrEqual(5.0 + 1e-6);
  await expect.poll(() => commandLog(page)).toContain("crop_clip");

  // ONE undo restores bounds AND the removed notes (single transaction)
  await page.keyboard.press("Meta+z");
  await expect.poll(() => storeVal<number>(page, "snapshot.tracks.0.clips.0.start")).toBeCloseTo(0, 3);
  await expect.poll(() => storeVal<number>(page, "snapshot.tracks.0.clips.0.notes.length")).toBe(notesBefore);
});

test("⇧⌘J without a time selection surfaces the honest error and sends nothing", async ({ page }) => {
  await bootLive(page);
  await page.getByTestId("live-lane").nth(0).locator('[data-testid="v2-clip"]').click();
  await page.keyboard.press("Shift+Meta+j");
  await expect(page.getByTestId("live-error")).toContainText("time selection");
  await expect.poll(() => commandLog(page)).not.toContain("crop_clip");
});

test("the clip context menu's Crop Clip row is enabled and runs the crop", async ({ page }) => {
  await bootLive(page);
  // select the Drums clip, then body-drag a 2.5s→5.0s span over it (see above)
  const lane = page.getByTestId("live-lane").nth(0);
  await lane.locator('[data-testid="v2-clip"]').click();
  const box = await lane.boundingBox();
  if (!box) throw new Error("no lane");
  const pps = await storeVal<number>(page, "pxPerSec");
  const y = box.y + box.height / 2;
  await page.mouse.move(box.x + 2.5 * pps, y);
  await page.mouse.down();
  await page.mouse.move(box.x + 5.0 * pps, y, { steps: 8 });
  await page.mouse.up();
  await expect(page.getByTestId("live-timerange")).toBeVisible();
  // right-click the Drums clip → the context menu's Crop row is REAL (not disabled)
  await page.getByTestId("live-lane").nth(0).locator('[data-testid="v2-clip"]').click({ button: "right" });
  const crop = page.getByTestId("live-ctx-crop");
  await expect(crop).toBeEnabled();
  await crop.click();
  await expect.poll(() => storeVal<number>(page, "snapshot.tracks.0.clips.0.start")).toBeCloseTo(2.5, 3);
  await expect.poll(() => commandLog(page)).toContain("crop_clip");
});

// ── Velocity tool row (Live 12 parity) — docked piano roll ────────────────────
// The docked editor's tool strip above the VEL lane: Randomize ±n, Ramp lo→hi in
// time order, Deviation ±offset — one transform_velocities command per apply.

test("velocity tools: Ramp 20→120 lands on every note in time order, one undo restores", async ({ page }) => {
  await bootLive(page);
  // open the Drums clip in the docked editor
  await page.getByTestId("live-lane").nth(0).locator('[data-testid="v2-clip"]').click();
  await expect(page.locator(".live-shell .pr.docked")).toBeVisible();
  await expect(page.getByTestId("pr-veltools")).toBeVisible();

  const velsBefore = await page.evaluate(() => {
    const st = (window as any).__moshStore.getState();
    return st.snapshot.tracks[0].clips[0].notes.map((n: any) => n.velocity);
  });
  // commit the fields (Enter applies the commit) and apply the ramp
  await page.getByTestId("pr-vt-ramp-lo").fill("20");
  await page.getByTestId("pr-vt-ramp-lo").press("Enter");
  await page.getByTestId("pr-vt-ramp-hi").fill("120");
  await page.getByTestId("pr-vt-ramp-hi").press("Enter");
  await page.getByTestId("pr-vt-ramp").click();

  await expect.poll(() => page.evaluate(() => {
    const st = (window as any).__moshStore.getState();
    const notes = st.snapshot.tracks[0].clips[0].notes;
    const byStart = [...notes].sort((a: any, b: any) => (a.start - b.start) || (a.pitch - b.pitch));
    return [byStart[0].velocity, byStart[byStart.length - 1].velocity];
  })).toEqual([20, 120]);
  // strictly non-decreasing in time order (ties allowed by the linear ramp)
  const monotonic = await page.evaluate(() => {
    const st = (window as any).__moshStore.getState();
    const byStart = [...st.snapshot.tracks[0].clips[0].notes].sort((a: any, b: any) => (a.start - b.start) || (a.pitch - b.pitch));
    return byStart.every((n: any, i: number) => i === 0 || n.velocity >= byStart[i - 1].velocity);
  });
  expect(monotonic).toBe(true);
  await expect.poll(() => commandLog(page)).toContain("transform_velocities");

  await page.keyboard.press("Meta+z");
  await expect.poll(() => page.evaluate(() => {
    const st = (window as any).__moshStore.getState();
    return st.snapshot.tracks[0].clips[0].notes.map((n: any) => n.velocity);
  })).toEqual(velsBefore);
});

test("velocity tools: a replayed Deviate is deterministic, and a selection scopes the ramp", async ({ page }) => {
  await bootLive(page);
  await page.getByTestId("live-lane").nth(0).locator('[data-testid="v2-clip"]').click();
  await expect(page.locator(".live-shell .pr.docked")).toBeVisible();

  const readVels = () => page.evaluate(() => {
    const st = (window as any).__moshStore.getState();
    return st.snapshot.tracks[0].clips[0].notes.map((n: any) => n.velocity);
  });
  await page.getByTestId("pr-vt-deviate-amt").fill("25");
  await page.getByTestId("pr-vt-deviate-amt").press("Enter");
  await page.getByTestId("pr-vt-deviate").click();
  await expect.poll(readVels).not.toEqual(await page.evaluate(() => {
    const st = (window as any).__moshStore.getState();
    return st.snapshot.tracks[0].clips[0].notes.map(() => 100);
  }));
  const run1 = await readVels();
  await page.keyboard.press("Meta+z");
  await page.getByTestId("pr-vt-deviate").click();
  await expect.poll(readVels).toEqual(run1);   // deterministic per command
  await page.keyboard.press("Meta+z");

  // selection scoping: select ONE note (click it), ramp 30→90 — only it moves
  const first = page.locator(".live-shell [data-testid='pr-note']").first();
  await first.click();
  await page.getByTestId("pr-vt-ramp-lo").fill("30");
  await page.getByTestId("pr-vt-ramp-lo").press("Enter");
  await page.getByTestId("pr-vt-ramp-hi").fill("90");
  await page.getByTestId("pr-vt-ramp-hi").press("Enter");
  const before = await readVels();
  await page.getByTestId("pr-vt-ramp").click();
  await expect.poll(async () => {
    const after = await readVels();
    return after.filter((v: number, i: number) => v !== before[i]).length;
  }, { message: "exactly one note's velocity changed" }).toBe(1);
});

// ── Transform tools row (Live 12 parity) — docked piano roll ─────────────────
// The docked editor's Transform strip above the velocity row: Reverse / Invert /
// Legato / Humanize ±amount / ×2 / /2 — one transform_notes command per apply.

test("transform tools: the row renders in Live's order; Reverse mirrors in-span, one undo restores", async ({ page }) => {
  await bootLive(page);
  await page.getByTestId("live-lane").nth(0).locator('[data-testid="v2-clip"]').click();
  await expect(page.locator(".live-shell .pr.docked")).toBeVisible();
  const strip = page.getByTestId("pr-transformtools");
  await expect(strip).toBeVisible();
  // Live's panel order: Reverse Invert Legato Humanize ×2 /2, then the second
  // cluster Set Length / Add Interval / Fit to Scale (the fields are inputs)
  const ids = await strip.locator("button").evaluateAll((bs) => bs.map((b) => b.getAttribute("data-testid")));
  expect(ids).toEqual(["pr-xf-reverse", "pr-xf-invert", "pr-xf-legato", "pr-xf-humanize", "pr-xf-x2", "pr-xf-d2",
                       "pr-xf-setlen", "pr-xf-interval", "pr-xf-fitscale"]);

  const notesBefore = await page.evaluate(() => {
    const st = (window as any).__moshStore.getState();
    return st.snapshot.tracks[0].clips[0].notes.map((n: any) => ({ start: n.start, length: n.length, pitch: n.pitch, velocity: n.velocity }));
  });
  await page.getByTestId("pr-xf-reverse").click();
  await expect.poll(() => commandLog(page)).toContain("transform_notes");
  await expect.poll(() => page.evaluate(() => {
    const st = (window as any).__moshStore.getState();
    return st.snapshot.tracks[0].clips[0].notes[0].start;
  })).not.toBe(notesBefore[0].start);
  // span kept, pitch multiset kept — reverse is a pure time-mirror
  const after = await page.evaluate(() => {
    const st = (window as any).__moshStore.getState();
    return st.snapshot.tracks[0].clips[0].notes.map((n: any) => ({ start: n.start, length: n.length, pitch: n.pitch }));
  });
  const span = (ns: any[]) => {
    const s = Math.min(...ns.map((n) => n.start)), e = Math.max(...ns.map((n) => n.start + n.length));
    return [s, e];
  };
  expect(span(after)).toEqual(span(notesBefore));
  expect(after.map((n: any) => n.pitch).sort((a: number, b: number) => a - b)).toEqual(notesBefore.map((n: any) => n.pitch).sort((a: number, b: number) => a - b));

  await page.keyboard.press("Meta+z");
  await expect.poll(() => page.evaluate(() => {
    const st = (window as any).__moshStore.getState();
    return JSON.stringify(st.snapshot.tracks[0].clips[0].notes.map((n: any) => [n.start, n.length, n.pitch, n.velocity]));
  })).toBe(JSON.stringify(notesBefore.map((n: any) => [n.start, n.length, n.pitch, n.velocity])));
});

test("transform tools: ×2 doubles starts and lengths relative to the span start", async ({ page }) => {
  await bootLive(page);
  await page.getByTestId("live-lane").nth(0).locator('[data-testid="v2-clip"]').click();
  await expect(page.locator(".live-shell .pr.docked")).toBeVisible();
  const before = await page.evaluate(() => {
    const st = (window as any).__moshStore.getState();
    return st.snapshot.tracks[0].clips[0].notes.map((n: any) => ({ start: n.start, length: n.length }));
  });
  const s0 = Math.min(...before.map((n: any) => n.start));
  await page.getByTestId("pr-xf-x2").click();
  await expect.poll(() => commandLog(page)).toContain("transform_notes");
  const after = await page.evaluate(() => {
    const st = (window as any).__moshStore.getState();
    return st.snapshot.tracks[0].clips[0].notes.map((n: any) => ({ start: n.start, length: n.length }));
  });
  expect(after.length).toBe(before.length);
  after.forEach((n: any, i: number) => {
    expect(n.start).toBeCloseTo(s0 + 2 * (before[i].start - s0), 6);
    expect(n.length).toBeCloseTo(2 * before[i].length, 6);
  });
});

test("transform tools: Fit to Scale snaps the out-of-key hats into the session key", async ({ page }) => {
  await bootLive(page);
  await page.getByTestId("live-lane").nth(0).locator('[data-testid="v2-clip"]').click();
  await expect(page.locator(".live-shell .pr.docked")).toBeVisible();
  const before = await page.evaluate(() => {
    const st = (window as any).__moshStore.getState();
    return st.snapshot.tracks[0].clips[0].notes.map((n: any) => n.pitch);
  });
  expect(new Set(before)).toEqual(new Set([36, 38, 42]));   // kick/snare/hats fixture
  await page.getByTestId("pr-xf-fitscale").click();
  await expect.poll(() => commandLog(page)).toContain("transform_notes");
  const after = await page.evaluate(() => {
    const st = (window as any).__moshStore.getState();
    return st.snapshot.tracks[0].clips[0].notes.map((n: any) => n.pitch);
  });
  // the mock's session key is A minor (all naturals): 42 (F#) → 41 (F), tie down
  expect(new Set(after)).toEqual(new Set([36, 38, 41]));
  expect(after.length).toBe(before.length);   // pitches snapped, notes never removed
});

// ── Bounce (Live 12 parity) — track offline-render to audio ────────────────────
// bounce_track renders the track's full output; inPlace replaces its clips with
// the render (devices stay), ⌘B / the menus land it on a new track below.

test("bounce to new track: the track-header menu row renders below the untouched source", async ({ page }) => {
  await bootLive(page);
  const header = page.getByTestId("live-track-header").first();
  await header.click({ button: "right" });
  await expect(page.getByTestId("live-tm-bounce-new")).toBeEnabled();
  await expect(page.getByTestId("live-tm-bounce-inplace")).toBeEnabled();
  await expect(page.getByTestId("live-tm-freeze")).toBeEnabled();   // freeze wave: real
  await page.getByTestId("live-tm-bounce-new").click();
  await expect.poll(() => page.evaluate(() => (window as any).__moshStore.getState().snapshot.tracks.length)).toBe(4);
  const state = await page.evaluate(() => {
    const st = (window as any).__moshStore.getState();
    const t = st.snapshot.tracks;
    return {
      srcClips: t[0].clips.map((c: any) => c.type),
      newName: t[1].name, newClips: t[1].clips.map((c: any) => c.type),
    };
  });
  expect(state.srcClips).toEqual(["midi"]);                       // source untouched
  expect(state.newName).toContain("bounce");
  expect(state.newClips).toEqual(["wave"]);                       // render below it
  await expect.poll(() => commandLog(page)).toContain("bounce_track");
  // ONE undo removes the bounce track
  await page.keyboard.press("Meta+z");
  await expect.poll(() => page.evaluate(() => (window as any).__moshStore.getState().snapshot.tracks.length)).toBe(3);
});

test("⌘B bounces the selected track to a new track; inPlace replaces clips and keeps devices", async ({ page }) => {
  await bootLive(page);
  // select the Drums track and press ⌘B
  await page.getByTestId("live-track-header").first().locator(".live-tname").click();
  await page.keyboard.press("Meta+b");
  await expect.poll(() => page.evaluate(() => (window as any).__moshStore.getState().snapshot.tracks.length)).toBe(4);
  await expect.poll(() => commandLog(page)).toContain("bounce_track");
  await page.keyboard.press("Meta+z");
  await expect.poll(() => page.evaluate(() => (window as any).__moshStore.getState().snapshot.tracks.length)).toBe(3);

  // inPlace via the header menu: clips replaced by one wave clip, plugins stay
  const pluginsBefore = await page.evaluate(() => (window as any).__moshStore.getState().snapshot.tracks[0].plugins.length);
  const header = page.getByTestId("live-track-header").first();
  await header.click({ button: "right" });
  await page.getByTestId("live-tm-bounce-inplace").click();
  await expect.poll(() => page.evaluate(() => {
    const st = (window as any).__moshStore.getState();
    return st.snapshot.tracks[0].clips.map((c: any) => c.type).join(",");
  })).toBe("wave");
  const pluginsAfter = await page.evaluate(() => (window as any).__moshStore.getState().snapshot.tracks[0].plugins.length);
  expect(pluginsAfter).toBe(pluginsBefore);
  await page.keyboard.press("Meta+z");
  await expect.poll(() => page.evaluate(() => {
    const st = (window as any).__moshStore.getState();
    return st.snapshot.tracks[0].clips.map((c: any) => c.type).join(",");
  })).toBe("midi");
});

test("the clip context menu's Bounce row is enabled and bounces the clip's track", async ({ page }) => {
  await bootLive(page);
  await page.getByTestId("live-lane").nth(0).locator('[data-testid="v2-clip"]').click({ button: "right" });
  const bounce = page.getByTestId("live-ctx-bounce");
  await expect(bounce).toBeEnabled();
  await bounce.click();
  await expect.poll(() => page.evaluate(() => (window as any).__moshStore.getState().snapshot.tracks.length)).toBe(4);
  await expect.poll(() => commandLog(page)).toContain("bounce_track");
});

// ── Freeze Track (Live 12 parity, ⌥⇧⌘F) ─────────────────────────────────────
// freeze_track renders the track through its chain, swaps the clips for the
// render and parks the devices; the central seam then refuses clip-content +
// device edits while frozen (structure ops stay allowed). Unfreeze re-enables
// the devices — the rendered clip STAYS. The ⌥⇧⌘F key toggles (Live's rule).

test("freeze via the header menu: rendered clip, parked devices, locked edits, unfreeze restores", async ({ page }) => {
  await bootLive(page);
  // give the track a device to park
  await page.evaluate(async () => {
    const st = (window as any).__moshStore.getState();
    await st.exec("load_plugin", { trackId: st.snapshot.tracks[0].id, pluginId: "ott" });
  });
  const header = page.getByTestId("live-track-header").first();
  await header.click({ button: "right" });
  const freezeRow = page.getByTestId("live-tm-freeze");
  await expect(freezeRow).toContainText("Freeze Track");
  await freezeRow.click();
  // frozen: one WAVE clip [the render], every device parked, the marker on the track
  await expect.poll(() => page.evaluate(() => {
    const st = (window as any).__moshStore.getState();
    const t = st.snapshot.tracks[0];
    return JSON.stringify({
      frozen: t.frozen === true,
      clips: t.clips.map((c: any) => c.type),
      parked: t.plugins.length > 0 && t.plugins.every((p: any) => p.enabled === false),
    });
  })).toBe(JSON.stringify({ frozen: true, clips: ["wave"], parked: true }));
  await expect.poll(() => commandLog(page)).toContain("freeze_track");
  // the frozen visual treatment: lane + header carry the frozen marker
  await expect(page.getByTestId("live-lane").first()).toHaveClass(/frozen/);
  await expect(page.getByTestId("live-track-header").first()).toHaveAttribute("data-frozen", "true");
  // the row flips to Unfreeze (Live's same-row toggle)
  await header.click({ button: "right" });
  await expect(page.getByTestId("live-tm-freeze")).toContainText("Unfreeze Track");
  await page.keyboard.press("Escape");
  // the frozen-editing lock: clip-content + device mutations refuse; structure allowed
  const lockRes = await page.evaluate(async () => {
    const st = (window as any).__moshStore.getState();
    const t = st.snapshot.tracks[0];
    const setNote = await st.exec("set_note", { clipId: t.clips[0].id, noteId: "n0", pitch: 60 });
    const loadPlugin = await st.exec("load_plugin", { trackId: t.id, pluginId: "vital" });
    const move = await st.exec("move_clip", { clipId: t.clips[0].id, start: 1 });
    // re-get state: exec replaces the store's snapshot object (the captured ref is stale)
    return { setNote, loadPlugin, moveOk: move.ok,
             start: (window as any).__moshStore.getState().snapshot.tracks[0].clips[0].start };
  });
  expect(lockRes.setNote.ok).toBe(false);
  expect(lockRes.setNote.error).toContain("frozen");
  expect(lockRes.loadPlugin.ok).toBe(false);
  expect(lockRes.loadPlugin.error).toContain("frozen");
  expect(lockRes.moveOk).toBe(true);   // Live lets you move the frozen clip
  expect(lockRes.start).toBeCloseTo(1, 3);
  // unfreeze via the menu: devices back on, the rendered clip STAYS
  await header.click({ button: "right" });
  await page.getByTestId("live-tm-freeze").click();
  await expect.poll(() => page.evaluate(() => {
    const st = (window as any).__moshStore.getState();
    const t = st.snapshot.tracks[0];
    return JSON.stringify({
      frozen: t.frozen === true,
      clips: t.clips.map((c: any) => c.type),
      live: t.plugins.length > 0 && t.plugins.every((p: any) => p.enabled !== false),
    });
  })).toBe(JSON.stringify({ frozen: false, clips: ["wave"], live: true }));
  await expect.poll(() => commandLog(page)).toContain("unfreeze_track");
  await expect(page.getByTestId("live-lane").first()).not.toHaveClass(/frozen/);
});

test("⌥⇧⌘F freezes the selected track and again unfreezes it (Live's toggle)", async ({ page }) => {
  await bootLive(page);
  await page.getByTestId("live-track-header").first().locator(".live-tname").click();
  await page.keyboard.press("Meta+Shift+Alt+F");
  await expect.poll(() => page.evaluate(() => (window as any).__moshStore.getState().snapshot.tracks[0].frozen === true)).toBe(true);
  await expect.poll(() => commandLog(page)).toContain("freeze_track");
  // same key again — Live's same-key unfreeze
  await page.keyboard.press("Meta+Shift+Alt+F");
  await expect.poll(() => page.evaluate(() => (window as any).__moshStore.getState().snapshot.tracks[0].frozen === true)).toBe(false);
  await expect.poll(() => commandLog(page)).toContain("unfreeze_track");
});

// ── Take lanes (Live 12 parity) — sub-lanes, switch, keep, collapse ──────────
// A wave clip with numTakes > 1 shows one sub-lane row per take index below its
// track's lane; click switches the current take (undoable), Keep flattens, and
// the header's ▸/▾ collapses the lanes (UI-local). Fixture via the mock's real
// record flow: arm the Keys track, record+stop twice → two takes, Take 2 current.
async function seedTwoTakes(page: any): Promise<{ keysId: string; takeClipId: string }> {
  return await page.evaluate(async () => {
    const st = (window as any).__moshStore.getState();
    const keysId = st.snapshot.tracks[2].id;
    await st.exec("arm_track", { trackId: keysId, armed: true });
    await st.exec("set_transport", { action: "record" });
    await st.exec("stop_recording", {});
    await st.exec("set_transport", { action: "record" });
    await st.exec("stop_recording", {});
    const snap = (window as any).__moshStore.getState().snapshot;
    const clip = snap.tracks[2].clips.find((c: any) => (c.numTakes ?? 0) > 1);
    return { keysId, takeClipId: clip.id };
  });
}

test("take lanes: rows render for a comp clip, click switches current (undoable)", async ({ page }) => {
  await bootLive(page);
  const { keysId } = await seedTwoTakes(page);
  const lanes = page.locator(`[data-testid="live-takelanes"][data-track-id="${keysId}"]`);
  await expect(lanes).toBeVisible();
  await expect(lanes.getByTestId("live-takerow")).toHaveCount(2);
  const bars = lanes.getByTestId("live-takebar");
  await expect(bars).toHaveCount(2);
  // Take 2 is current after the second landing (the mock's record flow)
  await expect(bars.nth(1)).toHaveAttribute("data-current", "true");
  await expect(bars.nth(1)).toContainText("Take 2");
  // click Take 1 → set_current_take, the highlight moves
  await bars.nth(0).click();
  await expect.poll(() => commandLog(page)).toContain("set_current_take");
  await expect(bars.nth(0)).toHaveAttribute("data-current", "true");
  await expect(bars.nth(1)).toHaveAttribute("data-current", "false");
  // one undo switches it back
  await page.keyboard.press("Meta+z");
  await expect(bars.nth(1)).toHaveAttribute("data-current", "true");
});

test("take lanes: the header toggle collapses/expands, Keep flattens (undoable)", async ({ page }) => {
  await bootLive(page);
  const { keysId } = await seedTwoTakes(page);
  const lanes = page.locator(`[data-testid="live-takelanes"][data-track-id="${keysId}"]`);
  await expect(lanes).toBeVisible();
  const header = page.locator(`[data-testid="live-track-header"][data-track-id="${keysId}"]`);
  const toggle = header.getByTestId("live-take-toggle");
  await expect(toggle).toContainText("2 takes");
  // collapse → lanes gone, the track keeps its comp (the clip still has takes)
  await toggle.click();
  await expect(lanes).toHaveCount(0);
  const numTakes = await page.evaluate(() => {
    const st = (window as any).__moshStore.getState();
    return st.snapshot.tracks[2].clips.find((c: any) => (c.numTakes ?? 0) > 1)?.numTakes;
  });
  expect(numTakes).toBe(2);
  await toggle.click();
  await expect(lanes).toBeVisible();
  // Keep on the current take → keep_take flattens; the lanes disappear entirely
  await lanes.getByTestId("live-take-keep").click();
  await expect.poll(() => commandLog(page)).toContain("keep_take");
  await expect(page.getByTestId("live-takebar")).toHaveCount(0);
  await expect(toggle).toHaveCount(0);
  const flat = await page.evaluate(() => {
    const st = (window as any).__moshStore.getState();
    return st.snapshot.tracks[2].clips.every((c: any) => (c.numTakes ?? 0) <= 1);
  });
  expect(flat).toBe(true);
  // one undo brings the comp (and its lanes) back
  await page.keyboard.press("Meta+z");
  await expect(lanes).toBeVisible();
  await expect(lanes.getByTestId("live-takebar")).toHaveCount(2);
});

test("take lanes: take bars draw per-take waveform ink (distinct per take), switch still works", async ({ page }) => {
  await bootLive(page);
  const { keysId } = await seedTwoTakes(page);
  const lanes = page.locator(`[data-testid="live-takelanes"][data-track-id="${keysId}"]`);
  await expect(lanes).toBeVisible();
  const waves = lanes.getByTestId("live-takewave");
  await expect(waves).toHaveCount(2);   // both takes have peaks → both draw ink
  const painted = await page.evaluate(() => {
    const out: { anyInk: boolean; img: string }[] = [];
    for (const c of document.querySelectorAll<HTMLCanvasElement>('[data-testid="live-takewave"]')) {
      const ctx = c.getContext("2d")!;
      const d = ctx.getImageData(0, 0, c.width, c.height).data;
      let anyInk = false;
      for (let i = 3; i < d.length; i += 4) if (d[i] > 0) { anyInk = true; break; }
      out.push({ anyInk, img: c.toDataURL() });
    }
    return out;
  });
  expect(painted.length).toBe(2);
  expect(painted.every((w) => w.anyInk)).toBe(true);        // real painted pixels
  expect(painted[0].img).not.toBe(painted[1].img);          // the two takes differ
  // the lanes still behave: clicking the first bar switches the current take
  const bars = lanes.getByTestId("live-takebar");
  await bars.nth(0).click();
  await expect(bars.nth(0)).toHaveAttribute("data-current", "true");
  await page.keyboard.press("Meta+z");
});

// ── Audio Consolidate (⌘J on wave clips, Live 12 parity) ──────────────────────
test("⌘J consolidates two WAVE clips into one rendered audio clip; one undo restores both", async ({ page }) => {
  await bootLive(page);
  // split the Keys wave clip at 4s → two wave clips [2,4] and [4,8]
  await page.evaluate(async () => {
    const st = (window as any).__moshStore.getState();
    await st.exec("split_clip", { clipId: st.snapshot.tracks[2].clips[0].id, time: 4 });
  });
  const lane = page.getByTestId("live-lane").nth(2);
  await expect(lane.locator('[data-testid="v2-clip"]')).toHaveCount(2);
  // select both halves and consolidate via the clip menu (enabled for wave now)
  await page.evaluate(() => {
    const st = (window as any).__moshStore.getState();
    st.select(st.snapshot.tracks[2].clips.map((c: any) => c.id));
  });
  await lane.locator('[data-testid="v2-clip"]').first().click({ button: "right" });
  const cons = page.getByTestId("live-ctx-consolidate");
  await expect(cons).toBeEnabled();
  await cons.click();
  await expect.poll(() => page.evaluate(() => {
    const st = (window as any).__moshStore.getState();
    return st.snapshot.tracks[2].clips.length;
  })).toBe(1);
  const merged = await page.evaluate(() => {
    const st = (window as any).__moshStore.getState();
    const c = st.snapshot.tracks[2].clips[0];
    return { type: c.type, start: c.start, length: c.length };
  });
  expect(merged).toEqual({ type: "wave", start: 2, length: 6 });   // span of the sources [2,8]
  await expect.poll(() => commandLog(page)).toContain("consolidate_clips");
  // ONE undo restores both originals
  await page.keyboard.press("Meta+z");
  await expect.poll(() => page.evaluate(() => {
    const st = (window as any).__moshStore.getState();
    return st.snapshot.tracks[2].clips.map((c: any) => c.type).join(",");
  })).toBe("wave,wave");
  await expect(lane.locator('[data-testid="v2-clip"]')).toHaveCount(2);
});

// ── Zoom history (Live 12's real X/Z semantics) ───────────────────────────────
// X pops the view history recorded at every zoom mutation; Z zooms to the time
// selection (falling back to content fit when nothing is drawn).

test("X steps BACK through the zoom history one entry per press", async ({ page }) => {
  await bootLive(page);
  const start = await storeVal<number>(page, "pxPerSec");
  // two meaningful zoom changes, spaced past the 300ms coalesce window
  await page.keyboard.press("Meta+=");
  await expect.poll(() => storeVal<number>(page, "pxPerSec")).toBeGreaterThan(start);
  const mid = await storeVal<number>(page, "pxPerSec");
  await page.waitForTimeout(400);
  await page.keyboard.press("Meta+=");
  await expect.poll(() => storeVal<number>(page, "pxPerSec")).toBeGreaterThan(mid);
  // X once → back to mid; X again → back to start
  await page.keyboard.press("x");
  await expect.poll(() => storeVal<number>(page, "pxPerSec")).toBe(mid);
  await page.keyboard.press("x");
  await expect.poll(() => storeVal<number>(page, "pxPerSec")).toBe(start);
});

test("X restores the exact far-right scroll after expanding the arrangement width", async ({ page }) => {
  await bootLive(page);
  const timeline = page.getByTestId("live-timeline");
  await page.evaluate(() => (window as any).__moshStore.getState().setPxPerSec(400));
  await expect.poll(() => storeVal<number>(page, "pxPerSec")).toBe(400);
  const recordedScroll = await timeline.evaluate((el) => {
    el.scrollLeft = el.scrollWidth;
    el.dispatchEvent(new Event("scroll"));
    return el.scrollLeft;
  });
  expect(recordedScroll).toBeGreaterThan(1000);

  await page.keyboard.press("Meta+-");
  await expect.poll(() => storeVal<number>(page, "pxPerSec")).toBe(320);
  await page.waitForTimeout(50);
  await page.keyboard.press("x");
  await expect.poll(() => storeVal<number>(page, "pxPerSec")).toBe(400);
  await expect.poll(() => page.evaluate(() => ({
    timeline: (document.querySelector(".live-lanes-scroll") as HTMLElement).scrollLeft,
    top: (document.querySelector(".live-ruler-clip") as HTMLElement).scrollLeft,
    bottom: (document.querySelector(".live-time-ruler-clip") as HTMLElement).scrollLeft,
  }))).toEqual({ timeline: recordedScroll, top: recordedScroll, bottom: recordedScroll });
});

test("X history never crosses a same-page project replacement", async ({ page }) => {
  await bootLive(page);
  const timeline = page.getByTestId("live-timeline");
  await page.evaluate(() => (window as any).__moshStore.getState().setPxPerSec(400));
  await expect.poll(() => storeVal<number>(page, "pxPerSec")).toBe(400);
  await timeline.evaluate((el) => {
    el.scrollLeft = el.scrollWidth;
    el.dispatchEvent(new Event("scroll"));
  });
  await page.keyboard.press("Meta+-");
  await expect.poll(() => storeVal<number>(page, "pxPerSec")).toBe(320);

  const epochBeforeReplacement = await storeVal<number>(page, "projectEpoch");
  await page.evaluate(async () => {
    const store = (window as any).__moshStore;
    await store.getState().exec("open_without_plugins", {});
    store.getState().setPxPerSec(80);
  });
  await expect.poll(() => storeVal<number>(page, "projectEpoch")).toBe(epochBeforeReplacement + 1);
  await page.evaluate(() => new Promise<void>((resolve) =>
    requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
  await timeline.evaluate((el) => {
    el.scrollLeft = 0;
    el.dispatchEvent(new Event("scroll"));
  });

  await page.keyboard.press("x");
  await page.evaluate(() => new Promise<void>((resolve) =>
    requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
  expect(await storeVal<number>(page, "pxPerSec")).toBe(80);
  expect(await timeline.evaluate((el) => el.scrollLeft)).toBe(0);
});

test("a queued ruler zoom restore cannot write into a replaced project", async ({ page }) => {
  await bootLive(page);
  const timeline = page.getByTestId("live-timeline");
  const bottom = page.getByTestId("live-time-ruler");
  await page.evaluate(async () => {
    const st = (window as any).__moshStore.getState();
    st.setPxPerSec(200);
    await st.exec("set_transport", { position: 6 });
  });
  await expect.poll(() => timeline.evaluate((el) => el.scrollWidth)).toBeGreaterThan(1500);
  await timeline.evaluate((el) => {
    el.scrollLeft = 900;
    el.dispatchEvent(new Event("scroll"));
  });
  await bottom.focus();

  await page.evaluate(() => {
    const ruler = document.querySelector('[data-testid="live-time-ruler"]')!;
    ruler.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowUp", bubbles: true }));
    const store = (window as any).__moshStore;
    void store.getState().exec("open_without_plugins", {});
  });
  await page.evaluate(() => new Promise<void>((resolve) =>
    requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
  expect(await timeline.evaluate((el) => el.scrollLeft)).toBe(900);
});

test("X history never crosses multiplayer host-project adoption", async ({ page }) => {
  await bootLive(page);
  const timeline = page.getByTestId("live-timeline");
  await page.evaluate(() => (window as any).__moshStore.getState().setPxPerSec(400));
  await expect.poll(() => storeVal<number>(page, "pxPerSec")).toBe(400);
  await timeline.evaluate((el) => {
    el.scrollLeft = el.scrollWidth;
    el.dispatchEvent(new Event("scroll"));
  });
  await page.keyboard.press("Meta+-");
  await expect.poll(() => storeVal<number>(page, "pxPerSec")).toBe(320);

  const epochBeforeAdoption = await storeVal<number>(page, "projectEpoch");
  const shellStateAfterAdoption = await page.evaluate(() => {
    const shell = (window as any).__moshShellStore.getState();
    shell.setTimeRange({ start: 4, end: 8 });
    shell.setTimeRangeDragging(true);
    (window as any).__moshMockEmitForTests("snapshot_invalidated", {
      projectReplaced: true,
      reason: "multiplayer_bootstrap",
    });
    (window as any).__moshStore.getState().setPxPerSec(80);
    const after = (window as any).__moshShellStore.getState();
    return { timeRange: after.timeRange, timeRangeDragging: after.timeRangeDragging };
  });
  expect(shellStateAfterAdoption).toEqual({ timeRange: null, timeRangeDragging: false });
  await expect.poll(() => storeVal<number>(page, "projectEpoch")).toBe(epochBeforeAdoption + 1);
  await timeline.evaluate((el) => {
    el.scrollLeft = 0;
    el.dispatchEvent(new Event("scroll"));
  });

  await page.keyboard.press("x");
  await page.evaluate(() => new Promise<void>((resolve) =>
    requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
  expect(await storeVal<number>(page, "pxPerSec")).toBe(80);
  expect(await timeline.evaluate((el) => el.scrollLeft)).toBe(0);
});

test("a queued ruler restore cannot write past multiplayer host-project adoption", async ({ page }) => {
  await bootLive(page);
  const timeline = page.getByTestId("live-timeline");
  const bottom = page.getByTestId("live-time-ruler");
  await page.evaluate(async () => {
    const st = (window as any).__moshStore.getState();
    st.setPxPerSec(200);
    await st.exec("set_transport", { position: 6 });
  });
  await expect.poll(() => timeline.evaluate((el) => el.scrollWidth)).toBeGreaterThan(1500);
  await timeline.evaluate((el) => {
    el.scrollLeft = 900;
    el.dispatchEvent(new Event("scroll"));
  });
  await bottom.focus();

  await page.evaluate(() => {
    const ruler = document.querySelector('[data-testid="live-time-ruler"]')!;
    ruler.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowUp", bubbles: true }));
    (window as any).__moshMockEmitForTests("snapshot_invalidated", {
      projectReplaced: true,
      reason: "multiplayer_bootstrap",
    });
  });
  await page.evaluate(() => new Promise<void>((resolve) =>
    requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
  expect(await timeline.evaluate((el) => el.scrollLeft)).toBe(900);
});

test("Z defers a far-right time-selection scroll until the fitted width exists", async ({ page }) => {
  await bootLive(page);
  await page.evaluate(() => (window as any).__moshStore.getState().setPxPerSec(20));
  await expect.poll(() => storeVal<number>(page, "pxPerSec")).toBe(20);
  const timeline = page.getByTestId("live-timeline");
  const lane = page.getByTestId("live-lane").first();
  const laneBox = await lane.boundingBox();
  if (!laneBox) throw new Error("no lane");
  const y = laneBox.y + laneBox.height / 2;
  await page.mouse.move(laneBox.x + 6 * 20, y);
  await page.mouse.down();
  await page.mouse.move(laneBox.x + 7 * 20, y, { steps: 6 });
  await page.mouse.up();
  await expect(page.getByTestId("live-timerange")).toBeVisible();

  const viewportWidth = await timeline.evaluate((el) => el.clientWidth);
  await page.keyboard.press("z");
  await expect.poll(() => storeVal<number>(page, "pxPerSec")).toBe(400);
  const expectedLeft = 6 * 400 - viewportWidth * 0.05;
  await expect.poll(() => timeline.evaluate((el, expected) => Math.abs(el.scrollLeft - expected), expectedLeft)).toBeLessThanOrEqual(1);
  await expect.poll(() => page.evaluate((expected) => Math.max(
    Math.abs((document.querySelector(".live-ruler-clip") as HTMLElement).scrollLeft - expected),
    Math.abs((document.querySelector(".live-time-ruler-clip") as HTMLElement).scrollLeft - expected),
  ), expectedLeft)).toBeLessThanOrEqual(1);
});

test("Z zooms to the time selection; without one it fits the arrangement content", async ({ page }) => {
  await bootLive(page);
  // draw a 2.5s→5.0s span over the Drums clip body (ableton table: body drag = time select)
  const lane = page.getByTestId("live-lane").nth(0);
  const box = await lane.boundingBox();
  if (!box) throw new Error("no lane");
  const pps0 = await storeVal<number>(page, "pxPerSec");
  const y = box.y + box.height / 2;
  await page.mouse.move(box.x + 2.5 * pps0, y);
  await page.mouse.down();
  await page.mouse.move(box.x + 5.0 * pps0, y, { steps: 8 });
  await page.mouse.up();
  await expect(page.getByTestId("live-timerange")).toBeVisible();

  const scrollerW = await page.locator(".live-lanes-scroll").evaluate((el) => el.clientWidth);
  await page.keyboard.press("z");
  // pxPerSec fits the 2.5s span at 90% of the viewport (the store's clamp aside)
  const expected = Math.min(400, Math.max(20, (scrollerW * 0.9) / 2.5));
  await expect.poll(() => storeVal<number>(page, "pxPerSec")).toBeCloseTo(expected, 1);
  // and the span start is scrolled into view (anchored near the left edge)
  const left = await page.locator(".live-lanes-scroll").evaluate((el) => el.scrollLeft);
  expect(left).toBeLessThan(2.5 * expected);

  // clear the span (an empty-ground press clears the time selection in this shell) —
  // scroll so real empty ground past the last clip sits mid-viewport, then click it
  await page.locator(".live-lanes-scroll").evaluate((el) => {
    const pps = (window as any).__moshStore.getState().pxPerSec;
    el.scrollLeft = 8.5 * pps + el.getBoundingClientRect().left - 700;
  });
  await page.mouse.click(700, 150);
  await expect(page.getByTestId("live-timerange")).toHaveCount(0);
  await page.keyboard.press("z");
  const contentEnd = 8;   // the seed session's last clip end (edit length 16 ≠ content)
  const fitExpected = Math.min(400, Math.max(20, (scrollerW * 0.9) / contentEnd));
  await expect.poll(() => storeVal<number>(page, "pxPerSec")).toBeCloseTo(fitExpected, 1);
});

// ── ⇧Space = Continue Playback (Live 12's Space vs ⇧Space) ────────────────────
test("Space stop returns to the insert marker; ⇧Space stop leaves the playhead", async ({ page }) => {
  await bootLive(page);
  const seek = (p: number) => page.evaluate(async (pos) => {
    await (window as any).__moshStore.getState().exec("set_transport", { action: "seek", position: pos });
  }, p);
  const pos = () => storeVal<number>(page, "transport.position");

  await seek(2);
  await page.keyboard.press("Space");                    // play from 2 (marker = 2)
  await expect.poll(() => storeVal<boolean>(page, "transport.playing")).toBe(true);
  await seek(6);                                         // a seek moves the marker
  await page.keyboard.press("Space");                    // stop → returns to the marker
  await expect.poll(() => storeVal<boolean>(page, "transport.playing")).toBe(false);
  expect(await pos()).toBeCloseTo(6, 2);

  await page.keyboard.press("Shift+Space");              // ⇧Space: play from current
  await expect.poll(() => storeVal<boolean>(page, "transport.playing")).toBe(true);
  await expect.poll(() => commandLog(page)).toContain("set_transport");
  await seek(9);
  await page.keyboard.press("Shift+Space");              // ⇧Space stop → LEAVES the playhead
  await expect.poll(() => storeVal<boolean>(page, "transport.playing")).toBe(false);
  // semantic, not exact: left at the halt point (≥9, drifting up with real playback),
  // NOT returned to the 6s marker
  const left = await pos();
  expect(left).toBeGreaterThan(8.9);
});

// ── A = Automation Mode view toggle (Live 12) ─────────────────────────────────
test("A toggles the automation-mode view button; ⌘A still selects all", async ({ page }) => {
  await bootLive(page);
  const btn = page.getByTestId("live-automation-view");
  await expect(btn).toBeVisible();
  await expect(btn).toHaveAttribute("aria-pressed", "false");
  await page.keyboard.press("a");
  await expect(btn).toHaveAttribute("aria-pressed", "true");
  await expect.poll(() => page.evaluate(() => (window as any).__moshStore.getState() && document.querySelector('[data-testid="live-automation-view"]')?.getAttribute("aria-pressed"))).toBe("true");
  await page.keyboard.press("a");
  await expect(btn).toHaveAttribute("aria-pressed", "false");

  // and the button itself toggles the same state
  await btn.click();
  await expect(btn).toHaveAttribute("aria-pressed", "true");

  // ⌘A is still Select All (Live's automation key is PLAIN A)
  await page.keyboard.press("Meta+a");
  await expect.poll(() => page.evaluate(() => (window as any).__moshStore.getState().selection.size)).toBe(3);
  await expect(btn).toHaveAttribute("aria-pressed", "true");   // ⌘A must NOT touch the automation toggle
});

// ── ⌘, Settings overlay (Live 12 Preferences) ─────────────────────────────────
test("⌘, opens Settings as an overlay with working audio routing; Esc closes it", async ({ page }) => {
  await bootLive(page);
  await expect(page.getByTestId("live-settings")).toHaveCount(0);
  await page.keyboard.press("Meta+,");
  const overlay = page.getByTestId("live-settings");
  await expect(overlay).toBeVisible();
  await expect(overlay).toHaveAttribute("role", "dialog");

  // the audio section renders with the REAL routing selects, populated from the
  // engine enumeration (the mock's list_audio_devices stands in for CoreAudio here)
  await expect(overlay.getByLabel("Output device")).toBeVisible();
  await expect(overlay.getByLabel("Output device")).toContainText("MacBook Pro Speakers");
  await expect(overlay.getByLabel("Input device")).toBeVisible();

  // keys/feel stay reachable under the live shell; only the classic visual skin hides
  await expect(overlay.getByTestId("template-picker")).toBeVisible();

  // changing the output device goes through the seam
  await overlay.getByLabel("Output device").selectOption({ label: "External Headphones" });
  await expect.poll(() => commandLog(page)).toContain("set_audio_device");

  await page.keyboard.press("Escape");
  await expect(page.getByTestId("live-settings")).toHaveCount(0);
  // and ⌘, toggles it back open
  await page.keyboard.press("Meta+,");
  await expect(page.getByTestId("live-settings")).toBeVisible();
});

// ── Audio recovery (AUD-017 follow-up) — the degraded session can switch outputs ──
test("audio recovery: with NO device open the Settings pickers still enumerate; picking one clears the banner", async ({ page }) => {
  // Boot DEGRADED (?mockAudioDead=1 — the mock's failed-open fixture, seeding the
  // error the engine reports when the saved device won't open). While the error is
  // set the mock mirrors the engine fix: list_audio_devices reports
  // audioEnabled:false + an empty selection but KEEPS the enumerated types.
  await bootLive(page, { query: "&mockAudioDead=1" });
  await expect(page.getByTestId("audio-device-notice")).toBeVisible();

  await page.keyboard.press("Meta+,");
  const overlay = page.getByTestId("live-settings");
  await expect(overlay).toBeVisible();
  // the pickers enumerate anyway — this is the whole point of the fix
  await expect(overlay.getByTestId("audio-degraded-note")).toBeVisible();
  const out = overlay.getByLabel("Output device", { exact: true });
  await expect(out).toBeVisible();
  await expect(out.locator("option", { hasText: "External Headphones" })).toHaveCount(1);
  await expect(out.locator("option", { hasText: "MacBook Pro Speakers" })).toHaveCount(1);
  // the ENGINE Device row is a picker too (was a read-only dash before the fix)
  await expect(overlay.getByLabel("Engine device")).toBeVisible();
  // picking a working output recovers — the banner clears
  await out.selectOption("MacBook Pro Speakers");
  await expect.poll(() => commandLog(page)).toContain("set_audio_device");
  await expect(page.getByTestId("audio-device-notice")).toHaveCount(0);
});

// ── REC-NO-INPUT — record with no usable input never fails silently ──────────
test("record with NO usable input: the button shows a guided error and never records", async ({ page }) => {
  // ?mockNoInput=1 — no input devices: the arm degrades (applied:false) exactly
  // like the engine, and the UI must SAY so (why + where to fix it).
  await bootLive(page, { query: "&mockNoInput=1" });
  await page.getByTestId("live-record").click();
  const bar = page.getByTestId("live-error");
  await expect(bar).toBeVisible();
  await expect(bar).toContainText("No usable audio input");
  await expect(bar).toContainText("Settings → Audio");
  await expect.poll(() => page.evaluate(() => (window as any).__moshStore.getState().transport.recording)).toBe(false);
});

test("record on a stale-armed track (input died in a device switch): the engine refusal names the fix", async ({ page }) => {
  // ?mockNoInput=armed — the track is ALREADY armed (so the UI skips the arm), but
  // its input is gone: the engine's REC-NO-INPUT refusal rides the result to the bar.
  await bootLive(page, { query: "&mockNoInput=armed" });
  await page.getByTestId("live-record").click();
  const bar = page.getByTestId("live-error");
  await expect(bar).toBeVisible();
  await expect(bar).toContainText("no armed track with a usable input");
  await expect(bar).toContainText("Settings > Audio");
  await expect.poll(() => page.evaluate(() => (window as any).__moshStore.getState().transport.recording)).toBe(false);
});

// ── MIDI clip looping (Live 12's brace) ────────────────────────────────────────
test("MIDI loop: brace toggle in the dock, ghost repeats in the roll AND the arrangement", async ({ page }) => {
  await bootLive(page);
  const clipId = await page.evaluate(() => (window as any).__moshStore.getState().snapshot.tracks[0].clips[0].id);
  // open the Drums clip in the dock — the loop brace row mounts for MIDI clips
  await page.getByTestId("live-lane").nth(0).locator('[data-testid="v2-clip"]').click();
  await expect(page.locator(".live-shell .pr.docked")).toBeVisible();
  await expect(page.getByTestId("live-dock-loopbar")).toBeVisible();
  await expect(page.getByTestId("live-loopbar-readout")).toContainText("loop off");
  await expect(page.locator(".pr-loop-ghost")).toHaveCount(0);

  // toggle the loop on (default: the clip's whole content — 16 beats at 120bpm)
  await page.getByTestId("live-loopbar-toggle").click();
  await expect.poll(() => page.evaluate(() =>
    (window as any).__moshStore.getState().snapshot.tracks[0].clips[0].midiLoopLengthBeats,
  )).toBe(16);
  await expect.poll(() => commandLog(page)).toContain("set_clip_loop");

  // extend the clip past the brace → ghost repeats appear in the roll (DOM) and
  // on the arrangement canvas (ink past the 8s content edge)
  await page.evaluate(async (id) => {
    await (window as any).__moshStore.getState().exec("trim_clip", { clipId: id, length: 12 });
  }, clipId);
  await expect.poll(() => page.locator(".pr-loop-ghost").count()).toBeGreaterThan(0);
  const ghostInk = await page.evaluate(() => {
    const pps = (window as any).__moshStore.getState().pxPerSec;
    const canvas = document.querySelector('.live-lane [data-testid="v2-clip"] canvas') as HTMLCanvasElement;
    const ctx = canvas.getContext("2d")!;
    const x0 = Math.round(8 * pps);
    const data = ctx.getImageData(x0, 0, canvas.width - x0, canvas.height).data;
    let ink = 0;
    for (let i = 3; i < data.length; i += 4) if (data[i] > 0) ink++;
    return ink;
  });
  expect(ghostInk).toBeGreaterThan(0);

  // a shorter loop region (4s = 8 beats) → MORE repeats (more ghosts)
  const ghostsBefore = await page.locator(".pr-loop-ghost").count();
  await page.evaluate(async (id) => {
    await (window as any).__moshStore.getState().exec("set_clip_loop", { clipId: id, enabled: true, start: 0, length: 4 });
  }, clipId);
  await expect.poll(() => page.locator(".pr-loop-ghost").count()).toBeGreaterThan(ghostsBefore);

  // deactivate → ghosts gone, snapshot fields removed
  await page.getByTestId("live-loopbar-toggle").click();
  await expect(page.locator(".pr-loop-ghost")).toHaveCount(0);
  await expect.poll(() => page.evaluate(() =>
    (window as any).__moshStore.getState().snapshot.tracks[0].clips[0].midiLoopLengthBeats ?? null,
  )).toBe(null);
});
