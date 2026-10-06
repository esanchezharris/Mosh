import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  dcBoostDb, fmtSpan, notchesHz, nyquistBoostDb, peakBoostDb, phaserDb, phaserMag, phaserSettings, phaserSummary,
  sweepAt, sweepBounds, sweepEnvelope, sweepOctaves, sweepSpanHz,
} from "./phaser";
import { phaserPanelDef, phaserPlotTop } from "./PhaserPanel";
import { mkBuiltinState } from "../../mock/builtins";
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
    expect(fmtSpan(48000, 5)).toBe("100 Hz–3.2k");
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
  it("the plot's top holds the true peak", () => {
    expect(phaserPlotTop(0.7)).toBe(18);
    expect(phaserPlotTop(0.95)).toBe(30);   // 1 + 1/0.05 = 21 → +26.4 dB
    expect(phaserPlotTop(0)).toBe(12);
  });
  it("summary and settings", () => {
    expect(phaserSummary(phaser())).toBe("0.40 Hz · 5.0 oct · FB 70%");
    expect(phaserSummary(phaser({ rate: 2.5, depth: 3.2, feedback: -0.4 }))).toBe("2.50 Hz · 3.2 oct · FB -40%");
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
  });

  const render = (plugin: Plugin, sampleRate = 48000) =>
    act(() => root.render(React.createElement(phaserPanelDef.Panel, { plugin, trackId: "t1", sampleRate, setParam, setState })));
  const dial = (id: string) => host.querySelector<SVGSVGElement>(`[data-testid="${id}"] svg`)!;
  const key = (el: Element, k: string, mods: KeyboardEventInit = {}) =>
    act(() => { el.dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true, ...mods })); });
  const text = (id: string) => host.querySelector(`[data-testid="${id}"]`)!.textContent;

  it("Rate, Depth and Feedback are dials in real units; End/Home send physical values", () => {
    render(phaser());
    expect(dial("v3-phaser-rate").getAttribute("aria-valuetext")).toBe("0.40 Hz, up and back every 2.50 s");
    expect(dial("v3-phaser-depth").getAttribute("aria-valuetext")).toBe("5.0 octaves, sweeps 100 Hz–3.2k");
    expect(dial("v3-phaser-feedback").getAttribute("aria-valuetext")).toBe("70%, lows up to +12.7 dB");
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
    expect(text("v3-phaser-sweep")).toBe("sweep100 Hz–3.2k");
    expect(text("v3-phaser-boost")).toBe("lows peak+12.7 dB");
    render(phaser({ feedback: -0.7 }));
    expect(text("v3-phaser-boost")).toBe(`highs peak+${sweepEnvelope(48000, 5, -0.7).peakDb.toFixed(1)} dB`);
    expect(text("v3-phaser-boost")).not.toBe("highs peak+12.7 dB");
    expect(host.querySelector('[data-testid="v3-phaser-plot"]')!.getAttribute("data-top-db")).toBe("18");
  });

  it("draws the exact curve; bypassed is flat and still; reduced motion is still", () => {
    reduced = true;
    render(phaser({ feedback: 0 }));
    const plot = host.querySelector('[data-testid="v3-phaser-plot"]')!;
    expect(plot.hasAttribute("data-animating")).toBe(false);
    expect(plot.getAttribute("aria-label")).toMatch(/not synced to the audio/);
    // At rest the sweep sits mid-way (2.5 octaves); the first point (20 Hz) is the curve's
    // value there, y = (top − dB)/(top − floor)·50 with top 12, floor −24.
    const d = host.querySelector('[data-testid="v3-phaser-curve"]')!.getAttribute("d")!;
    const y0 = Number(d.split(" ")[1]);
    const db20 = phaserDb(20, 48000, sweepAt(48000, 2.5), 0);
    expect(y0).toBeCloseTo(((12 - db20) / 36) * 50, 1);
    render(phaser({ feedback: 0 }, false));
    const flat = host.querySelector('[data-testid="v3-phaser-curve"]')!.getAttribute("d")!;
    const ys = new Set(flat.split(/[ML]/).filter(Boolean).map((pt) => pt.trim().split(" ")[1]));
    expect([...ys]).toEqual([(((12 - 0) / 36) * 50).toFixed(2)]);
    expect(host.querySelector('[data-testid="v3-phaser-plot"]')!.classList.contains("bypassed")).toBe(true);
  });

  it("the static band and its upper edge are primary; only the faint curve moves", () => {
    render(phaser());
    const peak = host.querySelector('[data-testid="v3-phaser-peak"]')!;
    expect(peak.getAttribute("class")).toBe("curve");
    expect(host.querySelector('[data-testid="v3-phaser-curve"]')!.getAttribute("class")).toBe("pp-phaser-now");
    expect(host.querySelector('[data-testid="v3-phaser-band"]')).not.toBeNull();
    // The upper edge is the envelope, not a sweep position: its first point is maxDb at 20 Hz.
    const env = sweepEnvelope(48000, 5, 0.7);
    const y0 = Number(peak.getAttribute("d")!.split(" ")[1]);
    expect(y0).toBeCloseTo(((18 - env.maxDb[0]) / 42) * 50, 1);
    // A visible (hover) cue says the motion is illustrative.
    expect(host.querySelector('[data-testid="v3-phaser-plot"] title')!.textContent).toMatch(/illustrative.*not synced/);
  });

  it("Shift+arrow steps one whole step; plain arrows 1% of the range in whole steps", () => {
    render(phaser());
    key(dial("v3-phaser-feedback"), "ArrowUp", { shiftKey: true });
    key(dial("v3-phaser-depth"), "ArrowDown", { shiftKey: true });
    key(dial("v3-phaser-rate"), "ArrowUp");
    expect(setState.mock.calls.map((c) => [c[0], c[1]])).toEqual([["feedback", 0.71], ["depth", 4.9], ["rate", 0.5]]);
  });

  it("free-runs while on and motion is allowed", () => {
    render(phaser());
    expect(host.querySelector('[data-testid="v3-phaser-plot"]')!.hasAttribute("data-animating")).toBe(true);
  });
});
