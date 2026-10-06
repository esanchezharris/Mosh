import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useStore } from "../../store";
import type { Plugin, PluginParam } from "../../types";
import {
  ATTACK, compGrDb, compOutDb, compSettings, compSummary, curveSamples, dynamicsFrame, fmtGr, fmtPeak, gaugeAngle, grAtFullScaleDb,
  fmtThr, grBoundDb, grScale, MAKEUP, outRange, RELEASE, ratioDialPos, ratioNormFromDial, shortDb, SIDECHAIN, SUMMARY_CHARS, unitySpan,
} from "./compressor";
import { compressorPanelDef } from "./CompressorPanel";
import { normOf, ratioNorm, ratioOf, thresholdNorm } from "./params";

const T24 = 10 ** (-24 / 20);

/** A compressor as the engine sends it: no min/max on threshold and ratio, min/max on 2-5. */
function comp(o: { thrDb?: number; ratio?: number; attack?: number; release?: number; makeup?: number; enabled?: boolean } = {}): Plugin {
  const params: PluginParam[] = [
    { index: 0, name: "Threshold", value: thresholdNorm(o.thrDb ?? -6) },
    { index: 1, name: "Ratio", value: ratioNorm(o.ratio ?? 2) },
    { index: 2, name: "Attack", value: normOf(undefined, o.attack ?? 100, ATTACK), ...ATTACK },
    { index: 3, name: "Release", value: normOf(undefined, o.release ?? 100, RELEASE), ...RELEASE },
    { index: 4, name: "Output gain", value: normOf(undefined, o.makeup ?? 0, MAKEUP), ...MAKEUP },
    { index: 5, name: "Sidechain gain", value: 0.5, ...SIDECHAIN },
  ];
  return { index: 0, name: "Compressor", type: "compressor", enabled: o.enabled ?? true, external: false, builtin: true, isInstrument: false, params } as Plugin;
}

describe("the static curve is Tracktion's linear-amplitude knee", () => {
  const s = { thrLin: T24, rho: 0.4, makeupDb: 0 };
  it("pins the research numbers (-24 dB, 2.5:1)", () => {
    expect(compGrDb(-6, T24, 0.4)).toBeCloseTo(6.456, 2);
    expect(compGrDb(0, T24, 0.4)).toBeCloseTo(7.173, 2);
    expect(grAtFullScaleDb(T24, 0.4)).toBeCloseTo(7.173, 2);
    // A textbook dB-domain 2.5:1 line would claim 10.8 dB here; the engine does not.
    expect(compGrDb(-6, T24, 0.4)).toBeLessThan(7);
    expect(compOutDb(-12, s)).toBeCloseTo(-17.181, 2);
  });
  it("is unity below the threshold, with the makeup applied everywhere", () => {
    expect(compOutDb(-30, s)).toBeCloseTo(-30, 9);
    expect(compGrDb(-30, T24, 0.4)).toBe(0);
    expect(compOutDb(-30, { ...s, makeupDb: 4 })).toBeCloseTo(-26, 9);
    expect(compOutDb(-6, { ...s, makeupDb: 4 }) - compOutDb(-6, s)).toBeCloseTo(4, 9);
  });
  it("has slope 1/N only at the knee, tending to 1 above it; GR is bounded by 20log10(N)", () => {
    const slope = (x: number) => (compOutDb(x + 0.001, s) - compOutDb(x, s)) / 0.001;
    expect(slope(-24 + 1e-4)).toBeCloseTo(0.4, 2);
    expect(slope(40)).toBeGreaterThan(0.95);
    expect(grBoundDb(0.5)).toBeCloseTo(6.0206, 3);
    expect(grBoundDb(0.25)).toBeCloseTo(12.041, 2);
    expect(grBoundDb(0)).toBe(Infinity);
    expect(compGrDb(60, T24, 0.5)).toBeLessThan(6.0206);
    expect(compGrDb(60, T24, 0.5)).toBeGreaterThan(5.9);
  });
  it("draws through the knee exactly; its output range holds the whole curve at any makeup", () => {
    expect(curveSamples(-48, 0, 49, -23.5)).toContain(-23.5);
    expect(curveSamples(-48, 0, 49, -23.5)).toHaveLength(50);
    expect(outRange(0)).toEqual({ lo: -48, hi: 0 });
    // A positive makeup lifts the top in 6 dB steps; the bottom still holds out(-48).
    expect(outRange(3)).toEqual({ lo: -48, hi: 6 });
    expect(outRange(6)).toEqual({ lo: -42, hi: 6 });
    expect(outRange(6.1)).toEqual({ lo: -42, hi: 12 });
    expect(outRange(24)).toEqual({ lo: -24, hi: 24 });
    // A negative makeup extends the bottom, so out(-48) = -48 + makeup is never clamped.
    expect(outRange(-5)).toEqual({ lo: -54, hi: 0 });
    expect(outRange(-10)).toEqual({ lo: -60, hi: 0 });
    for (const m of [-10, -7.3, -5, -0.1, 0, 0.1, 3, 6, 6.1, 13, 24]) {
      const r = outRange(m);
      expect(-48 + m).toBeGreaterThanOrEqual(r.lo - 1e-9);   // the curve's low end (unity below thr)
      expect(m).toBeLessThanOrEqual(r.hi + 1e-9);            // its high end: 0 dB in → at most +makeup
    }
  });
  it("clips the unity line to the output range the plot shows", () => {
    expect(unitySpan(-48, 0)).toEqual([-48, 0]);
    expect(unitySpan(-42, 6)).toEqual([-42, 0]);
    expect(unitySpan(-24, 24)).toEqual([-24, 0]);
    expect(unitySpan(-60, 0)).toEqual([-48, 0]);
  });
});

