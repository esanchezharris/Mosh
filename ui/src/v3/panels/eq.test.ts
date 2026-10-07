import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Plugin } from "../../types";
import {
  SUMMARY_CHARS, changedFields, curveD, dbRange, dragTarget, editToParams, eqSummary, geometry, isBandOff, maxAbsDb,
  nodePos, parseField, qFromDrag, readBands, responseDb, scrubField, stepField, wheelOctaves, wheelQ, type BandValues,
} from "./eq";
import { eqPanelDef } from "./EqPanel";
import type { PanelProps } from "./types";

const FS = 48000;
const NAMES = ["Low-shelf freq", "Low-shelf gain", "Low-shelf Q", "Mid freq 1", "Mid gain 1", "Mid Q 1",
  "Mid freq 2", "Mid gain 2", "Mid Q 2", "High-shelf freq", "High-shelf gain", "High-shelf Q"];
const RANGES = [[20, 20000], [-20, 20], [0.1, 4]];
/** The engine's reset values, normalised (research: tracktion_Equaliser.cpp:89-103). */
const DEFAULTS = [0.003003, 0.5, 0.102564, 0.149149, 0.5, 0.102564, 0.249249, 0.5, 0.102564, 0.849850, 0.5, 0.102564];

function eq(values: number[], opts: { minmax?: boolean; enabled?: boolean } = {}): Plugin {
  const minmax = opts.minmax ?? true;
  return {
    index: 0, name: "4-Band EQ", type: "4bandEq", enabled: opts.enabled ?? true, external: false, builtin: true,
    isInstrument: false,
    params: values.map((value, index) => ({
      index, name: NAMES[index], value,
      ...(minmax ? { min: RANGES[index % 3][0], max: RANGES[index % 3][1] } : {}),
    })),
  } as Plugin;
}
/** Normalised value for a physical one on param `i`'s linear range. */
const n = (i: number, phys: number) => (phys - RANGES[i % 3][0]) / (RANGES[i % 3][1] - RANGES[i % 3][0]);

const band = (freq: number, gain: number, q: number): BandValues => ({ freq, gain, q });
/** The y of every point of an SVG path built by curveD. */
const pathYs = (d: string): number[] => [...d.matchAll(/[ML](-?[\d.]+) (-?[\d.]+)/g)].map((m) => Number(m[2]));
const flat = (): BandValues[] => [band(80, 0, 0.5), band(3000, 0, 0.5), band(5000, 0, 0.5), band(17000, 0, 0.5)];

