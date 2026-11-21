import { test, expect, type Page } from "@playwright/test";
import { bootV3, commandTrace } from "./helpers";

// Ported from piano-roll / piano-roll-live12-parity / pr-header-stability (old v2 / classic /
// Live / Pro Tools shells) to V3. The PianoRoll component is shared; V3 opens it as a modal by
// double-clicking a MIDI `v3-clip`, exactly as a producer does. V3 is dark-only (colorways only
// change the accent), so the old light/dark theme loop collapses to one pass.
//
// Command-level cases (trim_clip to build the short-clip fixture, set_transport to move the
// playhead) go through the store's exec, the same seam the arrangement and transport use.
//
// NO-V3-UI: the Live/Pro-Tools *docked* editor variants have no V3 equivalent (V3 only has the
// modal); the editor behaviour they asserted is ported against the modal here.

type NoteRec = { pitch: number; start: number; length: number; velocity: number; mute?: boolean };
type Win = Window & { __moshStore?: { getState: () => any; setState: (s: unknown) => void } };

/** The seed's first MIDI clip, trimmed to `lengthSec` (default 2s = 4 beats @120bpm, short
 *  enough that a clip-derived grid width would under-fill the panel), then opened with a real
 *  double-click on its V3 clip. */
async function openMidiClip(page: Page, lengthSec?: number): Promise<string> {
  const clipId = await page.evaluate(async (len) => {
    const st = (window as unknown as Win).__moshStore!.getState();
    const midi = st.snapshot.tracks.flatMap((t: any) => t.clips).find((c: any) => c.type === "midi");
    if (len != null) {
      const r = await st.exec("trim_clip", { clipId: midi.id, length: len });
      if (!r.ok) throw new Error(`trim_clip failed: ${r.error}`);
    }
    return midi.id as string;
  }, lengthSec ?? null);
  await page.locator(`[data-testid="v3-clip"][data-clip-id="${clipId}"]`).dblclick();
  await expect(page.getByTestId("piano-roll")).toBeVisible();
  // The grid re-measures via ResizeObserver after the snapshot lands.
  await expect.poll(async () => page.locator(".pr-scroll").evaluate((el) => el.clientWidth)).toBeGreaterThan(0);
  await page.waitForTimeout(400); // pop-in animation settles
  return clipId;
}
const openShortMidiClip = (page: Page) => openMidiClip(page, 2);

const editedNotes = (page: Page) => page.evaluate(() => {
  const st = (window as unknown as Win).__moshStore!.getState();
  const clip = st.snapshot.tracks.flatMap((t: any) => t.clips).find((c: any) => c.id === st.editingClipId);
  return (clip?.notes ?? []) as NoteRec[];
});
const beatPxOf = (page: Page) => page.evaluate(() => (window as unknown as Win).__moshStore!.getState().pianoRollBeatPx as number);

const contrast = `(fg, bg) => {
  const px = (s) => s.match(/[\\d.]+/g).slice(0, 3).map(Number);
  const lum = (c) => { const [r, g, b] = c.map((v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); }); return 0.2126 * r + 0.7152 * g + 0.0722 * b; };
  const a = lum(px(fg)), b2 = lum(px(bg));
  const [hi, lo] = a > b2 ? [a, b2] : [b2, a];
  return (hi + 0.05) / (lo + 0.05);
}`;

