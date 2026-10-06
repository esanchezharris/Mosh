import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  dcBoostDb, fmtFeedback, fmtSpan, notchesHz, nyquistBoostDb, peakBoostDb, phaserDb, phaserMag, phaserSettings, phaserSummary,
  smoothUpper, sweepAt, sweepBounds, sweepEnvelope, sweepOctaves, sweepSpanHz,
} from "./phaser";
import { NEEDS_ENGINE } from "./chorus";
import { MINI_H, MINI_W, PLOT_W, phaserPanelDef, phaserPlotTop } from "./PhaserPanel";
import { SUMMARY_CHARS } from "./chorus";
import { mkBuiltinState } from "../../mock/builtins";
import { useStore } from "../../store";
import type { Plugin } from "../../types";

function phaser(over: Partial<Record<"depth" | "rate" | "feedback", number>> = {}, enabled = true): Plugin {
  const state = mkBuiltinState("phaser")!;
  for (const [k, v] of Object.entries(over)) state[k] = { ...state[k], value: v };
  return { index: 2, name: "Phaser", type: "phaser", enabled, builtin: true, params: [], state } as unknown as Plugin;
}

/** The engine's per-sample loop (tracktion_Phaser.cpp:69-95) with the sweep held still:
 *  the steady-state output amplitude for a unit sine at f. */
function simulate(f: number, fs: number, swp: number, g: number): number {
  const fv = new Float64Array(8);
  const coef = (1 - swp) / (1 + swp);
  const n = Math.round(fs * 0.6), tail = Math.round(fs * 0.1);
  let peak = 0;
  for (let i = 0; i < n; i++) {
    const inval = Math.sin((2 * Math.PI * f * i) / fs);
    const t = inval + g * fv[7];
    fv[1] = coef * (fv[1] + t) - fv[0]; fv[0] = t;
    fv[3] = coef * (fv[3] + fv[1]) - fv[2]; fv[2] = fv[1];
    fv[5] = coef * (fv[5] + fv[3]) - fv[4]; fv[4] = fv[3];
    fv[7] = coef * (fv[7] + fv[5]) - fv[6]; fv[6] = fv[5];
    const out = inval + fv[7];
    if (i >= n - tail) peak = Math.max(peak, Math.abs(out));
  }
  return peak;
}