describe("reading the 12 parameters (linear: Hz 20..20000, dB ±20, Q 0.1..4)", () => {
  it("reads the engine's defaults as 80 / 3000 / 5000 / 17000 Hz, 0 dB, Q 0.5, and says flat", () => {
    const b = readBands(eq(DEFAULTS));
    expect(b.map((x) => x.freq)).toEqual([expect.closeTo(80, 1), expect.closeTo(3000, 1), expect.closeTo(5000, 1), expect.closeTo(17000, 1)]);
    for (const x of b) { expect(x.gain).toBe(0); expect(x.q).toBeCloseTo(0.5, 4); }
    expect(eqSummary(eq(DEFAULTS))).toBe("flat");
  });

  it("reads the mock's old values exactly as the research decodes them", () => {
    // research mockMismatches: low shelf 3616 Hz -2.4 dB Q 2.05; peak 2 12408 Hz +2.4 dB; high 16404 Hz +3.2 dB.
    const p = eq([0.18, 0.44, 0.5, 0.36, 0.5, 0.5, 0.62, 0.56, 0.5, 0.82, 0.58, 0.5]);
    const b = readBands(p);
    expect(b[0].freq).toBeCloseTo(3616.4, 1);
    expect(b[0].gain).toBeCloseTo(-2.4, 9);
    expect(b[0].q).toBeCloseTo(2.05, 9);
    expect(b[2].freq).toBeCloseTo(12407.6, 1);
    expect(b[3].freq).toBeCloseTo(16403.6, 1);
    expect(eqSummary(p)).toBe("high +3 · 2 more");   // biggest move first; even in whole dB all three are 21 chars
  });

  it("falls back to the documented ranges when the engine sends no min/max", () => {
    expect(readBands(eq(DEFAULTS, { minmax: false }))[1].freq).toBeCloseTo(3000, 1);
    expect(editToParams(eq(DEFAULTS, { minmax: false }), { band: 3, freq: 17000, gain: 3, q: 0.5 }))
      .toEqual([{ paramIndex: 9, norm: n(9, 17000) }, { paramIndex: 10, norm: 0.575 }, { paramIndex: 11, norm: n(11, 0.5) }]);
  });

  it("budgets the summary to the 16 monospace characters the minimized row shows whole (97 px)", () => {
    expect(SUMMARY_CHARS).toBe(16);
  });

  it("summarises only the bands doing something, biggest move first, in full while it fits", () => {
    const v = DEFAULTS.slice();
    v[1] = n(1, -3);
    expect(eqSummary(eq(v))).toBe("low -3.0 dB");
    v[1] = 0.5; v[7] = n(7, -6); v[6] = n(6, 450);
    expect(eqSummary(eq(v))).toBe("450 Hz -6.0 dB");
    v[4] = n(4, 2.5);
    // "450 Hz -6.0 dB · 3.0k +2.5 dB" is 29 chars; without the dB it is 21; bare numbers fit.
    expect(eqSummary(eq(v))).toBe("450 -6·3.0k +2.5");
    v[7] = 0.5; v[1] = n(1, -3); v[4] = 0.5; v[10] = n(10, 3);
    expect(eqSummary(eq(v))).toBe("low -3 · high +3");    // the dB goes before the spaces do
    v[1] = 0.5; v[10] = n(10, 1.5);
    expect(eqSummary(eq(v))).toBe("high +1.5 dB");
    v[10] = 0.5; v[6] = n(6, 9960); v[7] = n(7, 3);
    expect(eqSummary(eq(v))).toBe("10k +3.0 dB");        // not fmtHz's "10.0k"
  });

  it("compacts several active bands, and counts the smallest rather than cut them off", () => {
    const v = DEFAULTS.slice();
    v[1] = n(1, -3); v[4] = n(4, 2.5);
    expect(eqSummary(eq(v))).toBe("low -3·3.0k +2.5");
    v[1] = n(1, -12.6); v[4] = n(4, -12.4); v[3] = n(3, 3600);
    expect(eqSummary(eq(v))).toBe("low -13·3.6k -12");    // whole dB: 2 decimals would be 20 chars
    v[10] = n(10, 3);
    expect(eqSummary(eq(v))).toBe("low -13 · 2 more");    // three bands are 23 chars even in whole dB
    // Rounding to whole dB never turns a small gain into a misleading "0", and the tightest
    // form still fits when the biggest move is under 1 dB on all four bands.
    const small = DEFAULTS.slice();
    small[1] = n(1, 0.3); small[4] = n(4, -0.2); small[7] = n(7, 0.2); small[10] = n(10, -0.4); small[9] = n(9, 9900);
    expect(eqSummary(eq(small))).toBe("high -0.4·3 more");
  });

  it("never exceeds the budget, whatever the four bands are set to", () => {
    // A deterministic sweep over frequencies of every width ("20", "999", "9.9k", "20k"; 9950 Hz
    // reads "10k", not fmtHz's "10.0k") and gains of every width ("-0.4", "+3", "-12.6", "-20").
    const freqs = [20, 450, 999, 1000, 9940, 9950, 12400, 20000];
    const gains = [0, 0.4, -0.4, 3, -12.6, 12.4, 20, -20];
    let seed = 7;
    const pick = <T,>(xs: T[]) => xs[(seed = (seed * 16807) % 2147483647) % xs.length];
    for (let k = 0; k < 2000; k++) {
      const v = DEFAULTS.slice();
      for (let b = 0; b < 4; b++) { v[3 * b] = n(0, pick(freqs)); v[3 * b + 1] = n(1, pick(gains)); }
      const s = eqSummary(eq(v));
      expect(s.length, s).toBeLessThanOrEqual(SUMMARY_CHARS);
    }
  });
});