test.describe("piano roll · V3 modal surface", () => {
  test("the grid fills its container even for a clip far shorter than the panel", async ({ page }) => {
    await bootV3(page);
    await openShortMidiClip(page);

    const { gridW, viewportW, clipBeats } = await page.evaluate(() => {
      const st = (window as unknown as Win).__moshStore!.getState();
      const clip = st.snapshot.tracks.flatMap((t: any) => t.clips).find((c: any) => c.id === st.editingClipId);
      return {
        gridW: document.querySelector(".pr-grid")!.getBoundingClientRect().width,
        viewportW: (document.querySelector(".pr-scroll") as HTMLElement).clientWidth,
        clipBeats: clip.length / (60 / 120),
      };
    });
    // Anti-vacuity: the clip must really be short enough that the old clip-derived rule
    // would have under-filled (4 beats * 42px = 168px).
    expect(clipBeats).toBeLessThan(8);
    expect(viewportW).toBeGreaterThan(400);
    expect(gridW, "grid stops short of its container — the unpainted right-hand gap")
      .toBeGreaterThanOrEqual(viewportW);
  });

  test("the editor is fully OPAQUE — the arrangement must not show through the grid", async ({ page }) => {
    await bootV3(page);
    await openShortMidiClip(page);
    const alphas = await page.evaluate(() => {
      const alpha = (sel: string) => {
        const m = getComputedStyle(document.querySelector(sel)!).backgroundColor.match(/[\d.]+/g)?.map(Number);
        return m && m.length === 4 ? m[3] : 1; // rgb() has no 4th channel = opaque
      };
      return { panel: alpha('[data-testid="piano-roll"]'), grid: alpha(".pr-grid"), keys: alpha(".pr-key.white") };
    });
    for (const [surface, a] of Object.entries(alphas))
      expect(a, `${surface} is translucent — the arrangement bleeds through`).toBe(1);
  });

  test("note-name labels on the key gutter are legible", async ({ page }) => {
    await bootV3(page);
    await openShortMidiClip(page);
    const labels = page.locator(".pr-key span");
    await expect(labels.first()).toBeAttached();
    expect(await labels.count(), "no octave labels rendered at all").toBeGreaterThan(2);
    const ratio = await page.evaluate((fn) => {
      const el = document.querySelector(".pr-key span")!;
      const key = el.closest(".pr-key")!;
      // eslint-disable-next-line no-eval
      return (0, eval)(fn)(getComputedStyle(el).color, getComputedStyle(key).backgroundColor);
    }, contrast);
    expect(ratio, "key labels are not readable against the key").toBeGreaterThan(3);
  });

  test("the panel's own title is legible against the panel", async ({ page }) => {
    await bootV3(page);
    await openShortMidiClip(page);
    const ratio = await page.evaluate((fn) => {
      const title = document.querySelector(".pr-head strong")!;
      const panel = document.querySelector('[data-testid="piano-roll"]')!;
      // eslint-disable-next-line no-eval
      return (0, eval)(fn)(getComputedStyle(title).color, getComputedStyle(panel).backgroundColor);
    }, contrast);
    expect(ratio, "piano-roll title is not readable against its own panel").toBeGreaterThan(4.5);
  });

  test("Escape closes the piano roll", async ({ page }) => {
    await bootV3(page);
    await openShortMidiClip(page);
    await page.keyboard.press("Escape");
    await expect(page.getByTestId("piano-roll")).toHaveCount(0);
  });
});