describe("phaser maths (tracktion_Phaser.cpp)", () => {
  it("the closed-form response matches the engine's own sample loop", () => {
    const fs = 48000, swp = sweepAt(fs, 2.5);
    for (const [f, g] of [[500, 0.7], [1500, 0.7], [220, 0], [3000, -0.6], [60, 0.9]] as const) {
      expect(phaserMag(f, fs, swp, g)).toBeCloseTo(simulate(f, fs, swp, g), 2);
    }
  });
  it("the sweep spans ~100 Hz to 100·2^depth Hz (atan-warped): 100 Hz to 3154 Hz at depth 5, 48 kHz", () => {
    const [lo, hi] = sweepSpanHz(48000, 5);
    expect(lo).toBeCloseTo(99.9986, 3);
    expect(hi).toBeCloseTo(3154.40, 1);
    expect(fmtSpan(48000, 5)).toBe("100 Hz–3.15 kHz");
    expect(sweepBounds(48000, 0).max).toBe(sweepBounds(48000, 0).min);
  });
  it("the LFO is a triangle in octaves, rising first, period one cycle", () => {
    expect(sweepOctaves(5, 0)).toBe(0);
    expect(sweepOctaves(5, 0.25)).toBe(2.5);
    expect(sweepOctaves(5, 0.5)).toBe(5);
    expect(sweepOctaves(5, 0.75)).toBe(2.5);
    expect(sweepOctaves(5, 1.25)).toBe(2.5);
  });
  it("the low-end lift is 1 + 1/(1 − g): +12.7 dB at the default 0.7, and the curve shows it", () => {
    expect(dcBoostDb(0.7)).toBeCloseTo(12.736, 3);
    expect(nyquistBoostDb(0.7)).toBeCloseTo(4.018, 3);
    expect(peakBoostDb(-0.7)).toBeCloseTo(12.736, 3);
    const fs = 48000, swp = sweepAt(fs, 2);
    expect(phaserDb(0.5, fs, swp, 0.7)).toBeCloseTo(12.736, 1);
    expect(phaserDb(fs / 2 - 0.01, fs, swp, 0.7)).toBeCloseTo(4.018, 1);
    expect(phaserDb(0.5, fs, swp, 0)).toBeCloseTo(6.021, 1);
  });
  it("with no feedback there are two true notches", () => {
    const fs = 48000, swp = sweepAt(fs, 3);
    const [n1, n2] = notchesHz(swp, fs);
    expect(n1).toBeLessThan(n2);
    expect(phaserDb(n1, fs, swp, 0)).toBeLessThan(-60);
    expect(phaserDb(n2, fs, swp, 0)).toBeLessThan(-60);
    expect(phaserDb(Math.sqrt(n1 * n2), fs, swp, 0)).toBeGreaterThan(0);
  });
  it("the stated lift is the highest gain IN the drawn band over a whole sweep, not the closed form at fs/2", () => {
    // Feedback −0.7: the closed form at Nyquist says +12.7 dB, but 24 kHz is off the plot
    // and above hearing; the highest point between 20 Hz and 20 kHz is about +9.2 dB.
    const neg = sweepEnvelope(48000, 5, -0.7);
    expect(nyquistBoostDb(-0.7)).toBeCloseTo(12.736, 3);
    expect(neg.peakDb).toBeGreaterThan(9.0);
    expect(neg.peakDb).toBeLessThan(9.25);
    expect(neg.peakHz).toBeGreaterThan(4000);
    // Feedback +0.7: the lows, matching the DC closed form.
    const pos = sweepEnvelope(48000, 5, 0.7);
    expect(pos.peakDb).toBeCloseTo(dcBoostDb(0.7), 1);
    expect(pos.peakHz).toBeLessThan(1000);
    // The band holds every sweep position: the response at 2.5 octaves sits inside it.
    const swp = sweepAt(48000, 2.5);
    pos.freqs.forEach((f, i) => {
      const db = phaserDb(f, 48000, swp, 0.7);
      expect(db).toBeLessThanOrEqual(pos.maxDb[i] + 1e-9);
      expect(db).toBeGreaterThanOrEqual(pos.minDb[i] - 1e-9);
    });
  });
  it("the plot's top holds the true peak, rounded up to 3 dB (not 6: the curve would hug the top)", () => {
    expect(phaserPlotTop(0.7)).toBe(15);    // +12.7 dB
    expect(phaserPlotTop(0.95)).toBe(27);   // 1 + 1/0.05 = 21 → +26.4 dB
    expect(phaserPlotTop(0)).toBe(9);       // +6.0 dB
    for (const g of [-0.95, -0.4, 0, 0.3, 0.7, 0.95]) expect(phaserPlotTop(g)).toBeGreaterThanOrEqual(peakBoostDb(g));
  });
  it("the drawn upper edge is a 3-point running max: never below the envelope, no wider than a neighbour", () => {
    expect(smoothUpper([0, 3, 1, 1, 5])).toEqual([3, 3, 3, 5, 5]);
    const env = sweepEnvelope(48000, 5, 0.7);
    const up = smoothUpper(env.maxDb);
    up.forEach((v, i) => {
      expect(v).toBeGreaterThanOrEqual(env.maxDb[i]);
      expect(v).toBeLessThanOrEqual(Math.max(...env.maxDb.slice(Math.max(0, i - 1), i + 2)));
    });
  });
  it("summary and settings: rate and depth, within the minimized row's 16 characters", () => {
    expect(phaserSummary(phaser())).toBe("0.40 Hz · 5 oct");
    expect(phaserSummary(phaser({ rate: 2.5, depth: 3.2, feedback: -0.4 }))).toBe("2.5 Hz · 3.2 oct");
    expect(phaserSummary(phaser({ rate: 0.45, depth: 3.4 }))).toBe("0.45 Hz · ~3 oct");
    expect(phaserSummary(phaser({ rate: 10, depth: 8 }))).toBe("10.0 Hz · 8 oct");
    expect(phaserSummary(phaser({ rate: 9.99, depth: 0 }))).toBe("9.99 Hz · 0 oct");
    for (const rate of [0.05, 0.45, 9.99, 10]) for (const depth of [0, 3.2, 7.9, 8]) {
      expect(phaserSummary(phaser({ rate, depth })).length).toBeLessThanOrEqual(SUMMARY_CHARS);
    }
    expect(fmtFeedback(0)).toBe("0%");
    expect(fmtFeedback(-0.001)).toBe("0%");
    expect(phaserSettings({ ...phaser(), state: undefined })).toEqual({ rate: 0.4, depth: 5, feedback: 0.7 });
  });
});

