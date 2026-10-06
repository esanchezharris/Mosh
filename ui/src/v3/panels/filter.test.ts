import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Plugin } from "../../types";
import {
  CUTOFF_RANGE, PLOT_H, PLOT_W, clampCutoff, cutoffAtX, cutoffHz, cutoffNorm, defaultCutoff, filterMode,
  filterSummary, handleX, isUnstable, maxCutoff, parseHz, plotScales, responseDb, stepCutoff,
} from "./filter";
import { MINI_H, MINI_W, filterPanelDef, keyTarget } from "./FilterPanel";
import { fmtFreq } from "./params";

const FS = 48000;
const SPAN = 22000 - 10;
const normFor = (hz: number) => (hz - 10) / SPAN;

function filter(type: "lowpass" | "highpass", hz: number, extra: Partial<Plugin> = {}): Plugin {
  return {
    index: 2, name: type === "highpass" ? "High-Pass" : "LPF/HPF", type, enabled: true, external: false,
    builtin: true, isInstrument: false, itemId: "1001",
    params: [{ index: 0, name: "Frequency", value: normFor(hz), display: `${Math.round(hz)} Hz`, min: 10, max: 22000 }],
    state: { mode: { value: type, choices: ["lowpass", "highpass"] } },
    ...extra,
  };
}

