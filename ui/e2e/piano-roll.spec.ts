import { test, expect, type Page } from "@playwright/test";
import { bootV2 } from "./helpers";

// The MIDI editor, in a real browser. Everything here needs the actual CSS cascade and a
// real layout engine, which is exactly why none of it was caught before: the unit suites
// run in jsdom (no cascade, no layout) and the visual gate never covered this panel.
//
// Two shipped bugs are pinned here:
//   1. The grid was sized from the CLIP alone, so a short clip left the right ~40% of the
//      panel unpainted — the grid element simply ended before its container did.
//   2. `.pr-key.white` hardcoded a near-black background while the label colour flipped
//      DARK with the light theme (the shipped default), so every note name on the
//      keyboard was rendered and invisible.

/** Open the piano roll on a clip trimmed short enough that the CLIP rule alone would
 *  under-fill the panel — the exact failing case. */
async function openShortMidiClip(page: Page): Promise<void> {
  await page.evaluate(async () => {
    const st = (window as any).__moshStore.getState();
    const midi = st.snapshot.tracks.flatMap((t: any) => t.clips).find((c: any) => c.type === "midi");
    await st.exec("trim_clip", { clipId: midi.id, length: 2 }); // 2s = 4 beats @120bpm
    (window as any).__moshStore.getState().openPianoRoll(midi.id);
  });
  await expect(page.getByTestId("piano-roll")).toBeVisible();
  // The grid re-measures via ResizeObserver after the snapshot lands.
  await expect.poll(async () => page.locator(".pr-scroll").evaluate((el) => el.clientWidth))
    .toBeGreaterThan(0);
}

const contrast = `(fg, bg) => {
  const px = (s) => s.match(/[\\d.]+/g).slice(0, 3).map(Number);
  const lum = (c) => { const [r, g, b] = c.map((v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); }); return 0.2126 * r + 0.7152 * g + 0.0722 * b; };
  const a = lum(px(fg)), b2 = lum(px(bg));
  const [hi, lo] = a > b2 ? [a, b2] : [b2, a];
  return (hi + 0.05) / (lo + 0.05);
}`;

for (const theme of ["light", "dark"] as const) {
  test.describe(`piano roll · ${theme} theme`, () => {
    test("the grid fills its container even for a clip far shorter than the panel", async ({ page }) => {
      await bootV2(page, { theme });
      await openShortMidiClip(page);

      const { gridW, viewportW, clipBeats } = await page.evaluate(() => {
        const st = (window as any).__moshStore.getState();
        const clip = st.snapshot.tracks.flatMap((t: any) => t.clips).find((c: any) => c.id === st.editingClipId);
        return {
          gridW: document.querySelector(".pr-grid")!.getBoundingClientRect().width,
          viewportW: (document.querySelector(".pr-scroll") as HTMLElement).clientWidth,
          clipBeats: clip.length / (60 / 120),
        };
      });

      // Anti-vacuity: this only means anything if the clip really is short enough that
      // the old clip-derived rule would have under-filled. 4 beats * 42px = 168px.
      expect(clipBeats).toBeLessThan(8);
      expect(viewportW).toBeGreaterThan(400);
      expect(gridW, "grid stops short of its container — the unpainted right-hand gap")
        .toBeGreaterThanOrEqual(viewportW);
    });

    test("note-name labels on the key gutter are legible", async ({ page }) => {
      await bootV2(page, { theme });
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

      // The bug rendered dark text on a near-black key: ~1.2:1. WCAG AA for
      // non-essential small text is 4.5:1; 3:1 is a floor that still fails loudly
      // on the regression while leaving room for a dim-by-design gutter.
      expect(ratio, "key labels are not readable against the key").toBeGreaterThan(3);
    });

    test("the panel's own title is legible against the panel", async ({ page }) => {
      // `.pr` set a background but no colour, so inside v2 it inherited near-white text
      // onto a white panel in the light theme. Same class of bug as .modal (#44).
      await bootV2(page, { theme });
      await openShortMidiClip(page);
      const ratio = await page.evaluate((fn) => {
        const title = document.querySelector(".pr-head strong")!;
        const panel = document.querySelector(".pr")!;
        // eslint-disable-next-line no-eval
        return (0, eval)(fn)(getComputedStyle(title).color, getComputedStyle(panel).backgroundColor);
      }, contrast);
      expect(ratio, "piano-roll title is not readable against its own panel").toBeGreaterThan(4.5);
    });
  });
}

test("Escape closes the piano roll", async ({ page }) => {
  await bootV2(page);
  await openShortMidiClip(page);
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("piano-roll")).toHaveCount(0);
});