test.describe("piano roll · DAW affordances", () => {
  test("the ruler prints bar numbers and seeks on click", async ({ page }) => {
    await bootV3(page);
    await openShortMidiClip(page);
    const labels = page.locator(".pr-rtick span");
    expect(await labels.count(), "no bar numbers on the ruler").toBeGreaterThan(1);
    await expect(labels.first()).toHaveText("1"); // clip-local, not session-absolute

    const before = await page.evaluate(() => (window as unknown as Win).__moshStore!.getState().transport.position);
    const box = (await page.locator(".pr-ruler").boundingBox())!;
    await page.mouse.click(box.x + 300, box.y + box.height / 2);
    await expect
      .poll(async () => page.evaluate(() => (window as unknown as Win).__moshStore!.getState().transport.position))
      .not.toBe(before);
  });

  test("ruler, grid and velocity lane stay pixel-aligned at every scroll offset", async ({ page }) => {
    await bootV3(page);
    await openShortMidiClip(page);
    const drift = async () => page.evaluate(() => {
      const tick = document.querySelectorAll(".pr-rtick")[1]?.getBoundingClientRect().left;
      const line = document.querySelectorAll(".pr-gl.bar")[1]?.getBoundingClientRect().left;
      return tick == null || line == null ? null : Math.abs(tick - line);
    });
    expect(await drift()).toBeLessThanOrEqual(1);
    await page.evaluate(() => {
      const sc = document.querySelector(".pr-scroll") as HTMLElement;
      sc.scrollLeft = 99999; // hard against the right-hand end — the worst case
      sc.dispatchEvent(new Event("scroll", { bubbles: true }));
    });
    expect(await drift(), "ruler drifted from the grid at max scroll").toBeLessThanOrEqual(1);
  });

  test("zoom scales the grid and keeps the lanes together", async ({ page }) => {
    await bootV3(page);
    await openShortMidiClip(page);
    const widths = () => page.evaluate(() => ({
      grid: document.querySelector(".pr-grid")!.getBoundingClientRect().width,
      ruler: document.querySelector(".pr-ruler")!.getBoundingClientRect().width,
      vel: document.querySelector(".pr-vel-lane")!.getBoundingClientRect().width,
    }));
    const before = await widths();
    await page.getByTestId("pr-zoom-in").click();
    const after = await widths();
    expect(after.grid, "zoom in did not widen the grid").toBeGreaterThan(before.grid);
    expect(Math.abs(after.ruler - after.grid)).toBeLessThanOrEqual(1);
    expect(Math.abs(after.vel - after.grid)).toBeLessThanOrEqual(1);
    await page.getByTestId("pr-zoom-out").click();
    expect((await widths()).grid).toBeLessThan(after.grid);
  });

  test("a velocity-lane drag sends nothing until release, then commits once", async ({ page }) => {
    await bootV3(page);
    await openShortMidiClip(page);
    const setNotes = async () => (await commandTrace(page)).filter((c) => c.command === "set_note").length;
    const baseline = await setNotes();

    // LAST, not first: stems are drawn in note order, so notes starting at the same beat
    // stack at the same x and only the last is on top.
    const bar = page.locator('[data-testid="pr-vel-bar"]').last();
    await expect(bar).toBeVisible();
    await bar.hover(); // waits for the element to stop moving (ResizeObserver re-layout)
    const bb = (await bar.boundingBox())!;
    const lane = (await page.locator(".pr-vel-lane").boundingBox())!;
    const x = bb.x + bb.width / 2;

    // Drag toward the end FAR from the note's current velocity: the commit skips a no-op set_note.
    const current = await bar.evaluate((el) => parseInt(el.getAttribute("title")!.split("vel ")[1], 10));
    const targetY = current > 64 ? lane.y + lane.height * 0.92 : lane.y + lane.height * 0.08;

    await page.mouse.move(x, bb.y + bb.height / 2);
    await page.mouse.down();
    await page.mouse.move(x, targetY, { steps: 6 });
    // Nothing sent mid-drag: committing per move would flood the log and shatter one gesture
    // into six undo steps.
    expect((await setNotes()) - baseline, "commands were sent mid-drag instead of on release").toBe(0);

    await page.mouse.up();
    await expect.poll(async () => (await setNotes()) - baseline, { message: "release committed nothing" }).toBeGreaterThan(0);
    expect((await setNotes()) - baseline).toBeLessThan(6); // proportional to notes touched, not moves
  });

  test("the playhead tracks the transport and hides when it leaves the clip", async ({ page }) => {
    await bootV3(page);
    await openShortMidiClip(page);
    await expect(page.getByTestId("pr-playhead")).toBeAttached();
    const seekTo = (where: "mid" | "far") => page.evaluate(async (w) => {
      const st = (window as unknown as Win).__moshStore!.getState();
      const clip = st.snapshot.tracks.flatMap((t: any) => t.clips).find((c: any) => c.id === st.editingClipId);
      await st.exec("set_transport", { position: w === "mid" ? clip.start + clip.length / 2 : clip.start + clip.length + 30 });
    }, where);
    const playing = () => page.locator(".pr-body").evaluate((el) => el.classList.contains("pr-playing"));

    await seekTo("mid");
    await expect.poll(playing).toBe(true);
    await seekTo("far"); // well past the clip — the playhead must not linger
    await expect.poll(playing).toBe(false);
  });

  test("header controls show the styled tooltip, not a native title", async ({ page }) => {
    await bootV3(page);
    await openShortMidiClip(page);
    const quantize = page.getByTestId("pr-quantize");
    await expect(quantize).not.toHaveAttribute("title", /./); // a left-behind title would double-tooltip
    await quantize.hover();
    const tip = page.locator(".mosh-tip");
    await expect(tip).toBeVisible();
    await expect(tip).toContainText(/snap every note/i);
    await page.locator(".pr-head strong").hover();
    await expect(tip).toHaveCount(0);
  });
});