describe("PhaserPanel", () => {
  let host: HTMLDivElement;
  let root: Root;
  const setState = vi.fn();
  const setParam = vi.fn();
  let reduced = false;
  const realMatchMedia = window.matchMedia;

  beforeEach(() => {
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    setState.mockReset();
    reduced = false;
    Object.defineProperty(window, "matchMedia", {
      configurable: true, writable: true,
      value: vi.fn((q: string) => ({ matches: reduced && q.includes("reduce"), media: q, addEventListener() {}, removeEventListener() {} })),
    });
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
  });
  afterEach(() => {
    act(() => root.unmount());
    host.remove();
    Object.defineProperty(window, "matchMedia", { configurable: true, writable: true, value: realMatchMedia });
    setPlaying(false);
  });

  const setPlaying = (playing: boolean) =>
    act(() => useStore.setState({ transport: { ...useStore.getState().transport, playing } }));
  const render = (plugin: Plugin, sampleRate = 48000) =>
    act(() => root.render(React.createElement(phaserPanelDef.Panel, { plugin, trackId: "t1", sampleRate, setParam, setState })));
  const dial = (id: string) => host.querySelector<SVGSVGElement>(`[data-testid="${id}"] svg`)!;
  const key = (el: Element, k: string, mods: KeyboardEventInit = {}) =>
    act(() => { el.dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true, ...mods })); });
  const text = (id: string) => host.querySelector(`[data-testid="${id}"]`)!.textContent;

  it("Rate, Depth and Feedback are dials in real units; End/Home send physical values", () => {
    render(phaser());
    expect(dial("v3-phaser-rate").getAttribute("aria-valuetext")).toBe("0.40 Hz, up and back every 2.50 s");
    expect(dial("v3-phaser-depth").getAttribute("aria-valuetext")).toBe("5.0 octaves, sweeps 100 Hz–3.15 kHz");
    expect(dial("v3-phaser-feedback").getAttribute("aria-valuetext")).toBe("+70%, lows up to +12.7 dB");
    expect(host.querySelector('[data-testid="v3-phaser-feedback"] .v')!.textContent).toBe("+70%");
    key(dial("v3-phaser-feedback"), "End");
    key(dial("v3-phaser-rate"), "Home");
    key(dial("v3-phaser-depth"), "PageDown");     // 5 - 0.1·8 = 4.2 octaves
    expect(setState.mock.calls).toEqual([
      ["feedback", 0.95, { gesture: expect.any(String) }],
      ["rate", 0.05, { gesture: expect.any(String) }],
      ["depth", 4.2, { gesture: expect.any(String) }],
    ]);
  });

  it("states the sweep span and the level lift the engine applies", () => {
    render(phaser());
    // Dial-style read-outs: the value (mono) over a sentence-case caption.
    // Computed read-outs in the plot's top strip, haloed axis-size text: the words, with the
    // figure in a .v tspan, and the hover title explaining each. The dial row holds only dials.
    const shown = (id: string) => {
      const t = host.querySelector(`[data-testid="${id}"]`)!;
      return [t.textContent!.replace(t.querySelector("title")!.textContent!, "").trim(), t.querySelector(".v")!.textContent];
    };
    expect(shown("v3-phaser-sweep")).toEqual(["sweeps 100 Hz–3.15 kHz", "100 Hz–3.15 kHz"]);
    expect(shown("v3-phaser-boost")).toEqual(["peak +12.7 dB (lows)", "+12.7 dB"]);
    expect(host.querySelector('[data-testid="v3-phaser-boost"] title')!.textContent).toMatch(/no output trim/);
    // Both above the plot's top line (which the response never crosses), left and right.
    const top = Number(host.querySelector('[data-testid="v3-phaser-top"]')!.getAttribute("y1"));
    expect(top).toBe(10);
    for (const id of ["v3-phaser-sweep", "v3-phaser-boost"]) expect(Number(host.querySelector(`[data-testid="${id}"]`)!.getAttribute("y"))).toBeLessThan(top);
    expect(host.querySelector('[data-testid="v3-phaser-sweep"]')!.getAttribute("x")).toBe("3");
    expect(host.querySelector('[data-testid="v3-phaser-boost"]')!.getAttribute("x")).toBe("270");
    expect([...host.querySelector(".pp-phaser-ctl")!.children].map((c) => (c.firstElementChild ?? c).getAttribute("data-testid")))
      .toEqual(["v3-phaser-rate", "v3-phaser-depth", "v3-phaser-feedback"]);
    render(phaser({ feedback: -0.7 }));
    expect(shown("v3-phaser-boost")).toEqual([`peak +${sweepEnvelope(48000, 5, -0.7).peakDb.toFixed(1)} dB (highs)`, `+${sweepEnvelope(48000, 5, -0.7).peakDb.toFixed(1)} dB`]);
    expect(shown("v3-phaser-boost")[0]).not.toMatch(/\+12\.7 dB/);
    expect(host.querySelector('[data-testid="v3-phaser-plot"]')!.getAttribute("data-top-db")).toBe("15");
  });

  it("draws the exact curve; bypassed is flat and still; reduced motion is still", () => {
    reduced = true;
    render(phaser({ feedback: 0 }));
    const plot = host.querySelector('[data-testid="v3-phaser-plot"]')!;
    expect(plot.hasAttribute("data-animating")).toBe(false);
    expect(plot.getAttribute("aria-label")).toMatch(/not synced to the audio/);
    // At rest the sweep sits mid-way (2.5 octaves); the first point (20 Hz) is the curve's
    // value there, y = 10 + (top − dB)/(top − floor)·46 with top 9, floor −18 (the plot is
    // 46 tall under the 10-unit read-out strip).
    const d = host.querySelector('[data-testid="v3-phaser-curve"]')!.getAttribute("d")!;
    const y0 = Number(d.split(" ")[1]);
    const db20 = phaserDb(20, 48000, sweepAt(48000, 2.5), 0);
    expect(y0).toBeCloseTo(10 + ((9 - db20) / 27) * 46, 1);
    render(phaser({ feedback: 0 }, false));
    const flat = host.querySelector('[data-testid="v3-phaser-curve"]')!.getAttribute("d")!;
    const ys = new Set(flat.split(/[ML]/).filter(Boolean).map((pt) => pt.trim().split(" ")[1]));
    expect([...ys]).toEqual([(10 + ((9 - 0) / 27) * 46).toFixed(2)]);
    expect(host.querySelector('[data-testid="v3-phaser-plot"]')!.classList.contains("bypassed")).toBe(true);
  });

  it("the sweep position is the primary curve; the static band and its faint upper edge are context", () => {
    render(phaser());
    const peak = host.querySelector('[data-testid="v3-phaser-peak"]')!;
    expect(peak.getAttribute("class")).toBe("pp-phaser-env");
    expect(host.querySelector('[data-testid="v3-phaser-curve"]')!.getAttribute("class")).toBe("curve");
    expect(host.querySelector('[data-testid="v3-phaser-band"]')).not.toBeNull();
    // The upper edge is the envelope, not a sweep position: its first point is the (smoothed) maxDb at 20 Hz.
    const env = sweepEnvelope(48000, 5, 0.7);
    const y0 = Number(peak.getAttribute("d")!.split(" ")[1]);
    expect(y0).toBeCloseTo(10 + ((15 - smoothUpper(env.maxDb)[0]) / 33) * 46, 1);
    // The plot is drawn at its CSS width (273 px: 9 px text is 9 px).
    expect(PLOT_W).toBe(273);
    expect(host.querySelector('[data-testid="v3-phaser-plot"]')!.getAttribute("viewBox")).toBe("0 0 273 56");
    // "0" sits on the side the response is low: the highs for positive feedback (which lifts
    // the lows), the lows for negative. The top line carries no label (the moving curve's
    // peaks pass there); its value is in the hover title.
    const lbl = (id: string) => { const t = host.querySelector(`[data-testid="${id}"]`)!; return [t.textContent, t.getAttribute("x")]; };
    expect(lbl("v3-phaser-db-zero")).toEqual(["0", "271"]);
    expect(host.querySelector('[data-testid="v3-phaser-db-top"]')).toBeNull();
    expect([...host.querySelectorAll('[data-testid="v3-phaser-plot"] text.axis')].map((t) => t.textContent)).toEqual(["100", "1k", "10k", "0"]);
    expect(host.querySelector('[data-testid="v3-phaser-plot"] > title')!.textContent).toMatch(/top line is \+15 dB/);
    render(phaser({ feedback: -0.7 }));
    expect(lbl("v3-phaser-db-zero")).toEqual(["0", "2"]);
    // A visible (hover) cue says the motion is illustrative.
    expect(host.querySelector('[data-testid="v3-phaser-plot"] > title')!.textContent).toMatch(/illustrative.*not synced/);
  });

  it("Shift+arrow steps one whole step; plain arrows 1% of the range in whole steps", () => {
    render(phaser());
    key(dial("v3-phaser-feedback"), "ArrowUp", { shiftKey: true });
    key(dial("v3-phaser-depth"), "ArrowDown", { shiftKey: true });
    key(dial("v3-phaser-rate"), "ArrowUp");
    expect(setState.mock.calls.map((c) => [c[0], c[1]])).toEqual([["feedback", 0.71], ["depth", 4.9], ["rate", 0.5]]);
  });

  it("free-runs only while the transport plays and the plugin is on; at rest it sits mid-sweep", () => {
    render(phaser());
    const plot = () => host.querySelector('[data-testid="v3-phaser-plot"]')!;
    expect(plot().hasAttribute("data-animating")).toBe(false);
    const rest = plot().querySelector('[data-testid="v3-phaser-curve"]')!.getAttribute("d")!;
    const y0 = Number(rest.split(" ")[1]);
    expect(y0).toBeCloseTo(10 + ((15 - phaserDb(20, 48000, sweepAt(48000, 2.5), 0.7)) / 33) * 46, 1);
    setPlaying(true);
    expect(plot().hasAttribute("data-animating")).toBe(true);
  });

  it("at depth 0 Rate is inert (the sweep stands still); the wheel steps a dial and is cancelled", () => {
    render(phaser({ depth: 0 }));
    expect(host.querySelector('[data-testid="v3-phaser-rate"]')!.classList.contains("inert")).toBe(true);
    expect(host.querySelector('[data-testid="v3-phaser-feedback"]')!.classList.contains("inert")).toBe(false);
    const ev = new WheelEvent("wheel", { bubbles: true, cancelable: true, deltaY: 100 });
    act(() => { dial("v3-phaser-feedback").dispatchEvent(ev); });
    expect(ev.defaultPrevented).toBe(true);
    expect(setState.mock.calls.map((c) => [c[0], c[1]])).toEqual([["feedback", 0.68]]);   // 1% of 1.9 → 2 steps
  });

  it("an engine without plugin.state: disabled dials, one note, nothing sent", () => {
    render({ ...phaser(), state: undefined });
    expect(text("v3-phaser-engine-note")).toBe(NEEDS_ENGINE);
    for (const id of ["v3-phaser-rate", "v3-phaser-depth", "v3-phaser-feedback"]) {
      expect(dial(id).getAttribute("aria-disabled")).toBe("true");
      key(dial(id), "ArrowUp");
      key(dial(id), "End");
    }
    expect(setState).not.toHaveBeenCalled();
    render(phaser());
    expect(host.querySelector('[data-testid="v3-phaser-engine-note"]')).toBeNull();
  });
  it("the minimized thumbnail is 44×14 and static: the notch span and the response at rest, on the plot's axes", () => {
    const renderMini = (plugin: Plugin) =>
      act(() => root.render(React.createElement(phaserPanelDef.Mini!, { plugin, trackId: "t1", sampleRate: 48000, setParam, setState })));
    setPlaying(true);                                    // static even while playing
    renderMini(phaser());
    const svg = host.querySelector('[data-testid="v3-phaser-mini"]')!;
    expect([MINI_W, MINI_H]).toEqual([44, 14]);
    expect([svg.getAttribute("width"), svg.getAttribute("height"), svg.getAttribute("viewBox")]).toEqual(["44", "14", "0 0 44 14"]);
    expect(svg.hasAttribute("data-animating")).toBe(false);
    // The span: 100 Hz–3.15 kHz on 20 Hz–20 kHz across 44 px (log).
    const span = host.querySelector('[data-testid="v3-phaser-mini-span"]')!;
    const lx = (f: number) => (Math.log(f / 20) / Math.log(20000 / 20)) * 44;
    const [lo, hi] = sweepSpanHz(48000, 5);
    expect(Number(span.getAttribute("x"))).toBeCloseTo(lx(lo), 6);
    expect(Number(span.getAttribute("width"))).toBeCloseTo(lx(hi) - lx(lo), 6);
    // The curve: the exact response mid-sweep, 20 Hz at x 0, top +15 dB, floor −18, in 14 px.
    const pts = svg.querySelector(".edge")!.getAttribute("d")!.match(/-?[\d.]+ -?[\d.]+/g)!.map((p) => p.split(" ").map(Number));
    expect(pts[0][0]).toBe(0);
    expect(pts[0][1]).toBeCloseTo(((15 - phaserDb(20, 48000, sweepAt(48000, 2.5), 0.7)) / 33) * 14, 1);
    for (const [x, y] of pts) { expect(x).toBeLessThanOrEqual(44 + 1e-9); expect(y).toBeGreaterThanOrEqual(0); expect(y).toBeLessThanOrEqual(14); }
    expect(Math.max(...pts.map((p) => p[1]))).toBeGreaterThan((15 / 33) * 14 + 3);   // its notches dip well below 0 dB
    renderMini(phaser({ feedback: 0 }, false));
    const off = host.querySelector('[data-testid="v3-phaser-mini"]')!;
    expect(off.classList.contains("bypassed")).toBe(true);
    const ys = new Set(off.querySelector(".edge")!.getAttribute("d")!.split(/[ML]/).filter(Boolean).map((p) => p.trim().split(" ")[1]));
    expect([...ys]).toEqual([((9 / 27) * 14).toFixed(2)]);
  });
});