test.describe("piano roll · DAW affordances", () => {
  test("the ruler prints bar numbers and seeks on click", async ({ page }) => {
    await bootV2(page);
    await openShortMidiClip(page);

    const labels = page.locator(".pr-rtick span");
    expect(await labels.count(), "no bar numbers on the ruler").toBeGreaterThan(1);
    await expect(labels.first()).toHaveText("1"); // clip-local, not session-absolute

    const before = await page.evaluate(() => (window as any).__moshStore.getState().transport.position);
    const ruler = page.locator(".pr-ruler");
    const box = (await ruler.boundingBox())!;
    await page.mouse.click(box.x + 300, box.y + box.height / 2);
    await expect
      .poll(async () => page.evaluate(() => (window as any).__moshStore.getState().transport.position))
      .not.toBe(before);
  });

  test("ruler, grid and velocity lane stay pixel-aligned at every scroll offset", async ({ page }) => {
    // They are three separate scroll viewports. Syncing them by assigning scrollLeft
    // drifts, because only .pr-scroll has a vertical scrollbar so its client width — and
    // therefore its max scrollLeft — is smaller. ~1px with macOS overlay scrollbars,
    // ~15px with classic Windows ones. A transform cannot clamp, so it cannot drift.
    await bootV2(page);
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
    await bootV2(page);
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
    await bootV2(page);
    await openShortMidiClip(page);
    await page.evaluate(() => { (window as any).__cmds = []; });
    await page.evaluate(() => {
      const st = (window as any).__moshStore;
      const real = st.getState().exec;
      st.setState({ exec: async (c: string, a: unknown) => { (window as any).__cmds.push(c); return real(c, a); } });
    });

    // LAST, not first: velocity stems are drawn in note order, so notes that start at the
    // same beat (a chord) stack at the same x and only the last one is on top. Picking
    // .first() means asking Playwright to click something genuinely covered.
    const bar = page.locator('[data-testid="pr-vel-bar"]').last();
    await expect(bar).toBeVisible();
    // hover() waits for the element to stop moving before pointing at it. Raw
    // boundingBox()+mouse.move races the ResizeObserver that re-lays the grid after the
    // clip trim, so under parallel load the press landed on empty lane and the gesture
    // no-op'd.
    await bar.hover();
    const bb = (await bar.boundingBox())!;
    const lane = (await page.locator(".pr-vel-lane").boundingBox())!;
    const x = bb.x + bb.width / 2;

    const setNotes = () => page.evaluate(() => (window as any).__cmds.filter((c: string) => c === "set_note").length);

    // Drag towards whichever end is FAR from this note's current velocity. The commit
    // deliberately skips a no-op set_note, so a target that happens to land on the note's
    // existing velocity sends nothing and looks like a broken gesture. (Dragging to
    // mid-lane yields exactly 64, and 64 is a very common seeded velocity.)
    const current = await bar.evaluate((el) => parseInt(el.getAttribute("title")!.split("vel ")[1], 10));
    const targetY = current > 64 ? lane.y + lane.height * 0.92 : lane.y + lane.height * 0.08;

    // Press on the STEM's own centre — aiming at a fraction of the lane lands near the
    // stem's top edge for low-velocity notes, and sub-pixel timing then decides whether
    // the press connects.
    await page.mouse.move(x, bb.y + bb.height / 2);
    await page.mouse.down();
    await page.mouse.move(x, targetY, { steps: 6 }); // six pointermoves…

    // …and NOTHING sent yet. This is the property that matters: committing per move would
    // flood the JSONL command log at frame rate and shatter one gesture into six undo
    // steps. (Asserting an exact final count instead is load-flaky — velocity bars can
    // overlap in time, so a sweep may legitimately pick up a neighbour.)
    expect(await setNotes(), "commands were sent mid-drag instead of on release").toBe(0);

    await page.mouse.up();
    await expect.poll(setNotes, { message: "release committed nothing" }).toBeGreaterThan(0);

    // And the whole gesture stays proportional to notes touched, never to move count.
    expect(await setNotes()).toBeLessThan(6);
  });

  test("the playhead tracks the transport and hides when it leaves the clip", async ({ page }) => {
    await bootV2(page);
    await openShortMidiClip(page);
    const head = page.getByTestId("pr-playhead");
    await expect(head).toBeAttached();

    await page.evaluate(async () => {
      const st = (window as any).__moshStore.getState();
      const clip = st.snapshot.tracks.flatMap((t: any) => t.clips).find((c: any) => c.id === st.editingClipId);
      await st.exec("set_transport", { position: clip.start + clip.length / 2 });
    });
    await expect.poll(async () => page.locator(".pr-body").evaluate((el) => el.classList.contains("pr-playing")))
      .toBe(true);
    const inside = await head.evaluate((el) => el.getBoundingClientRect().left);

    // Move the transport well past the clip — the playhead must not linger.
    await page.evaluate(async () => {
      const st = (window as any).__moshStore.getState();
      const clip = st.snapshot.tracks.flatMap((t: any) => t.clips).find((c: any) => c.id === st.editingClipId);
      await st.exec("set_transport", { position: clip.start + clip.length + 30 });
    });
    await expect.poll(async () => page.locator(".pr-body").evaluate((el) => el.classList.contains("pr-playing")))
      .toBe(false);
    expect(Number.isFinite(inside)).toBe(true);
  });
});