describe("the response is the engine's four biquads in series", () => {
  it("a peak reaches its exact gain at its frequency; a shelf passes half its gain at f0 and all of it at the end", () => {
    const b = flat();
    b[1] = band(1000, 6, 1);
    expect(responseDb(b, 1000, FS)).toBeCloseTo(6, 6);
    const lo = flat();
    lo[0] = band(100, -6, 0.707);
    expect(responseDb(lo, 100, FS)).toBeCloseTo(-3, 6);
    expect(responseDb(lo, 2, FS)).toBeCloseTo(-6, 2);
    expect(responseDb(lo, 10000, FS)).toBeCloseTo(0, 2);
    const hi = flat();
    hi[3] = band(5000, 4, 0.707);
    expect(responseDb(hi, 5000, FS)).toBeCloseTo(2, 6);
    expect(responseDb(hi, 23900, FS)).toBeCloseTo(4, 1);
  });

  it("sums the bands in dB, and a 0 dB band contributes nothing whatever its Q", () => {
    const a = flat(); a[1] = band(1000, 6, 1);
    const c = flat(); c[3] = band(8000, -5, 0.5);
    const both = flat(); both[1] = a[1]; both[3] = c[3]; both[2] = band(200, 0, 4);
    for (const f of [40, 700, 1000, 6000, 15000]) {
      expect(responseDb(both, f, FS)).toBeCloseTo(responseDb(a, f, FS) + responseDb(c, f, FS), 9);
    }
    expect(isBandOff(0)).toBe(true);
    expect(isBandOff(0.1)).toBe(false);
  });

  it("draws a resonant shelf truthfully: Q 4 overshoots past the shelf gain", () => {
    const b = flat(); b[0] = band(200, 6, 4);
    const peakDb = Math.max(...[100, 150, 200, 260, 320, 400].map((f) => responseDb(b, f, FS)));
    expect(peakDb).toBeGreaterThan(6.5);
  });

  it("sizes the dB axis to the COMPOSITE response: ±12, then ±20, then ±40", () => {
    const b = flat();
    b[1] = band(1000, 12, 1);
    expect(dbRange(b, FS)).toBe(12);
    b[1] = band(1000, -12.1, 1);
    expect(dbRange(b, FS)).toBe(20);
    // A +8 dB, Q 4 low shelf at 200 Hz overshoots to +16.2 dB: its own gain says ±12, the
    // response needs ±20.
    const sh = flat(); sh[0] = band(200, 8, 4);
    expect(maxAbsDb(sh, FS)).toBeCloseTo(16.24, 1);
    expect(dbRange(sh, FS)).toBe(20);
    // Two +10 dB peaks on the same frequency stack to +20 (exactly, at f0): still ±20.
    const st = flat(); st[1] = band(1000, 10, 1); st[2] = band(1000, 10, 1);
    expect(maxAbsDb(st, FS)).toBeCloseTo(20, 6);
    expect(dbRange(st, FS)).toBe(20);
    st[1] = band(1000, 14, 1);
    expect(dbRange(st, FS)).toBe(40);
  });

  it("draws the overshoot, not a plateau at the plot edge", () => {
    const sh = flat(); sh[0] = band(200, 8, 4);
    const g = geometry(FS, dbRange(sh, FS));
    const ys = pathYs(curveD(sh, FS, g));
    expect(Math.min(...ys)).toBeGreaterThan(0);
    expect(Math.min(...ys)).toBeCloseTo(g.y.to(maxAbsDb(sh, FS)), 1);
  });

  it("samples every active band's f0, so a narrow peak reaches its node (main plot and 44 px thumbnail)", () => {
    const b = flat(); b[2] = band(19523, 12, 4);
    const g = geometry(FS, dbRange(b, FS));
    expect(Math.abs(Math.min(...pathYs(curveD(b, FS, g))) - nodePos(b[2], g).y)).toBeLessThan(0.5);
    const m = flat(); m[1] = band(3000, 12, 4);
    const mini = geometry(FS, dbRange(m, FS), 44, 14, 1);
    expect(Math.min(...pathYs(curveD(m, FS, mini, 44)))).toBeCloseTo(mini.y.to(12), 2);
  });
});