test("the header does not reflow when a note is selected or deleted", async ({ page }) => {
  await bootV3(page);
  await openMidiClip(page);

  const vp = (await page.locator(".pr-scroll").boundingBox())!;
  const beatPx = await beatPxOf(page);
  // The quantize button sits right of the velocity control — the canary for reflow.
  const canary = () => page.getByTestId("pr-quantize").boundingBox().then((b) => b && [b.x, b.width]);
  const vel = page.locator(".pr-vel");
  await expect(vel).toBeAttached(); // layout-owning but invisible pre-selection
  await expect(vel).toBeHidden();
  const before = await canary();

  // Adding is a DOUBLE-click on empty grid; a single click only selects / places the insert.
  await page.mouse.dblclick(vp.x + 4 * beatPx, vp.y + vp.height / 2);
  await page.waitForTimeout(250);
  const afterDraw = await canary();
  await page.mouse.click(vp.x + 4 * beatPx + 4, vp.y + vp.height / 2);
  await expect(vel).toBeVisible();
  const afterSelect = await canary();
  await page.keyboard.press("Delete");
  await expect(vel).toBeHidden();
  const afterDelete = await canary();

  for (const [label, box] of Object.entries({ afterDraw, afterSelect, afterDelete }))
    expect(box, `header reflowed ${label.replace("after", "after ")}`).toEqual(before);
});