describe("settings, gauge and read-outs", () => {
  it("reads every param in physical units through the encodings", () => {
    const s = compSettings(comp({ thrDb: -24, ratio: 2.5, attack: 20, release: 150, makeup: 3 }));
    expect(s.thrDb).toBeCloseTo(-24, 6);
    expect(s.thrLin).toBeCloseTo(T24, 6);
    expect(s.ratio).toBeCloseTo(2.5, 6);
    expect(s.rho).toBeCloseTo(0.4, 6);
    expect(s.attackMs).toBeCloseTo(20, 6);
    expect(s.releaseMs).toBeCloseTo(150, 6);
    expect(s.makeupDb).toBeCloseTo(3, 6);
    expect(s.sidechainDb).toBeCloseTo(0, 6);
    const inf = compSettings(comp({ ratio: Infinity }));
    expect(inf.ratio).toBe(Infinity);
    expect(inf.rho).toBe(0);
  });
  it("scales the gauge to what a full-scale input would get", () => {
    expect(grAtFullScaleDb(10 ** (-6 / 20), 0.5)).toBeCloseTo(2.492, 2);
    expect(grScale(10 ** (-6 / 20), 0.5)).toBe(6);
    expect(grScale(T24, 0.4)).toBe(12);
    expect(grScale(0.01, 0)).toBe(48);
    // A ±50° face: at rest (no reduction) the needle leans right, full scale leans left.
    expect(gaugeAngle(0, 12)).toBe(50);
    expect(gaugeAngle(6, 12)).toBe(0);
    expect(gaugeAngle(12, 12)).toBe(-50);
    expect(gaugeAngle(30, 12)).toBe(-50);
    expect(gaugeAngle(NaN, 12)).toBe(50);
  });
  it("maps the ratio dial so right is harder, exactly 1 - stored", () => {
    expect(ratioOf(ratioNormFromDial(1))).toBe(Infinity);
    expect(ratioOf(ratioNormFromDial(0))).toBeCloseTo(1.0526, 3);
    expect(ratioDialPos(ratioNorm(4))).toBeCloseTo(0.7368, 3);
    expect(ratioOf(ratioNormFromDial(ratioDialPos(ratioNorm(2.5))))).toBeCloseTo(2.5, 9);
  });
  it("summarises what it is doing in one line that fits the minimized slot", () => {
    // Ratio at threshold, in words (no bare "-6 dB"); times and makeup stay in the panel.
    expect(compSummary(comp())).toBe("2:1 at -6 dB");
    expect(compSummary(comp({ thrDb: -24, ratio: 2.5, attack: 20, release: 150 }))).toBe("2.5:1 at -24 dB");
    expect(compSummary(comp({ thrDb: -18.3, ratio: Infinity, attack: 0.3, release: 10, makeup: 3 }))).toBe("∞:1 at -18.3 dB");
    // A long pair drops the "at", never a figure: the gentlest ratio, and a stored ratio near
    // 0 (over 1000:1).
    expect(SUMMARY_CHARS).toBe(16);
    expect(compSummary(comp({ thrDb: -18.3, ratio: 1.0526 }))).toBe("1.1:1 -18.3 dB");
    const extreme = comp({ thrDb: -18.3 });
    extreme.params[1] = { ...extreme.params[1], value: 0.001 };
    expect(compSummary(extreme)).toBe("1053:1 -18.3 dB");
    // The budget holds across the whole threshold and ratio range.
    for (const thr of [-40, -33.3, -18.3, -0.1, 0]) {
      for (const n of [0, 0.001, 0.01, 0.3, 0.5, 0.999, 1]) {
        const pl = comp({ thrDb: thr });
        pl.params[1] = { ...pl.params[1], value: n };
        expect(compSummary(pl).length).toBeLessThanOrEqual(SUMMARY_CHARS);
      }
    }
    expect(fmtPeak(-45.47)).toBe("-45.5 dBFS");
    expect(fmtPeak(-0.01)).toBe("0.0 dBFS");
    expect(fmtThr(-24)).toBe("-24.0 dB");
    expect(fmtThr(-0.01)).toBe("0.0 dB");
    expect(shortDb(-0.01)).toBe("0 dB");
    expect(fmtGr(3.14)).toBe("-3.1 dB");
    expect(fmtGr(0)).toBe("0.0 dB");
  });
  it("accepts only a dynamics frame of the same plugin type", () => {
    const f = { trackId: "t1", index: 0, type: "compressor", grDb: 1, inDb: -3, outDb: -4 };
    expect(dynamicsFrame(f, "compressor")).toBe(f);
    expect(dynamicsFrame({ ...f, type: "softclip" }, "compressor")).toBeUndefined();
    expect(dynamicsFrame({ trackId: "t1", index: 0, type: "compressor", bands: [], clipped: false }, "compressor")).toBeUndefined();
    expect(dynamicsFrame(undefined, "compressor")).toBeUndefined();
  });
});