describe("plot geometry and drags", () => {
  it("spans 20 Hz..20 kHz at 48 kHz, stops just under Nyquist at 32 kHz, and puts 0 dB mid-height", () => {
    const g = geometry(FS, 12);
    expect(g.x.to(20)).toBeCloseTo(0, 9);
    expect(g.x.to(20000)).toBeCloseTo(273, 9);
    expect(g.y.to(0)).toBe(42);
    expect(g.y.to(12)).toBe(6);
    expect(g.y.to(-12)).toBe(78);
    const low = geometry(32000, 12);
    expect(low.top).toBeCloseTo(15968, 6);
    expect(nodePos(band(17000, 3, 0.5), low).x).toBe(273);
  });

  it("turns a node drag into a log frequency and a linear gain, rounded and snapped to 0 dB", () => {
    const g = geometry(FS, 12);
    expect(dragTarget({ x: 136.5, y: 42 }, g)).toEqual({ freq: 632, gain: 0 });     // mid-width: √(20·20000) = 632.46
    expect(dragTarget({ x: 136.5, y: 6 }, g)).toEqual({ freq: 632, gain: 12 });
    expect(dragTarget({ x: 0, y: 43 }, g)).toEqual({ freq: 20, gain: -0.3 });       // 1 px = 1/3 dB
    expect(dragTarget({ x: 273, y: 42.3 }, g)).toEqual({ freq: 20000, gain: 0 });   // -0.1 dB snaps to off
    expect(dragTarget({ x: 400, y: -500 }, g)).toEqual({ freq: 20000, gain: 20 });  // clamped to the engine range
  });

  it("maps Q on a log scale: Alt-drag one octave per 48 px, the wheel one octave per 600 px of travel", () => {
    expect(qFromDrag(0.5, 48)).toBe(1);
    expect(qFromDrag(0.5, -48)).toBe(0.25);
    expect(qFromDrag(0.5, 10000)).toBe(4);
    expect(wheelOctaves(-100, 0, 84, false)).toBeCloseTo(1 / 6, 12);    // one mouse notch, up: narrower
    expect(wheelOctaves(-100, 0, 84, true)).toBeCloseTo(1 / 24, 12);
    expect(wheelOctaves(3, 1, 84, false)).toBeCloseTo(-48 / 600, 12);    // 3 lines = 48 px
    expect(wheelOctaves(-1, 2, 84, false)).toBeCloseTo(84 / 600, 12);    // a page = the plot's height
    expect(wheelQ(1, 1 / 6).q).toBe(1.12);
    expect(wheelQ(1, -1 / 6).q).toBe(0.89);
    // A trackpad swipe of 20 small deltas moves Q a little, not across the range.
    expect(wheelQ(0.5, 20 * wheelOctaves(-4, 0, 84, false)).q).toBe(0.55);
    // Scrolling past the end does not have to be unwound.
    const over = wheelQ(0.5, 100);
    expect(over).toEqual({ q: 4, octaves: 3 });
    expect(wheelQ(0.5, over.octaves - 1).q).toBe(2);
  });

  it("a fine Q step always moves, even below 0.18 where 1/24 octave is under the 0.01 grid", () => {
    expect(stepField("q", 0.1, 1, "fine")).toBe(0.11);
    expect(stepField("q", 0.12, 1, "fine")).toBe(0.13);
    expect(stepField("q", 0.15, -1, "fine")).toBe(0.14);
    expect(stepField("q", 0.1, -1, "fine")).toBe(0.1);      // at the minimum: stays
    expect(stepField("q", 2, 1, "fine")).toBe(2.06);        // where the octave step is big enough
  });

  it("steps each field by its own unit", () => {
    expect(stepField("freq", 1000, 1, "small")).toBe(1059.5);
    expect(stepField("freq", 1000, -1, "page")).toBe(500);
    expect(stepField("gain", 0, 1, "small")).toBe(0.5);
    expect(stepField("gain", 0, -1, "fine")).toBe(-0.1);
    expect(stepField("gain", 19, 1, "page")).toBe(20);
    expect(stepField("q", 0.5, 1, "page")).toBe(1);
    expect(stepField("q", 0.5, 1, "small")).toBe(0.56);
    expect(stepField("freq", 300, 1, "end")).toBe(20000);
    expect(stepField("q", 2, -1, "home")).toBe(0.1);
  });

  it("scrubs and parses typed values in real units", () => {
    expect(scrubField("gain", 0, 15, 150)).toBe(4);
    expect(scrubField("gain", 0, 300, 150)).toBe(20);
    expect(scrubField("freq", 20, 150, 150)).toBe(20000);
    expect(scrubField("q", 0.1, 75, 150)).toBe(0.63);   // √40 · 0.1
    expect(parseField("freq", "3k")).toBe(3000);
    expect(parseField("freq", "3.2 kHz")).toBe(3200);
    expect(parseField("freq", "5")).toBe(20);
    expect(parseField("gain", "+2.5 dB")).toBe(2.5);
    expect(parseField("gain", "50")).toBe(20);
    expect(parseField("q", "abc")).toBeNaN();
  });

  it("accepts only a field's own units, and reads a thousands comma as a separator", () => {
    expect(parseField("freq", "12,000")).toBe(12000);
    expect(parseField("freq", "1,500 Hz")).toBe(1500);
    expect(parseField("gain", "2,5")).toBe(2.5);              // a decimal comma
    expect(parseField("freq", "800 Hz")).toBe(800);
    expect(parseField("freq", "-3 dB")).toBeNaN();
    expect(parseField("gain", "2k")).toBeNaN();
    expect(parseField("q", "800 Hz")).toBeNaN();
    expect(parseField("q", "0,7")).toBe(0.7);
  });

  it("an edit that would not change the parameter is not sent", () => {
    const p = eq(DEFAULTS);
    const snap = (i: number) => (f: "freq" | "gain" | "q") => readBands(p)[i][f];
    expect(changedFields(p, { band: 0, freq: 80, gain: 0, q: 0.5 }, snap(0))).toBeNull();   // reset at defaults
    expect(changedFields(p, { band: 1, gain: 20 }, () => 20)).toBeNull();                   // End at the top
    expect(changedFields(p, { band: 0, freq: 80, gain: 3, q: 0.5 }, snap(0))).toEqual({ band: 0, gain: 3 });
    expect(changedFields(p, { band: 0, freq: 80.3 }, snap(0))).toEqual({ band: 0, freq: 80.3 });
  });
});