describe("filter maths (te::LowPassPlugin: one 12 dB/oct Butterworth biquad, linear 10..22000 Hz)", () => {
  it("reads the mode from state, falling back to the type", () => {
    expect(filterMode(filter("highpass", 180))).toBe("highpass");
    expect(filterMode(filter("lowpass", 4000))).toBe("lowpass");
    expect(filterMode({ ...filter("lowpass", 4000), state: undefined, type: "highpass" })).toBe("highpass");
    expect(filterMode({ ...filter("lowpass", 4000), state: undefined })).toBe("lowpass");
    // state wins over a stale type (it is what the engine's updateFilters reads)
    expect(filterMode({ ...filter("lowpass", 4000), state: { mode: { value: "highpass" } } })).toBe("highpass");
  });

  it("maps the cutoff linearly, so 80-150 Hz is reachable exactly (the old 0.01 slider snapped to 229.9 Hz)", () => {
    expect(cutoffNorm(filter("highpass", 180), 180, FS)).toBeCloseTo(0.0077308, 7);
    expect(cutoffNorm(filter("highpass", 180), 80, FS)).toBeCloseTo(0.0031833, 7);
    expect(cutoffNorm(filter("lowpass", 4000), 4000, FS)).toBeCloseTo(0.181446, 6);
    expect(cutoffHz(filter("highpass", 120))).toBeCloseTo(120, 9);
    // SelfTest.cpp: v = 0.4 reads back 8806 Hz
    expect(cutoffHz({ ...filter("lowpass", 0), params: [{ index: 0, name: "Frequency", value: 0.4 }] })).toBeCloseTo(8806, 0);
    expect(defaultCutoff("highpass")).toBe(180);
    expect(defaultCutoff("lowpass")).toBe(4000);
  });

  it("steps in twelfths of an octave and clamps to 10 Hz .. min(22 kHz, just under Nyquist)", () => {
    expect(stepCutoff(180, 1, FS)).toBeCloseTo(190.7034, 3);
    expect(stepCutoff(180, 12, FS)).toBeCloseTo(360, 9);
    expect(stepCutoff(180, -12, FS)).toBeCloseTo(90, 9);
    expect(stepCutoff(12, -12, FS)).toBe(10);
    expect(stepCutoff(20000, 12, FS)).toBe(22000);
    expect(maxCutoff(44100)).toBe(22000);
    expect(maxCutoff(32000)).toBeCloseTo(15968, 6);
    expect(clampCutoff(30000, 32000)).toBeCloseTo(15968, 6);
    expect(clampCutoff(Number.NaN, FS)).toBe(CUTOFF_RANGE.min);
  });

  it("draws the engine's exact response (research sanity values at 48 kHz)", () => {
    expect(responseDb("highpass", 180, 180, FS)).toBeCloseTo(-3.0103, 3);
    expect(responseDb("highpass", 180, 90, FS)).toBeCloseTo(-12.305, 2);
    expect(responseDb("highpass", 180, 45, FS)).toBeCloseTo(-24.1, 1);
    expect(responseDb("lowpass", 4000, 8000, FS)).toBeCloseTo(-13.53, 2);
    expect(responseDb("lowpass", 4000, 16000, FS)).toBeCloseTo(-32.4, 1);
    // the same cutoff in the other mode is the mirror image
    expect(responseDb("lowpass", 180, 45, FS)).toBeCloseTo(10 * Math.log10(1 / (1 + 1 / 256)), 3);   // -0.017 dB
    // the numeric guard: past Nyquist the maths uses just-under-Nyquist (unclamped, 22 kHz at
    // 32 kHz would read -8.9 dB at 12 kHz instead of ~0)
    expect(responseDb("lowpass", 22000, 12000, 32000)).toBeCloseTo(responseDb("lowpass", 15968, 12000, 32000), 3);
    expect(responseDb("lowpass", 22000, 12000, 32000)).toBeGreaterThan(-1);
  });

  it("flags a stored cutoff above Nyquist as unstable (the engine does not clamp)", () => {
    expect(isUnstable(22000, 32000)).toBe(true);
    expect(isUnstable(16000.5, 32000)).toBe(true);
    expect(isUnstable(16000, 32000)).toBe(false);
    expect(isUnstable(22000, 44100)).toBe(false);
    expect(isUnstable(22000, 48000)).toBe(false);
    expect(isUnstable(maxCutoff(32000), 32000)).toBe(false);   // nothing the UI sends is unstable
  });

  it("parses typed cutoffs", () => {
    expect(parseHz("180")).toBe(180);
    expect(parseHz(" 180 Hz ")).toBe(180);
    expect(parseHz("1.2k")).toBe(1200);
    expect(parseHz("1.2 kHz")).toBe(1200);
    expect(parseHz("4,000")).toBe(4000);
    expect(parseHz("1,5k")).toBe(1500);
    expect(parseHz("abc")).toBeNull();
    expect(parseHz("")).toBeNull();
    expect(parseHz("-5")).toBeNull();
  });

  it("summarises what the filter is doing in one short line of words: the type, then the cutoff", () => {
    expect(filterSummary(filter("highpass", 180))).toBe("high-pass 180 Hz");
    expect(filterSummary(filter("lowpass", 4000))).toBe("low-pass 4.0k");
    // bypass is the header's own on/off, not repeated in the summary
    expect(filterSummary(filter("highpass", 80, { enabled: false }))).toBe("high-pass 80 Hz");
    expect(filterPanelDef.summary(filter("lowpass", 12000))).toBe("low-pass 12k");
    // an older engine (no state): the type still says which
    expect(filterSummary({ ...filter("highpass", 180), state: undefined })).toBe("high-pass 180 Hz");
    // the minimized row's summary slot holds about 17 monospace characters: never cut
    for (const mode of ["lowpass", "highpass"] as const) {
      for (const hz of [10, 999, 4238, 9960, 22000]) {
        expect(filterSummary(filter(mode, hz)).length).toBeLessThanOrEqual(17);
      }
    }
    expect(filterSummary(filter("highpass", 999))).toBe("high-pass 999 Hz");   // the longest: 16
  });

  it("is titled Filter: the engine's LPF/HPF and High-Pass names are unhelpful", () => {
    expect(filterPanelDef.title).toBe("Filter");
  });

  it("places the handle on the log axis, pinned inside the plot past its ends", () => {
    const { x } = plotScales(FS);
    expect(handleX(1000, FS)).toBeCloseTo(x.to(1000), 9);
    expect(handleX(1000, FS)).toBeCloseTo((Math.log(1000 / 20) / Math.log(20000 / 20)) * PLOT_W, 6);
    // the viewBox is the drawn width at the 320 px inspector (273 px), so 1 unit = 1 px
    expect(PLOT_W).toBe(273);
    expect(handleX(1000, FS)).toBeCloseTo(154.606, 3);
    expect(handleX(10, FS)).toBe(0);
    expect(handleX(22000, FS)).toBe(PLOT_W);
    expect(cutoffAtX(0, FS)).toBeCloseTo(20, 9);
    expect(cutoffAtX(PLOT_W, FS)).toBeCloseTo(20000, 6);
    expect(cutoffAtX(-1000, FS)).toBe(10);
    expect(cutoffAtX(PLOT_W + 1000, FS)).toBe(22000);
    // at 32 kHz the plot stops just under Nyquist
    expect(plotScales(32000).top).toBeCloseTo(15968, 6);
  });

  it("maps keys: arrows 1/12 octave, Shift/Page an octave, Home/End the ends", () => {
    expect(keyTarget({ key: "ArrowRight", shiftKey: false }, 180, FS)).toBeCloseTo(190.7034, 3);
    expect(keyTarget({ key: "ArrowDown", shiftKey: true }, 180, FS)).toBeCloseTo(90, 9);
    expect(keyTarget({ key: "PageUp", shiftKey: false }, 180, FS)).toBeCloseTo(360, 9);
    expect(keyTarget({ key: "Home", shiftKey: false }, 180, FS)).toBe(10);
    expect(keyTarget({ key: "End", shiftKey: false }, 180, FS)).toBe(22000);
    expect(keyTarget({ key: "x", shiftKey: false }, 180, FS)).toBeNull();
  });
});