test.describe("piano roll · note gestures (Live 12 parity, via the V3 modal)", () => {
  test("marquee selection is visible and Shift+Right lengthens notes", async ({ page }) => {
    await bootV3(page);
    await openMidiClip(page);

    const ordinal = 2;
    const note = page.getByTestId("pr-note").nth(ordinal);
    const before = await note.boundingBox();
    if (!before) throw new Error("marquee target has no browser geometry");
    const normalRing = await note.evaluate((el) => getComputedStyle(el).borderColor);
    const original = (await editedNotes(page))[ordinal];
    expect(original, "marquee target has no MIDI note").toBeTruthy();

    await page.mouse.move(before.x - 3, before.y - 3);
    await page.mouse.down();
    await page.mouse.move(before.x + before.width + 3, before.y + before.height + 3, { steps: 6 });
    await page.mouse.up();

    await expect(note).toHaveClass(/\bsel\b/);
    await expect(note).toHaveAttribute("aria-pressed", "true");
    const cue = await note.evaluate((el) => {
      const s = getComputedStyle(el);
      return { ring: s.outlineColor, outlineStyle: s.outlineStyle, outlineWidth: s.outlineWidth };
    });
    const chans = (s: string) => s.match(/[\d.]+/g)?.slice(0, 3).map(Number) ?? [];
    // V3 keeps the accent fill for selected notes (--pr-note-sel = --pr-note); the cue is the
    // text-coloured 2px ring, so compare the ring against the unselected note's edge.
    const normal = chans(normalRing);
    const dist = chans(cue.ring).reduce((t, c, i) => t + Math.abs(c - (normal[i] ?? c)), 0);
    expect(dist).toBeGreaterThan(80);
    expect(cue).toMatchObject({ outlineStyle: "solid", outlineWidth: "2px" });

    const traceStart = (await commandTrace(page)).length;
    await page.keyboard.press("Shift+ArrowRight");
    await expect.poll(async () => (await commandTrace(page)).slice(traceStart).some((e) => e.command === "set_note")).toBe(true);
    const args = (await commandTrace(page)).slice(traceStart).find((e) => e.command === "set_note")!.args;
    expect(Number(args.start ?? original.start)).toBe(original.start);
    expect(Number(args.length)).toBeGreaterThan(original.length);
  });

  test("adaptive snap lines and both resize edges share one interaction surface", async ({ page }) => {
    await bootV3(page);
    await openMidiClip(page);

    const barLine = page.locator('.pr-gl[data-grid-beat="0"]');
    const halfBeatLine = page.locator('.pr-gl[data-grid-beat="0.5"]');
    await expect(barLine).toBeVisible();
    await expect(halfBeatLine).toBeVisible();
    await expect(halfBeatLine).toHaveAttribute("data-grid-kind", "subdivision");
    const [barBox, halfBox, beatPx] = await Promise.all([barLine.boundingBox(), halfBeatLine.boundingBox(), beatPxOf(page)]);
    if (!barBox || !halfBox) throw new Error("adaptive grid lines have no browser geometry");
    expect(halfBox.x - barBox.x).toBeCloseTo(beatPx / 2, 1);

    const notes = await editedNotes(page);
    const ordinal = notes.findIndex((n) => n.start >= 0.5);
    expect(ordinal, "no resizable note starts after beat zero").toBeGreaterThanOrEqual(0);
    const target = notes[ordinal];

    const note = page.getByTestId("pr-note").nth(ordinal);
    const startGrip = note.locator(".pr-note-grip-start");
    const endGrip = note.locator(".pr-note-grip-end");
    const grid = page.locator(".pr-grid");
    await expect(startGrip).toBeVisible();
    await expect(endGrip).toBeVisible();

    await note.hover();
    await expect(grid).toHaveCSS("cursor", "grab");
    for (const grip of [startGrip, endGrip]) {
      await grip.hover();
      await expect(grid).toHaveCSS("cursor", "ew-resize");
      expect(await grip.evaluate((el) => getComputedStyle(el).cursor)).toBe("ew-resize");
    }

    const traceStart = (await commandTrace(page)).length;
    await startGrip.hover();
    const g = await startGrip.boundingBox();
    if (!g) throw new Error("left resize grip has no browser geometry");
    const x = g.x + Math.min(1.5, g.width / 4);
    const y = g.y + g.height / 2;
    await page.mouse.move(x, y);
    await page.mouse.down();
    await page.mouse.move(x - beatPx / 2, y, { steps: 6 });
    await page.mouse.up();

    await expect.poll(async () => (await commandTrace(page)).slice(traceStart).some((e) => e.command === "set_note")).toBe(true);
    const args = (await commandTrace(page)).slice(traceStart).find((e) => e.command === "set_note")!.args;
    expect(Number(args.start)).toBeCloseTo(target.start - 0.5, 6);
    expect(Number(args.length)).toBeCloseTo(target.length + 0.5, 6);
  });

  test("an active note drag stays under the pointer while the editor scrolls", async ({ page }) => {
    await bootV3(page);
    await openMidiClip(page);

    const target = await page.evaluate(() => {
      const st = (window as unknown as Win).__moshStore!.getState();
      const clip = st.snapshot.tracks.flatMap((t: any) => t.clips).find((c: any) => c.id === st.editingClipId);
      const boxes = [...document.querySelectorAll<HTMLElement>('[data-testid="pr-note"]')]
        .map((el, ordinal) => ({ ordinal, width: el.getBoundingClientRect().width }));
      const ordinal = boxes.sort((a, b) => b.width - a.width)[0]?.ordinal ?? -1;
      const note = clip?.notes?.[ordinal];
      if (!note) throw new Error("no note is available for drag-scroll testing");
      return { ordinal, pitch: note.pitch as number };
    });

    const note = page.getByTestId("pr-note").nth(target.ordinal);
    await note.scrollIntoViewIfNeeded();
    const before = await note.boundingBox();
    if (!before) throw new Error("drag target has no browser geometry");
    const pointer = { x: before.x + before.width / 2, y: before.y + before.height / 2 };
    const hitClass = await page.evaluate(({ x, y }) => document.elementFromPoint(x, y)?.className ?? "", pointer);
    expect(hitClass).toContain("pr-note");
    expect(hitClass).not.toContain("pr-note-grip");
    const traceStart = (await commandTrace(page)).length;

    await page.mouse.move(pointer.x, pointer.y);
    await page.mouse.down();
    const scrollDelta = await page.locator(".pr-scroll").evaluate((el) => {
      const sc = el as HTMLElement;
      const down = Math.min(30, sc.scrollHeight - sc.clientHeight - sc.scrollTop);
      const delta = down >= 15 ? down : -Math.min(30, sc.scrollTop);
      sc.scrollTop += delta;
      sc.dispatchEvent(new Event("scroll", { bubbles: true }));
      return delta;
    });
    expect(Math.abs(scrollDelta)).toBeGreaterThanOrEqual(15);
    await expect.poll(async () => (await note.boundingBox())?.y ?? Number.NaN).toBeCloseTo(before.y, 0);
    await page.mouse.up();

    await expect.poll(async () => (await commandTrace(page)).slice(traceStart).some((e) => e.command === "set_note")).toBe(true);
    const args = (await commandTrace(page)).slice(traceStart).find((e) => e.command === "set_note")!.args;
    expect(Number(args.pitch)).toBe(target.pitch - Math.round(scrollDelta / 15));
  });

  test("selection follows one note across backend reindexing and Undo", async ({ page }) => {
    await bootV3(page);
    await openMidiClip(page);

    const original = await editedNotes(page).then((notes) => {
      if (notes.length < 3) throw new Error("reindex regression needs three MIDI notes");
      let targetOrdinal = -1, destination = -1;
      for (let o = 0; o < notes.length && targetOrdinal < 0; o += 1) {
        const t = notes[o];
        for (let start = Math.ceil(t.start + 1); start <= 7; start += 1) {
          const crosses = notes.some((c) => c.start > t.start && c.start < start);
          const collides = notes.some((c, i) => i !== o && c.pitch === t.pitch
            && c.start < start + t.length && c.start + c.length > start);
          if (crosses && !collides) { targetOrdinal = o; destination = start; break; }
        }
      }
      if (targetOrdinal < 0) throw new Error("reindex regression needs a collision-free sorting move");
      const companions = notes.map((_, o) => o).filter((o) => o !== targetOrdinal).slice(0, 2);
      return { notes: notes.map((n) => ({ ...n })), targetOrdinal, companions, destination };
    });
    const notes = page.getByTestId("pr-note");
    await notes.nth(original.targetOrdinal).click();
    await notes.nth(original.companions[0]).click({ modifiers: ["Shift"] });
    await notes.nth(original.companions[1]).click({ modifiers: ["Shift"] });
    await expect(page.locator(".pr-note.sel")).toHaveCount(3);

    await notes.nth(original.targetOrdinal).click();
    await expect(page.locator(".pr-note.sel")).toHaveCount(1);
    const before = await notes.nth(original.targetOrdinal).boundingBox();
    if (!before) throw new Error("reindex drag target has no browser geometry");
    const beatPx = await beatPxOf(page);
    const target = original.notes[original.targetOrdinal];
    const x = before.x + before.width / 2;
    const y = before.y + before.height / 2;
    const traceStart = (await commandTrace(page)).length;
    await page.mouse.move(x, y);
    await page.mouse.down();
    await page.mouse.move(x + (original.destination - target.start) * beatPx, y, { steps: 10 });
    await page.mouse.up();

    await expect.poll(async () => (await commandTrace(page)).slice(traceStart).filter((e) => e.command === "set_note").length).toBe(1);
    const moved = await editedNotes(page);
    const sig = (n: NoteRec) => `${n.pitch}|${n.start}|${n.length}|${n.velocity}|${Boolean(n.mute)}`;
    const expectedMoved = { ...target, start: original.destination };
    expect(moved.map(sig)).toContain(sig(expectedMoved));
    const without = (values: string[], value: string) => {
      const rest = [...values];
      const i = rest.indexOf(value);
      if (i < 0) throw new Error(`missing note identity ${value}`);
      rest.splice(i, 1);
      return rest.sort();
    };
    expect(without(moved.map(sig), sig(expectedMoved))).toEqual(without(original.notes.map(sig), sig(target)));
    await expect(page.locator(".pr-note.sel")).toHaveCount(1);
    await expect(page.locator(".pr-note.sel")).toHaveAttribute("aria-label", new RegExp(`note start ${original.destination.toFixed(2)}`));
    await expect(page.locator(".pr-note.sel")).toHaveAttribute("aria-pressed", "true");

    await page.keyboard.press("ControlOrMeta+z");
    await expect.poll(async () => (await editedNotes(page)).find((n) => n.pitch === target.pitch)?.start).toBe(target.start);
  });
});