// ── the panel, mounted ───────────────────────────────────────────────────────────────────

describe("EqPanel", () => {
  let host: HTMLDivElement;
  let root: Root;
  let setParam: ReturnType<typeof vi.fn>;
  const render = (plugin: Plugin, fs = FS, Comp = eqPanelDef.Panel) => {
    const props: PanelProps = { plugin, trackId: "t1", sampleRate: fs, setParam: setParam as PanelProps["setParam"], setState: vi.fn() };
    act(() => root.render(React.createElement(Comp, props)));
  };
  const q = <T extends Element>(sel: string) => host.querySelector<T>(sel)!;
  const key = (el: Element, k: string, init: KeyboardEventInit = {}) =>
    act(() => { el.dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true, ...init })); });
  const ptr = (el: Element, type: string, x: number, y: number, init: MouseEventInit = {}) =>
    act(() => { el.dispatchEvent(new PointerEvent(type, { bubbles: true, cancelable: true, button: 0, clientX: x, clientY: y, pointerId: 1, ...init })); });
  const calls = () => setParam.mock.calls.map(([i, v, o]) => [i, v, (o as { gesture?: string } | undefined)?.gesture]);
  const wait = (ms: number) => act(() => new Promise<void>((r) => setTimeout(r, ms)));
  const wheelOn = (el: Element, init: WheelEventInit) => {
    const ev = new WheelEvent("wheel", { bubbles: true, cancelable: true, ...init });
    act(() => { el.dispatchEvent(ev); });
    return ev;
  };

  beforeEach(() => {
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
    setParam = vi.fn();
  });
  afterEach(() => {
    act(() => root.unmount());
    host.remove();
  });

  it("is titled 4-Band EQ, not the engine's 4-Band Equaliser", () => {
    expect(eqPanelDef.title).toBe("4-Band EQ");
  });

  it("draws four nodes, hollow exactly where the band is at 0 dB, over a non-empty curve", () => {
    const v = DEFAULTS.slice(); v[10] = n(10, 3);
    render(eq(v));
    expect(host.querySelectorAll(".pp-node")).toHaveLength(4);
    expect(q('[data-testid="pp-eq-node-L"]').classList.contains("hollow")).toBe(true);
    expect(q('[data-testid="pp-eq-node-H"]').classList.contains("hollow")).toBe(false);
    expect(q('[data-testid="pp-eq-node-H"]').getAttribute("aria-valuetext")).toBe("17.0 kHz, +3.0 dB, Q 0.50");
    expect(q('[data-testid="pp-eq-node-L"]').getAttribute("aria-valuetext")).toMatch(/off \(at 0 dB the engine skips this band\)/);
    // The band picker agrees: only a processing band carries the lit dot, and the off one says why.
    expect(q('[data-testid="pp-eq-band-H"]').classList.contains("live")).toBe(true);
    expect(q('[data-testid="pp-eq-band-L"]').classList.contains("live")).toBe(false);
    expect(q('[data-testid="pp-eq-band-L"]').getAttribute("title")).toBe("Low shelf: off at 0 dB");
    // An off band's Freq / Q stay adjustable (inert, not disabled); its Gain is never inert.
    expect(q('[data-testid="pp-eq-field-freq"]').parentElement!.classList.contains("inert")).toBe(true);
    expect(q('[data-testid="pp-eq-field-gain"]').parentElement!.classList.contains("inert")).toBe(false);
    const d = q('[data-testid="pp-eq-curve"]').getAttribute("d")!;
    const g = geometry(FS, 12);
    const bands = readBands(eq(v));
    const ys = pathYs(d);
    expect(ys[0]).toBeCloseTo(42, 2);                                         // flat at 20 Hz
    expect(ys[ys.length - 1]).toBeCloseTo(g.y.to(responseDb(bands, 20000, FS)), 2);  // the +3 dB shelf at the top
    expect(ys[ys.length - 1]).toBeLessThan(42 - 6);                           // ~+2.5 dB, well off the 0 dB line
    // The selected band's own curve: none for the low shelf at 0 dB, the high shelf's when chosen.
    expect(host.querySelector('[data-testid="pp-eq-solo"]')).toBeNull();
    act(() => q<HTMLButtonElement>('[data-testid="pp-eq-band-H"]').click());
    const solo = pathYs(q('[data-testid="pp-eq-solo"]').getAttribute("d")!);
    expect(solo[solo.length - 1]).toBeCloseTo(ys[ys.length - 1], 2);         // the only active band
    expect(host.querySelector('[data-testid="pp-eq-clip"]')).toBeNull();
    expect(q('[data-testid="pp-eq-plot"]').classList.contains("bypassed")).toBe(false);
    render(eq(v, { enabled: false }));
    expect(q('[data-testid="pp-eq-plot"]').classList.contains("bypassed")).toBe(true);
  });

  it("node keys: Up is +0.5 dB, and a burst builds on the last value sent, as one gesture", () => {
    render(eq(DEFAULTS));
    const node = q('[data-testid="pp-eq-node-L"]');
    key(node, "ArrowUp");
    key(node, "ArrowUp");
    const c = calls();
    expect(c.map(([i, v]) => [i, v])).toEqual([[1, 0.5125], [1, 0.525]]);
    expect(c[0][2]).toMatch(/^ui-/);
    expect(c[1][2]).toBe(c[0][2]);
    setParam.mockClear();
    key(node, "PageUp");                                         // Q 0.5 · 2^(1/6) = 0.56
    expect(calls()[0].slice(0, 2)).toEqual([2, n(2, 0.56)]);
  });

  const sizePlot = () => {
    const svg = q<SVGSVGElement>('[data-testid="pp-eq-plot"]');
    svg.getBoundingClientRect = () => ({ left: 0, top: 0, width: 273, height: 84, right: 273, bottom: 84, x: 0, y: 0, toJSON() {} }) as DOMRect;
  };

  it("dragging a node sets frequency and gain under ONE gesture across frames; Alt-drag sets Q", async () => {
    render(eq(DEFAULTS));
    sizePlot();
    const g = geometry(FS, 12);
    const start = nodePos(readBands(eq(DEFAULTS))[0], g);
    const node = q('[data-testid="pp-eq-node-L"]');
    ptr(node, "pointerdown", start.x, start.y);
    ptr(node, "pointermove", 100, 20);
    await wait(40);                                    // a frame passes: the first move is sent
    expect(calls()).toHaveLength(2);
    ptr(node, "pointermove", 136.5, 6);
    ptr(node, "pointerup", 136.5, 6);
    const c = calls();
    expect(c.slice(2).map(([i, v]) => [i, v])).toEqual([[0, n(0, 632)], [1, 0.8]]);
    expect(c[0][2]).toMatch(/^ui-/);
    expect(new Set(c.map((x) => x[2])).size).toBe(1);  // both frames, one gesture

    setParam.mockClear();
    ptr(node, "pointerdown", start.x, start.y, { altKey: true });
    ptr(node, "pointermove", start.x, start.y - 48, { altKey: true });
    ptr(node, "pointerup", start.x, start.y - 48, { altKey: true });
    expect(calls().map(([i, v]) => [i, v])).toEqual([[2, n(2, 1)]]);   // Q 0.5 → 1.0
  });

  it("a vertical drag keeps the frequency, even of a node clamped to the edge at 32 kHz", () => {
    render(eq(DEFAULTS), 32000);
    sizePlot();
    const g = geometry(32000, 12);
    const start = nodePos(readBands(eq(DEFAULTS))[3], g);
    expect(start.x).toBe(273);                          // 17 kHz is past the 15968 Hz top
    const node = q('[data-testid="pp-eq-node-H"]');
    ptr(node, "pointerdown", start.x, start.y);
    ptr(node, "pointermove", start.x, start.y - 9);
    ptr(node, "pointerup", start.x, start.y - 9);
    expect(calls().map(([i, v]) => [i, v])).toEqual([[10, n(10, 3)]]);   // gain only
  });

  it("wheel on a node changes its Q by the wheel's travel, as one gesture, and does not scroll the inspector", async () => {
    render(eq(DEFAULTS));
    const dot = q('[data-testid="pp-eq-node-1"] .dot');
    expect(wheelOn(dot, { deltaY: -100 }).defaultPrevented).toBe(true);
    await wait(200);                                   // the gesture ends after 150 ms idle
    expect(calls().map(([i, v]) => [i, v])).toEqual([[5, n(5, 0.56)]]);

    // A trackpad swipe: 20 small deltas move Q a little, in ONE gesture, throttled.
    setParam.mockClear();
    const lo = q('[data-testid="pp-eq-node-L"] .dot');
    for (let k = 0; k < 10; k++) wheelOn(lo, { deltaY: -4 });
    await wait(40);                                    // a frame passes mid-swipe (under the 150 ms idle)
    for (let k = 0; k < 10; k++) wheelOn(lo, { deltaY: -4 });
    await wait(200);
    const c = calls();
    // One send per frame, not per event: 0.5 · 2^(40/600) after 10, 0.5 · 2^(80/600) after 20.
    expect(c.map(([i, v]) => [i, v])).toEqual([[2, n(2, 0.52)], [2, n(2, 0.55)]]);
    expect(c[0][2]).toMatch(/^ui-/);
    expect(c[1][2]).toBe(c[0][2]);                     // the whole swipe is one undo step

    // Shift + a mouse wheel arrives as deltaX on macOS: fine (a quarter).
    setParam.mockClear();
    wheelOn(q('[data-testid="pp-eq-node-2"] .dot'), { deltaX: -100, shiftKey: true });
    await wait(200);
    expect(calls().map(([i, v]) => [i, v])).toEqual([[8, n(8, 0.51)]]);   // 0.5 · 2^(1/24)

    // A pinch (ctrlKey) is not a Q change.
    setParam.mockClear();
    expect(wheelOn(dot, { deltaY: -100, ctrlKey: true }).defaultPrevented).toBe(false);
    await wait(200);
    expect(setParam).not.toHaveBeenCalled();
  });

  it("keys the panel handles never reach the app's window shortcuts (no clip delete, nudge or playhead move)", () => {
    const leaked: string[] = [];
    const spy = (e: KeyboardEvent) => leaked.push(e.key);
    window.addEventListener("keydown", spy);
    try {
      render(eq(DEFAULTS));
      const node = q('[data-testid="pp-eq-node-1"]');
      for (const k of ["Delete", "Backspace", "ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "PageUp"]) key(node, k);
      for (const k of ["Home", "End", "ArrowUp", "ArrowLeft"]) key(q('[data-testid="pp-eq-field-gain"]'), k);
      key(q('[data-testid="pp-eq-band-1"]'), "ArrowRight");
      expect(q('[data-testid="pp-eq-band-2"]').getAttribute("aria-checked")).toBe("true");
      expect(document.activeElement).toBe(q('[data-testid="pp-eq-band-2"]'));
      key(q('[data-testid="pp-eq-field-freq"]'), "Enter");
      key(q('[data-testid="pp-eq-input-freq"]'), "Escape");
      expect(leaked).toEqual([]);
      key(node, "s");                                  // a key the panel does not use still gets through
      expect(leaked).toEqual(["s"]);
    } finally {
      window.removeEventListener("keydown", spy);
    }
  });

  it("a key that would change nothing sends nothing (End at the top, reset of a flat band)", () => {
    render(eq(DEFAULTS));
    key(q('[data-testid="pp-eq-node-L"]'), "Delete");
    expect(setParam).not.toHaveBeenCalled();
    const gain = q('[data-testid="pp-eq-field-gain"]');
    key(gain, "End");
    key(gain, "End");
    expect(calls().map(([i, x]) => [i, x])).toEqual([[1, 1]]);
  });

  it("says when the response runs past the largest range", () => {
    const v = DEFAULTS.slice();
    v[3] = n(3, 1000); v[4] = n(4, 20); v[5] = n(5, 1); v[6] = n(6, 1000); v[7] = n(7, 20); v[8] = n(8, 1);
    v[9] = n(9, 500); v[10] = n(10, 20);
    render(eq(v));
    expect(q('[data-testid="pp-eq-clip"]').textContent).toContain("beyond ±40 dB");
  });

  it("double-click resets a band to the engine's defaults in one gesture", () => {
    const v = DEFAULTS.slice(); v[9] = n(9, 9000); v[10] = n(10, -4); v[11] = n(11, 2);
    render(eq(v));
    act(() => { q('[data-testid="pp-eq-node-H"]').dispatchEvent(new MouseEvent("dblclick", { bubbles: true })); });
    const c = calls();
    expect(c.map(([i, x]) => [i, x])).toEqual([[9, n(9, 17000)], [10, 0.5], [11, n(11, 0.5)]]);
    expect(new Set(c.map((x) => x[2])).size).toBe(1);
  });

  it("the read-out row edits the selected band: End / Home, and a typed value", () => {
    render(eq(DEFAULTS));
    // Low shelf selected first; its frequency and Q are flagged inactive at 0 dB.
    expect(q('[data-testid="pp-eq-field-freq"]').getAttribute("aria-valuetext")).toBe("80 Hz, inactive while the band is at 0 dB");
    act(() => q<HTMLButtonElement>('[data-testid="pp-eq-band-1"]').click());
    expect(q('[data-testid="pp-eq-band-1"]').getAttribute("aria-checked")).toBe("true");
    expect(q('[data-testid="pp-eq-field-freq"]').textContent).toBe("3.00 kHz");
    key(q('[data-testid="pp-eq-field-gain"]'), "End");
    key(q('[data-testid="pp-eq-field-freq"]'), "Home");
    expect(calls().map(([i, x]) => [i, x])).toEqual([[4, 1], [3, 0]]);

    setParam.mockClear();
    act(() => { q('[data-testid="pp-eq-field-freq"]').dispatchEvent(new MouseEvent("dblclick", { bubbles: true })); });
    const input = q<HTMLInputElement>('[data-testid="pp-eq-input-freq"]');
    expect(input.value).toBe("3.00k");
    act(() => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, "2.5k");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    key(input, "Enter");
    expect(calls().map(([i, x]) => [i, x])).toEqual([[3, n(3, 2500)]]);
  });

  it("the minimized thumbnail draws the same curve, reaching the peak's gain", () => {
    const v = DEFAULTS.slice(); v[4] = n(4, 6);                    // peak 1: 3 kHz, +6 dB
    render(eq(v), FS, eqPanelDef.Mini!);
    const ys = pathYs(q('[data-testid="pp-eq-mini"] .c').getAttribute("d")!);
    const g = geometry(FS, 12, 44, 14, 1);
    expect(ys[0]).toBeCloseTo(7, 2);                               // 0 dB at 20 Hz: mid-height of 14
    expect(Math.min(...ys)).toBeCloseTo(g.y.to(6), 2);             // +6 dB at 3 kHz, exactly
  });
});