describe("CompressorPanel", () => {
  let host: HTMLDivElement;
  let root: Root;
  const setParam = vi.fn();
  const render = (plugin: Plugin, which: "Panel" | "Mini" = "Panel") => {
    const C = compressorPanelDef[which]!;
    act(() => root.render(React.createElement(C, { plugin, trackId: "t1", sampleRate: 48000, setParam, setState: vi.fn() })));
  };
  const q = (id: string) => host.querySelector(`[data-testid="${id}"]`);
  const key = (el: Element, k: string, init: KeyboardEventInit = {}) =>
    act(() => { el.dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true, ...init })); });
  const sliderOf = (id: string) => q(id)!.querySelector('[role="slider"]')!;
  const frame = (o: Partial<{ grDb: number; inDb: number; outDb: number; type: string }> = {}) =>
    act(() => useStore.setState({
      pluginMeters: { "t1:0": { trackId: "t1", index: 0, type: "compressor", grDb: 3.14, inDb: -10, outDb: -13.1, ...o } as never },
    }));

  beforeEach(() => {
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    setParam.mockClear();
    useStore.setState({ pluginMeters: {} });
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
  });
  afterEach(() => {
    act(() => root.unmount());
    host.remove();
    useStore.setState({ pluginMeters: {} });
    vi.unstubAllGlobals();
  });

  it("draws the engine's curve, not a dB-domain line", () => {
    render(comp({ thrDb: -24, ratio: 2.5 }));
    const d = q("pp-compressor-curve")!.getAttribute("d")!;
    // The plot is 82 px with a matching viewBox (axis text at its real size). x = -12 dB
    // sits at 61.5 of 82; out = -17.18 dB on a -48..0 axis → y = 29.35.
    expect(q("pp-compressor-plot")!.getAttribute("viewBox")).toBe("0 0 82 82");
    expect(d).toContain(`L61.50 ${((-compOutDb(-12, { thrLin: T24, rho: 0.4, makeupDb: 0 }) / 48) * 82).toFixed(2)}`);
    expect(d).toContain("L61.50 29.35");
    expect(d).not.toContain("L61.50 32.80");   // the textbook line (-19.2 dB)
    // The threshold read-out is a dial footer: value, then its name.
    expect(q("pp-compressor-thrval")!.querySelector(".v")!.textContent).toBe("-24.0 dB");
    expect(q("pp-compressor-thrval")!.querySelector(".nm")!.textContent).toBe("Threshold");
  });

  it("keeps the unity line inside the plot at any makeup", () => {
    const ends = () => {
      const l = q("pp-compressor-unity")!;
      return ["x1", "y1", "x2", "y2"].map((a) => Number(l.getAttribute(a)));
    };
    render(comp({ makeup: 24 }));   // range -24..+24: unity runs -24..0 dB
    expect(ends()).toEqual([41, 82, 82, 41]);
    render(comp({ makeup: 3 }));    // range -48..+6
    const [x1, y1, x2, y2] = ends();
    expect([x1, y1, x2]).toEqual([0, 82, 82]);
    expect(y2).toBeCloseTo((6 / 54) * 82, 6);
    for (const v of ends()) { expect(v).toBeGreaterThanOrEqual(0); expect(v).toBeLessThanOrEqual(82); }
  });

  it("draws the low end of a negative-makeup curve where it is, not on a false floor", () => {
    render(comp({ thrDb: -40, ratio: 4, makeup: -10 }));
    const d = q("pp-compressor-curve")!.getAttribute("d")!;
    // -48 dB in → -58 dB out on a -60..0 axis: y = 79.27, not the bottom edge (82).
    expect(d.startsWith("M0.00 79.27")).toBe(true);
    // The threshold node sits on the real corner: -40 in → -50 out → y = 68.33.
    expect(q("pp-compressor-thr-node")!.getAttribute("transform")).toBe("translate(13.67 68.33)");
  });

  it("End on the ratio dial sends ∞:1 (stored 0); Home sends the gentlest (stored 1)", () => {
    render(comp());
    key(sliderOf("pp-compressor-ratio"), "End");
    expect(setParam).toHaveBeenLastCalledWith(1, 0, { gesture: expect.any(String) });
    key(sliderOf("pp-compressor-ratio"), "Home");
    expect(setParam).toHaveBeenLastCalledWith(1, 1, { gesture: expect.any(String) });
    expect(q("pp-compressor-ratio")!.textContent).toContain("2:1");
  });

  it("the time and makeup dials send the param's own normalised value", () => {
    render(comp({ attack: 20, release: 150, makeup: 0 }));
    key(sliderOf("pp-compressor-attack"), "End");
    expect(setParam).toHaveBeenLastCalledWith(2, 1, { gesture: expect.any(String) });
    key(sliderOf("pp-compressor-release"), "Home");
    expect(setParam).toHaveBeenLastCalledWith(3, 0, { gesture: expect.any(String) });
    key(sliderOf("pp-compressor-makeup"), "PageUp");
    expect(setParam.mock.lastCall![0]).toBe(4);
    expect(setParam.mock.lastCall![1]).toBeCloseTo(normOf(undefined, 0, MAKEUP) + 0.1, 9);
    expect(q("pp-compressor-attack")!.textContent).toContain("20 ms");
    expect(q("pp-compressor-release")!.textContent).toContain("150 ms");
  });

  it("the threshold handle is keyboard operable in dB and sends the gain encoding", () => {
    render(comp({ thrDb: -24 }));
    const node = q("pp-compressor-thr-node")!;
    expect(node.getAttribute("aria-valuetext")).toBe("-24.0 dB");
    key(node, "ArrowRight");
    expect(setParam).toHaveBeenLastCalledWith(0, thresholdNorm(-23), { gesture: expect.any(String) });
    key(node, "End");
    expect(setParam).toHaveBeenLastCalledWith(0, 1, { gesture: expect.any(String) });
    key(node, "Home");
    expect(setParam).toHaveBeenLastCalledWith(0, 0, { gesture: expect.any(String) });
  });

  it("dragging the threshold is one gesture and lands on the dB under the pointer", () => {
    // A manual animation-frame queue, flushed after every move, so each move really sends.
    const frames: FrameRequestCallback[] = [];
    vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => frames.push(cb));
    vi.stubGlobal("cancelAnimationFrame", () => {});
    const flush = () => act(() => { frames.splice(0).forEach((cb) => cb(0)); });
    render(comp({ thrDb: -6 }));
    const svg = q("pp-compressor-plot") as unknown as SVGSVGElement;
    svg.getBoundingClientRect = () => ({ left: 0, top: 0, width: 100, height: 100, right: 100, bottom: 100, x: 0, y: 0, toJSON: () => ({}) });
    const node = q("pp-compressor-thr-node")!;
    const ev = (type: string, clientX: number) => act(() => {
      node.dispatchEvent(new PointerEvent(type, { bubbles: true, clientX, clientY: 50, button: 0, pointerId: 1 }));
    });
    ev("pointerdown", 87.5);
    ev("pointermove", 25);   // -36 dB
    flush();
    ev("pointermove", 37.5); // -30 dB
    flush();
    ev("pointermove", 50);   // -24 dB
    flush();
    ev("pointerup", 50);
    expect(setParam.mock.calls.map((c) => c[1])).toEqual([thresholdNorm(-36), thresholdNorm(-30), thresholdNorm(-24)]);
    const first = setParam.mock.calls[0][2].gesture;
    for (const c of setParam.mock.calls) { expect(c[0]).toBe(0); expect(c[2].gesture).toBe(first); }
    // A second drag is a second undo step.
    setParam.mockClear();
    ev("pointerdown", 50);
    ev("pointermove", 62.5); // -18 dB
    flush();
    ev("pointerup", 62.5);
    expect(setParam).toHaveBeenLastCalledWith(0, thresholdNorm(-18), { gesture: expect.any(String) });
    expect(setParam.mock.calls[0][2].gesture).not.toBe(first);
  });

  it("the gauge, dot and read-outs are idle without a frame and live with one", () => {
    render(comp({ thrDb: -24, ratio: 2.5 }));
    const meter = () => q("pp-compressor-gauge")!.querySelector('[role="meter"]')!;
    expect(q("pp-compressor-gauge")!.hasAttribute("data-live")).toBe(false);
    // Idle: a muted dash in the number's slot and ONE "no signal" (never "listening" or "idle").
    expect(q("pp-compressor-gr")!.textContent).toBe("–");
    expect(q("pp-compressor-nosignal")!.textContent).toBe("no signal");
    expect(host.textContent).not.toMatch(/listening|idle/i);
    expect(q("pp-compressor-in")).toBeNull();
    expect(q("pp-compressor-dot")).toBeNull();
    expect(meter().getAttribute("aria-valuetext")).toBe("No signal");
    // The needle rests at 0 dB of reduction: leaning right, not lying flat.
    expect(q("pp-compressor-gauge")!.querySelector(".needle")!.getAttribute("style")).toContain("rotate(50.00deg)");
    frame();
    expect(q("pp-compressor-gauge")!.hasAttribute("data-live")).toBe(true);
    expect(q("pp-compressor-nosignal")).toBeNull();
    expect(q("pp-compressor-gr")!.textContent).toBe("-3.1 dB");
    expect(q("pp-compressor-gr")!.classList.contains("zero")).toBe(false);
    expect(q("pp-compressor-in")!.textContent).toBe("in -10.0 dBFS");
    expect(q("pp-compressor-out")!.textContent).toBe("out -13.1 dBFS");
    const dot = q("pp-compressor-dot")!;
    expect(Number(dot.getAttribute("cx"))).toBeCloseTo((38 / 48) * 82, 1);   // -10 dB on -48..0
    expect(Number(dot.getAttribute("cy"))).toBeCloseTo((13.1 / 48) * 82, 1);
    expect(meter().getAttribute("aria-valuenow")).toBe("3.1");
  });

  it("0.0 dB of reduction while playing reads muted, like the idle dash, not bright", () => {
    render(comp());
    frame({ grDb: 0, inDb: -30, outDb: -30 });
    expect(q("pp-compressor-gr")!.textContent).toBe("0.0 dB");
    expect(q("pp-compressor-gr")!.classList.contains("zero")).toBe(true);
    frame({ grDb: 0.04 });
    expect(q("pp-compressor-gr")!.classList.contains("zero")).toBe(true);
    frame({ grDb: 0.06 });
    expect(q("pp-compressor-gr")!.textContent).toBe("-0.1 dB");
    expect(q("pp-compressor-gr")!.classList.contains("zero")).toBe(false);
  });

  it("ignores a frame that belongs to another plugin type at the same slot", () => {
    render(comp());
    frame({ type: "softclip" });
    expect(q("pp-compressor-gauge")!.hasAttribute("data-live")).toBe(false);
    expect(q("pp-compressor-dot")).toBeNull();
  });

  it("keeps the inert sidechain gain behind a text disclosure, still adjustable", () => {
    render(comp());
    const more = q("pp-compressor-more") as HTMLButtonElement;
    expect(q("pp-compressor-sc")).toBeNull();
    expect(more.getAttribute("aria-expanded")).toBe("false");
    act(() => more.click());
    expect(more.getAttribute("aria-expanded")).toBe("true");
    expect(q("pp-compressor-sc")!.textContent).toMatch(/No effect/);
    // Live but without effect: the shared .inert look, not a faded (disabled) dial.
    expect(q("pp-compressor-scgain")!.classList.contains("inert")).toBe(true);
    expect(q("pp-compressor-scgain")!.classList.contains("off")).toBe(false);
    key(sliderOf("pp-compressor-scgain"), "End");
    expect(setParam).toHaveBeenLastCalledWith(5, 1, { gesture: expect.any(String) });
  });

  it("the gain dials grow away from unity: a tick at 0 dB, no arc at 0 dB", () => {
    render(comp({ makeup: 0 }));
    const makeup = q("pp-compressor-makeup")!;
    expect(makeup.querySelector(".unity")).not.toBeNull();
    expect(makeup.querySelector(".value")!.getAttribute("d")).toBe("");
    render(comp({ makeup: 6 }));
    expect(q("pp-compressor-makeup")!.querySelector(".value")!.getAttribute("d")).not.toBe("");
  });

  it("the minimized bar is idle without a frame and fills with one", () => {
    render(comp({ thrDb: -24, ratio: 2.5 }), "Mini");
    const bar = host.querySelector(".pp-bar")!;
    expect(bar.classList.contains("idle")).toBe(true);
    frame({ grDb: 6 });
    expect(q("pp-compressor-mini")!.hasAttribute("data-live")).toBe(true);
    expect(host.querySelector(".pp-bar")!.classList.contains("idle")).toBe(false);
    // 6 dB of a 12 dB scale.
    expect((host.querySelector(".pp-bar .fill") as HTMLElement).style.width).toBe("50%");
  });
});