describe("FilterPanel wiring", () => {
  let host: HTMLDivElement;
  let root: Root;
  let setParam: ReturnType<typeof vi.fn>;
  let setState: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
    setParam = vi.fn();
    setState = vi.fn();
  });
  afterEach(() => {
    act(() => root.unmount());
    host.remove();
  });

  const render = (plugin: Plugin, sampleRate = FS) =>
    act(() => root.render(React.createElement(filterPanelDef.Panel, { plugin, trackId: "t1", sampleRate, setParam, setState })));
  const handle = () => host.querySelector<SVGGElement>('[data-testid="v3-filter-handle"]')!;
  const key = (el: Element, k: string, shiftKey = false) =>
    act(() => { el.dispatchEvent(new KeyboardEvent("keydown", { key: k, shiftKey, bubbles: true, cancelable: true })); });
  const sentNorms = () => setParam.mock.calls.map((c) => { expect(c[0]).toBe(0); return c[1] as number; });

  it("End sends exactly 1.0 (22 kHz) and Home exactly 0 (10 Hz)", () => {
    render(filter("highpass", 180));
    key(handle(), "End");
    key(handle(), "Home");
    expect(sentNorms()).toEqual([1, 0]);
  });

  it("an arrow sends 1/12 octave up, and a second arrow steps from the first (not the stale snapshot)", () => {
    render(filter("highpass", 180));
    key(handle(), "ArrowRight");
    key(handle(), "ArrowRight");
    key(handle(), "ArrowLeft", true);
    const n = sentNorms();
    expect(n[0]).toBeCloseTo(normFor(180 * 2 ** (1 / 12)), 9);
    expect(n[1]).toBeCloseTo(normFor(180 * 2 ** (2 / 12)), 9);
    expect(n[2]).toBeCloseTo(normFor(180 * 2 ** (2 / 12 - 1)), 9);
    // one burst of keys is one undo step
    const gestures = setParam.mock.calls.map((c) => c[2]?.gesture);
    expect(gestures[0]).toMatch(/^ui-/);
    expect(new Set(gestures).size).toBe(1);
  });

  it("at 32 kHz the End key stops just under Nyquist", () => {
    render(filter("lowpass", 4000), 32000);
    key(handle(), "End");
    expect(sentNorms()[0]).toBeCloseTo(normFor(32000 * 0.499), 9);
  });

  it("a typed cutoff is sent on Enter (120 Hz, then 1.2k)", () => {
    render(filter("highpass", 180));
    const input = host.querySelector<HTMLInputElement>('[data-testid="v3-filter-hz"]')!;
    expect(input.value).toBe("180 Hz");
    const type = (text: string) => {
      act(() => input.focus());
      act(() => {
        const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
        set.call(input, text);
        input.dispatchEvent(new Event("input", { bubbles: true }));
      });
      key(input, "Enter");
    };
    type("120");
    type("1.2k");
    type("nonsense");
    const n = sentNorms();
    expect(n).toHaveLength(2);
    expect(n[0]).toBeCloseTo(normFor(120), 9);
    expect(n[1]).toBeCloseTo(normFor(1200), 9);
  });

  it("the LP/HP switch sends set_plugin_state mode (physical string), and not for the current mode", () => {
    render(filter("lowpass", 4000));
    const lp = host.querySelector<HTMLButtonElement>('[data-testid="v3-filter-mode-lowpass"]')!;
    const hp = host.querySelector<HTMLButtonElement>('[data-testid="v3-filter-mode-highpass"]')!;
    expect(lp.getAttribute("aria-pressed")).toBe("true");
    expect(hp.getAttribute("aria-pressed")).toBe("false");
    act(() => lp.click());
    expect(setState).not.toHaveBeenCalled();
    act(() => hp.click());
    expect(setState).toHaveBeenCalledTimes(1);
    expect(setState.mock.calls[0].slice(0, 2)).toEqual(["mode", "highpass"]);
  });

  it("an older engine (no state.mode): LP/HP shows the reported type, disabled, with a note, and never sends", () => {
    const old = { ...filter("highpass", 180), state: undefined };
    render(old);
    const lp = host.querySelector<HTMLButtonElement>('[data-testid="v3-filter-mode-lowpass"]')!;
    const hp = host.querySelector<HTMLButtonElement>('[data-testid="v3-filter-mode-highpass"]')!;
    expect(hp.getAttribute("aria-pressed")).toBe("true");
    expect(lp.disabled && hp.disabled).toBe(true);
    expect(host.querySelector('[data-testid="v3-filter-old-engine"]')!.textContent).toMatch(/needs the updated Mosh engine/);
    act(() => lp.click());
    // a disabled button swallows the click; even dispatched directly, the handler refuses
    act(() => { lp.dispatchEvent(new MouseEvent("click", { bubbles: true })); });
    expect(setState).not.toHaveBeenCalled();
    // the cutoff is a plain parameter: it still works on the old engine
    key(handle(), "ArrowRight");
    expect(sentNorms()[0]).toBeCloseTo(normFor(180 * 2 ** (1 / 12)), 9);
    // the updated engine: enabled, no note
    render(filter("highpass", 180));
    expect(hp.disabled).toBe(false);
    expect(host.querySelector('[data-testid="v3-filter-old-engine"]')).toBeNull();
  });

  it("the cutoff reads as a frequency at rest and as the plain number while typing", () => {
    render(filter("lowpass", 4000));
    const input = field();
    expect(input.value).toBe("4.00 kHz");
    expect(host.querySelector(".pp-filter-unit")).toBeNull();
    act(() => input.focus());
    expect(input.value).toBe("4000");
    expect(host.querySelector(".pp-filter-unit")!.textContent).toBe("Hz");
    key(input, "Escape");
    expect(input.value).toBe("4.00 kHz");
    expect(setParam).not.toHaveBeenCalled();
  });

  it("a plot drag is one gesture and lands on the log-axis frequency under the pointer", () => {
    render(filter("highpass", 180));
    const svg = host.querySelector<SVGSVGElement>('[data-testid="v3-filter-plot"]')!;
    svg.getBoundingClientRect = () => ({ left: 0, top: 0, width: PLOT_W, height: PLOT_H, right: PLOT_W, bottom: PLOT_H, x: 0, y: 0, toJSON: () => ({}) });
    const { x } = plotScales(FS);
    const ptr = (type: string, hz: number) => act(() => {
      svg.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, button: 0, clientX: x.to(hz), clientY: 20 }));
    });
    ptr("pointerdown", 1000);
    ptr("pointermove", 2000);
    ptr("pointerup", 2000);
    const n = sentNorms();
    expect(n.length).toBeGreaterThanOrEqual(1);
    expect(n[n.length - 1]).toBeCloseTo(normFor(2000), 6);
    const g1 = new Set(setParam.mock.calls.map((c) => c[2]?.gesture));
    expect(g1.size).toBe(1);
    // a second drag is a second undo step
    ptr("pointerdown", 500);
    ptr("pointerup", 500);
    const last = setParam.mock.calls[setParam.mock.calls.length - 1];
    expect(last[1]).toBeCloseTo(normFor(500), 6);
    expect(g1.has(last[2]?.gesture)).toBe(false);
  });

  it("puts the handle on the curve at (cutoff, -3 dB); bypassed draws a flat 0 dB line", () => {
    render(filter("highpass", 180));
    const { x, y } = plotScales(FS);
    const m = /translate\(([-\d.]+) ([-\d.]+)\)/.exec(handle().getAttribute("transform")!)!;
    expect(Number(m[1])).toBeCloseTo(x.to(180), 1);
    expect(Number(m[2])).toBeCloseTo(y.to(-3.0103), 1);
    expect(handle().getAttribute("aria-valuetext")).toBe("180 Hz, 12 dB/oct");
    const curve = () => host.querySelector('[data-testid="v3-filter-curve"]')!.getAttribute("d")!;
    const ys = () => [...curve().matchAll(/[ML][-\d.]+ ([-\d.]+)/g)].map((r) => Number(r[1]));
    expect(new Set(ys()).size).toBeGreaterThan(10);           // a real slope

    render(filter("highpass", 180, { enabled: false }));
    expect(host.querySelector('[data-testid="v3-filter-plot"]')!.classList.contains("bypassed")).toBe(true);
    expect(new Set(ys())).toEqual(new Set([Number(y.to(0).toFixed(2))]));
    expect(handle().classList.contains("hollow")).toBe(true);
  });

  it("draws the axis labels over the curve (their halo keeps them legible) and under the handle", () => {
    render(filter("lowpass", 4000));
    const svg = host.querySelector('[data-testid="v3-filter-plot"]')!;
    const order = [...svg.querySelectorAll("path.curve, text.axis, [data-testid='v3-filter-handle']")]
      .map((el) => (el.matches("text") ? `t:${el.textContent}` : el.matches("path") ? "curve" : "handle"));
    expect(order).toEqual(["curve", "t:100", "t:1k", "t:10k", "t:-12", "t:-24", "t:0", "handle"]);
  });

  it("shows the automation chip only when the cutoff is automated", () => {
    render(filter("lowpass", 4000));
    expect(host.querySelector('[data-testid="v3-filter-automated"]')).toBeNull();
    const auto = filter("lowpass", 4000);
    auto.params[0].automated = true;
    render(auto);
    expect(host.querySelector('[data-testid="v3-filter-automated"]')).not.toBeNull();
  });

  it("the minimized thumbnail is the same curve", () => {
    act(() => root.render(React.createElement(filterPanelDef.Mini!, { plugin: filter("lowpass", 1000), trackId: "t1", sampleRate: FS, setParam, setState })));
    const d = host.querySelector('[data-testid="v3-filter-mini"] path')!.getAttribute("d")!;
    const pts = [...d.matchAll(/[ML]([-\d.]+) ([-\d.]+)/g)].map((r) => [Number(r[1]), Number(r[2])]);
    const mini = plotScales(FS, MINI_W, MINI_H);
    const svg = host.querySelector('[data-testid="v3-filter-mini"]')!;
    expect([svg.getAttribute("width"), svg.getAttribute("height")]).toEqual(["44", "14"]);   // the row's 44×14 slot
    // its first point is flat passband, its last is well into the stopband
    expect(pts[0][1]).toBeCloseTo(mini.y.to(responseDb("lowpass", 1000, 20, FS)), 1);
    expect(pts[pts.length - 1][1]).toBeCloseTo(Math.min(MINI_H, mini.y.to(responseDb("lowpass", 1000, 20000, FS))), 1);
  });

  const svgOf = () => {
    const svg = host.querySelector<SVGSVGElement>('[data-testid="v3-filter-plot"]')!;
    svg.getBoundingClientRect = () => ({ left: 0, top: 0, width: PLOT_W, height: PLOT_H, right: PLOT_W, bottom: PLOT_H, x: 0, y: 0, toJSON: () => ({}) });
    return svg;
  };
  const ptrAt = (el: Element, type: string, px: number) => act(() => {
    el.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, button: 0, clientX: px, clientY: 20 }));
  });
  const points = (sel: string) => {
    const d = host.querySelector(sel)!.getAttribute("d")!;
    return [...d.matchAll(/[ML]([-\d.]+) ([-\d.]+)/g)].map((r) => [Number(r[1]), Number(r[2])] as const);
  };
  const field = () => host.querySelector<HTMLInputElement>('[data-testid="v3-filter-hz"]')!;
  const lastHz = () => { const n = sentNorms(); return 10 + n[n.length - 1] * SPAN; };

  it("keys on the handle never reach the app's global shortcuts (Home/End/arrows)", () => {
    render(filter("highpass", 180));
    const spy = vi.fn();
    window.addEventListener("keydown", spy);
    try {
      key(handle(), "Home");
      key(handle(), "End");
      key(handle(), "ArrowRight");
      key(handle(), "ArrowUp", true);
      expect(spy).not.toHaveBeenCalled();
      expect(setParam).toHaveBeenCalledTimes(4);
      key(handle(), "x");                   // not ours: it still bubbles
      expect(spy).toHaveBeenCalledTimes(1);
    } finally {
      window.removeEventListener("keydown", spy);
    }
  });

  it("draws the curve for the plugin's own mode and the session's rate", () => {
    const check = (mode: "lowpass" | "highpass", hz: number, fs: number) => {
      render(filter(mode, hz), fs);
      const { x, y } = plotScales(fs);
      const pts = points('[data-testid="v3-filter-curve"]');
      expect(pts.length).toBe(96);
      for (const [px, py] of pts) {
        const want = Math.min(PLOT_H, Math.max(0, y.to(responseDb(mode, hz, x.from(px), fs))));
        expect(py).toBeCloseTo(want, 1);
      }
      return pts;
    };
    const hp = check("highpass", 180, FS);
    const { x, y } = plotScales(FS);
    const near45 = hp.reduce((a, b) => (Math.abs(b[0] - x.to(45)) < Math.abs(a[0] - x.to(45)) ? b : a));
    expect(near45[1]).toBeCloseTo(y.to(responseDb("highpass", 180, x.from(near45[0]), FS)), 1);
    expect(near45[1]).toBeGreaterThan(y.to(-20));            // deep in the HP stopband (y grows downward)
    const lp = check("lowpass", 180, FS);
    expect(lp[hp.indexOf(near45)][1]).toBeLessThan(y.to(-1)); // ~0 dB in the LP passband
    // at 32 kHz the plot ends just under Nyquist, and the curve is computed at that rate
    const lp32 = check("lowpass", 4000, 32000);
    const last = lp32[lp32.length - 1];
    expect(last[0]).toBeCloseTo(PLOT_W, 2);
    expect(last[1]).toBeCloseTo(Math.min(PLOT_H, plotScales(32000).y.to(responseDb("lowpass", 4000, 15968, 32000))), 1);
  });

  it("a cutoff above Nyquist (22 kHz stored, 32 kHz session) draws no curve and says it is unstable", () => {
    render(filter("lowpass", 22000), 32000);
    expect(host.querySelector('[data-testid="v3-filter-curve"]')).toBeNull();
    expect(host.querySelector('[data-testid="v3-filter-unstable"]')!.textContent).toMatch(/unstable/);
    expect(host.querySelector('[data-testid="v3-filter-plot"]')!.classList.contains("unstable")).toBe(true);
    expect(handle().classList.contains("hollow")).toBe(true);
    expect(handle().getAttribute("aria-valuetext")).toBe("22.0 kHz, above Nyquist: unstable");
    expect(field().value).toBe("22.0 kHz");
    // End brings it back under Nyquist
    key(handle(), "End");
    expect(sentNorms()[0]).toBeCloseTo(normFor(32000 * 0.499), 9);
    // the same value at 48 kHz is a normal low-pass
    render(filter("lowpass", 22000), FS);
    expect(host.querySelector('[data-testid="v3-filter-unstable"]')).toBeNull();
    expect(host.querySelector('[data-testid="v3-filter-curve"]')).not.toBeNull();
  });

  it("the minimized thumbnail draws nothing above Nyquist", () => {
    act(() => root.render(React.createElement(filterPanelDef.Mini!, { plugin: filter("lowpass", 22000), trackId: "t1", sampleRate: 32000, setParam, setState })));
    const mini = host.querySelector('[data-testid="v3-filter-mini"]')!;
    expect(mini.querySelector("path")).toBeNull();
    expect(mini.classList.contains("unstable")).toBe(true);
  });

  it("double-clicking the handle resets by mode: HP to 180 Hz, LP to 4 kHz", () => {
    const dbl = () => act(() => { handle().dispatchEvent(new MouseEvent("dblclick", { bubbles: true, cancelable: true })); });
    render(filter("highpass", 1000));
    dbl();
    expect(sentNorms()[0]).toBeCloseTo(normFor(180), 9);
    render(filter("lowpass", 1000));
    dbl();
    expect(sentNorms()[1]).toBeCloseTo(normFor(4000), 9);
  });

  it("a handle drag moves by the pointer's travel (grabbed off-centre: no jump), as one gesture", () => {
    render(filter("highpass", 180));
    svgOf();
    const { x } = plotScales(FS);
    const cx = x.to(180);
    ptrAt(handle(), "pointerdown", cx + 8);       // grabbed 8 px right of the dot's centre
    ptrAt(handle(), "pointermove", cx + 9);       // 1 px of travel
    ptrAt(handle(), "pointermove", cx + 18);      // 10 px of travel
    ptrAt(handle(), "pointerup", cx + 18);
    const n = sentNorms();
    expect(n.length).toBeGreaterThanOrEqual(1);
    expect(n[n.length - 1]).toBeCloseTo(normFor(x.from(cx + 10)), 6);
    expect(new Set(setParam.mock.calls.map((c) => c[2]?.gesture)).size).toBe(1);
    // the absolute mapping would have jumped to x.from(cx + 18)
    expect(Math.abs(lastHz() - x.from(cx + 18))).toBeGreaterThan(20);
  });

  it("a handle drag from below the plot (10 Hz, pinned at the edge) starts from 10 Hz, not 20", () => {
    render(filter("highpass", 10));
    svgOf();
    const { x } = plotScales(FS);
    ptrAt(handle(), "pointerdown", 0);
    ptrAt(handle(), "pointermove", 5);
    ptrAt(handle(), "pointerup", 5);
    expect(lastHz()).toBeCloseTo(x.from(x.to(10) + 5), 3);
  });

  describe("the shown value: newest intent wins, the snapshot takes over when it moves", () => {
    beforeEach(() => { vi.useFakeTimers(); });
    afterEach(() => { vi.useRealTimers(); });

    it("a drag after a key replaces the key's pending value (no stale step 450 ms later)", () => {
      render(filter("highpass", 180));
      key(handle(), "ArrowRight");                 // pending 190.7 Hz
      const svg = svgOf();
      const { x } = plotScales(FS);
      act(() => { vi.advanceTimersByTime(100); });
      ptrAt(svg, "pointerdown", x.to(2000));
      // during the drag the handle follows the pointer, not the key's pending value
      expect(handle().getAttribute("aria-valuetext")).toBe("2.00 kHz, 12 dB/oct");
      ptrAt(svg, "pointerup", x.to(2000));
      render(filter("highpass", 2000));            // the engine's patch
      act(() => { vi.advanceTimersByTime(350); }); // the drag's settle (300 ms) is over, < 800 ms
      expect(field().value).toBe("2.00 kHz");
      expect(handle().getAttribute("aria-valuetext")).toBe("2.00 kHz, 12 dB/oct");
      key(handle(), "ArrowRight");
      expect(lastHz()).toBeCloseTo(2000 * 2 ** (1 / 12), 3);
    });

    it("a key within the drag's settle steps from the drag's value, and is shown at once", () => {
      render(filter("highpass", 180));
      const svg = svgOf();
      const { x } = plotScales(FS);
      ptrAt(svg, "pointerdown", x.to(1000));
      ptrAt(svg, "pointerup", x.to(1000));
      key(handle(), "ArrowRight");
      expect(field().value).toBe(fmtFreq(x.from(x.to(1000)) * 2 ** (1 / 12)));
      key(handle(), "ArrowRight");
      expect(lastHz()).toBeCloseTo(x.from(x.to(1000)) * 2 ** (2 / 12), 3);
    });

    it("a snapshot change we did not send (undo, agent) replaces the pending value at once", () => {
      render(filter("highpass", 180));
      key(handle(), "ArrowRight");
      expect(field().value).toBe("191 Hz");
      render(filter("highpass", 500));
      expect(field().value).toBe("500 Hz");
      key(handle(), "ArrowRight");
      expect(lastHz()).toBeCloseTo(500 * 2 ** (1 / 12), 3);
    });

    it("an echo of an earlier key in a burst keeps the newer value; the latest echo hands over", () => {
      render(filter("highpass", 180));
      key(handle(), "ArrowRight");
      key(handle(), "ArrowRight");
      render(filter("highpass", 180 * 2 ** (1 / 12)));   // echo of the first key
      expect(field().value).toBe(fmtFreq(180 * 2 ** (2 / 12)));
      key(handle(), "ArrowRight");
      expect(lastHz()).toBeCloseTo(180 * 2 ** (3 / 12), 3);
      render(filter("highpass", 180 * 2 ** (3 / 12)));   // caught up
      act(() => { vi.advanceTimersByTime(1000); });
      expect(field().value).toBe(fmtFreq(180 * 2 ** (3 / 12)));
    });
  });

  it("accessible names: LP/HP contain their visible text; the chip says what A means; the slider has a value and range", () => {
    const auto = filter("highpass", 180);
    auto.params[0].automated = true;
    render(auto);
    const hp = host.querySelector<HTMLButtonElement>('[data-testid="v3-filter-mode-highpass"]')!;
    expect(hp.getAttribute("aria-label")!.startsWith(hp.textContent!)).toBe(true);
    expect(host.querySelector('[data-testid="v3-filter-automated"]')!.getAttribute("aria-label")).toMatch(/automat/i);
    expect(handle().getAttribute("aria-valuenow")).toBe("180");
    expect(handle().getAttribute("aria-valuemin")).toBe("10");
    expect(handle().getAttribute("aria-valuemax")).toBe("22000");
    render(filter("highpass", 180), 32000);
    expect(handle().getAttribute("aria-valuemax")).toBe("15968");
  });
});
