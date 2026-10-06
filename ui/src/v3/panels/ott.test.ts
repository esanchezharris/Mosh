import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { builtinPlugin } from "../../mock/builtins";
import { useStore } from "../../store";
import type { OttMeter, Plugin } from "../../types";
import { OTT_CLIP_HOLD_MS, ottPanelDef } from "./OttPanel";
import {
  OTT_LEVEL_AXIS, fmtAmount, ottBandView, ottGainDb, ottMeterOf, ottOutputOnly, ottSettings, ottSummary, ottTaus,
} from "./ott";
import type { PanelProps } from "./types";

/** A native-default Mosh OTT (exactly what the engine and the mock send), with overrides
 *  as normalised values by param index. */
function ott(norms: Record<number, number> = {}): Plugin {
  const p = builtinPlugin("moshOTT", 0)!;
  return { ...p, params: p.params.map((q) => (q.index in norms ? { ...q, value: norms[q.index] } : q)) };
}

describe("Mosh OTT maths (MoshOTTDsp.cpp ottGainDb)", () => {
  it("cuts 5.25·Amount dB at a 0 dBFS envelope (4:1 above -20, weighted 0.35)", () => {
    expect(ottGainDb(0, 1)).toBeCloseTo(-5.25, 6);
    expect(ottGainDb(0, 0.12)).toBeCloseTo(-0.63, 6);
    // the effective downward ratio above threshold at full Amount: 1/(1 - 0.2625) = 1.356:1
    const slope = 1 + (ottGainDb(-10, 1) - ottGainDb(-20.0001, 1)) / (-10 + 20.0001);
    expect(1 / slope).toBeCloseTo(1.356, 3);
  });

  it("lifts inside -76..-38 dBFS only, up to 4.275·Amount dB, with a cliff at -76", () => {
    expect(ottGainDb(-75.999, 1)).toBeCloseTo(4.275, 2);
    expect(ottGainDb(-76, 1)).toBe(0);
    expect(ottGainDb(-80, 1)).toBe(0);
    expect(ottGainDb(-38, 1)).toBe(0);
    expect(ottGainDb(-30, 1)).toBe(0);           // the -38..-20 dead zone
    expect(ottGainDb(-20, 1)).toBe(0);
    expect(ottGainDb(-50, 1, 2)).toBeCloseTo(2 + 12 * 0.45 * 0.25, 6);   // the trim adds on top
  });

  it("derives the envelope taus from Time (attack 0.18×, both ≥ 1 ms)", () => {
    expect(ottTaus(120)).toEqual({ attackMs: expect.closeTo(21.6, 6), releaseMs: expect.closeTo(120, 6) });
    expect(ottTaus(5).attackMs).toBeCloseTo(1, 6);
    expect(ottTaus(5).releaseMs).toBeCloseTo(5, 6);
  });

  it("reads native defaults in physical units", () => {
    const s = ottSettings(ott());
    expect(s.amount).toBeCloseTo(0.12, 6);
    expect(s.time).toBeCloseTo(120, 6);
    expect(s.output).toBeCloseTo(-1, 6);
    expect(s.mix).toBe(1);
    expect([s.low, s.mid, s.high]).toEqual([0, 0, 0]);
    expect(ottOutputOnly(0.0001)).toBe(true);
    expect(ottOutputOnly(0.0002)).toBe(false);
    expect(fmtAmount(0.003)).toBe("<1%");
    expect(fmtAmount(0)).toBe("0%");
  });

  it("summarises what the OTT is doing", () => {
    expect(ottSummary(ott())).toBe("12% · 120 ms · out -1.0 dB");
    // Low +2 dB (14/24), High -1.5 dB (10.5/24), mix 50%, output 0 dB (18/24)
    expect(ottSummary(ott({ 2: 14 / 24, 4: 10.5 / 24, 5: 0.5, 6: 0.75 }))).toBe("12% · 120 ms · L +2.0 H -1.5 dB · mix 50%");
    expect(ottSummary(ott({ 0: 0 }))).toBe("amount 0 · out -1.0 dB only");
    expect(ottSummary(ott({ 0: 0, 6: 0.75, 2: 1 }))).toBe("flat");   // the trim is skipped at Amount 0
  });

  it("maps a meter band onto the bars", () => {
    const m = { trackId: "t", index: 0, type: "moshOTT", clipped: false,
      bands: [{ levelDb: -23, gainDb: 1.5 }, { levelDb: -100, gainDb: -9 }, { levelDb: 3, gainDb: 0 }] } as OttMeter;
    const lo = ottBandView(m, 0)!;
    expect(lo.level).toBeCloseTo((-23 - OTT_LEVEL_AXIS.min) / 80, 6);
    expect(lo.lift).toBeCloseTo(0.25, 6);
    expect(lo.cut).toBe(0);
    expect(lo.gainText).toBe("+1.5 dB");
    expect(lo.levelText).toBe("-23 dBFS");
    const mid = ottBandView(m, 1)!;
    expect(mid).toMatchObject({ level: 0, lift: 0, cut: 1, over: true, levelText: "-∞ dBFS", gainText: "-9.0 dB" });
    expect(ottBandView(m, 2)!.level).toBe(1);
    expect(ottBandView(undefined, 0)).toBeNull();
    expect(ottBandView(m, 3)).toBeNull();
  });

  it("accepts only its own frame type (a delete/reorder can leave another plugin's frame at its key)", () => {
    const own = { trackId: "t", index: 0, type: "moshOTT", clipped: false, bands: [] } as OttMeter;
    expect(ottMeterOf(own)).toBe(own);
    expect(ottMeterOf({ trackId: "t", index: 0, type: "compressor", grDb: 3, inDb: -6, outDb: -9 })).toBeUndefined();
    expect(ottMeterOf({ ...own, itemId: "a" }, "b")).toBeUndefined();
    expect(ottMeterOf({ ...own, itemId: "a" }, "a")).toBeDefined();
    expect(ottMeterOf({ trackId: "t", index: 0, type: "moshOTT" } as unknown as OttMeter)).toBeUndefined();
  });
});

describe("Mosh OTT panel", () => {
  let host: HTMLDivElement;
  let root: Root;
  let setParam: ReturnType<typeof vi.fn>;

  const render = (plugin: Plugin, which: "Panel" | "Mini" = "Panel") => {
    const props: PanelProps = { plugin, trackId: "t1", sampleRate: 48000, setParam: setParam as PanelProps["setParam"], setState: vi.fn() };
    const C = which === "Panel" ? ottPanelDef.Panel : ottPanelDef.Mini!;
    act(() => root.render(React.createElement(C, props)));
  };
  const key = (el: Element, k: string, init: KeyboardEventInit = {}) =>
    act(() => { el.dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true, ...init })); });
  const meter = (bands: OttMeter["bands"], clipped = false) =>
    act(() => useStore.setState({ pluginMeters: { "t1:0": { trackId: "t1", index: 0, type: "moshOTT", bands, clipped } } }));

  beforeEach(() => {
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    setParam = vi.fn();
    useStore.setState({ pluginMeters: {} });
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
  });
  afterEach(() => {
    act(() => root.unmount());
    host.remove();
    useStore.setState({ pluginMeters: {} });
  });

  it("is idle with no meter frame, and draws the live bars from one", () => {
    render(ott());
    const live = () => [...host.querySelectorAll('[data-testid="v3-ott-band-live"]')];
    expect(live()).toHaveLength(3);
    expect(live().every((el) => !el.hasAttribute("data-live"))).toBe(true);
    expect([...host.querySelectorAll('[data-testid="v3-ott-gain"]')].map((e) => e.textContent)).toEqual(["–", "–", "–"]);
    expect(host.querySelector('[data-testid="v3-ott-clip"]')!.hasAttribute("data-on")).toBe(false);

    meter([{ levelDb: -50, gainDb: 1.5 }, { levelDb: -12, gainDb: -3 }, { levelDb: -30, gainDb: 0 }], true);
    expect(live().every((el) => el.hasAttribute("data-live"))).toBe(true);
    expect([...host.querySelectorAll('[data-testid="v3-ott-gain"]')].map((e) => e.textContent)).toEqual(["+1.5 dB", "-3.0 dB", "0.0 dB"]);
    // lift = 1.5/6 of the 15-unit half bar, cut = 3/6 of it
    expect(Number(host.querySelector('[data-testid="v3-ott-lift"]')!.getAttribute("height"))).toBeCloseTo(3.75, 6);
    expect(Number(host.querySelector('[data-testid="v3-ott-cut"]')!.getAttribute("height"))).toBeCloseTo(7.5, 6);
    expect(host.querySelectorAll('[data-testid="v3-ott-lift"]')).toHaveLength(1);
    expect(host.querySelector('[data-testid="v3-ott-clip"]')!.hasAttribute("data-on")).toBe(true);
  });

  it("holds the clip light for 1 s after the LAST clipped frame, then releases it", () => {
    vi.useFakeTimers();
    try {
      render(ott());
      const clip = () => host.querySelector('[data-testid="v3-ott-clip"]')!;
      const b = [{ levelDb: -12, gainDb: -2 }, { levelDb: -12, gainDb: -2 }, { levelDb: -12, gainDb: -2 }];
      // a one-frame burst
      meter(b, true);
      expect(clip().hasAttribute("data-on")).toBe(true);
      meter(b.map((x) => ({ ...x })), false);
      act(() => { vi.advanceTimersByTime(OTT_CLIP_HOLD_MS - 1); });
      expect(clip().hasAttribute("data-on")).toBe(true);
      act(() => { vi.advanceTimersByTime(2); });
      expect(clip().hasAttribute("data-on")).toBe(false);
      expect(clip().getAttribute("aria-label")).toBe("Output not clipping");
      // a long clip: still held 1 s past its last clipped frame
      meter(b.map((x) => ({ ...x })), true);
      act(() => { vi.advanceTimersByTime(2000); });
      meter(b.map((x) => ({ ...x })), false);
      expect(clip().hasAttribute("data-on")).toBe(true);
      act(() => { vi.advanceTimersByTime(OTT_CLIP_HOLD_MS - 1); });
      expect(clip().hasAttribute("data-on")).toBe(true);
      act(() => { vi.advanceTimersByTime(2); });
      expect(clip().hasAttribute("data-on")).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it("stays idle (and does not throw) on another plugin's frame at its key", () => {
    act(() => useStore.setState({ pluginMeters: { "t1:0": { trackId: "t1", index: 0, type: "compressor", grDb: 6, inDb: -3, outDb: -9 } } }));
    render(ott());
    expect([...host.querySelectorAll('[data-testid="v3-ott-band-live"]')].some((el) => el.hasAttribute("data-live"))).toBe(false);
    expect(host.querySelector('[data-testid="v3-ott-clip"]')!.hasAttribute("data-on")).toBe(false);
    render(ott(), "Mini");
    expect(host.querySelector('[data-testid="v3-ott-mini"]')!.classList.contains("idle")).toBe(true);
  });

  it("sends the exact normalised value for each control", () => {
    render(ott());
    const slider = (id: string) => host.querySelector(`[data-testid="${id}"] [role="slider"]`)!;
    key(slider("v3-ott-amount"), "End");
    expect(setParam).toHaveBeenLastCalledWith(0, 1, { gesture: expect.any(String) });
    key(slider("v3-ott-output"), "Home");
    expect(setParam).toHaveBeenLastCalledWith(6, 0, { gesture: expect.any(String) });
    key(slider("v3-ott-time"), "ArrowUp");
    expect(setParam.mock.lastCall![0]).toBe(1);
    expect(setParam.mock.lastCall![1]).toBeCloseTo(115 / 495 + 0.01, 9);

    const trims = [...host.querySelectorAll('[data-testid="v3-ott-trim"]')];
    expect(trims.map((t) => t.getAttribute("aria-label"))).toEqual(["Low Gain", "Mid Gain", "High Gain"]);
    expect(trims[0].getAttribute("aria-valuetext")).toBe("0.0 dB");
    key(trims[0], "ArrowUp");                                  // +0.5 dB
    expect(setParam).toHaveBeenLastCalledWith(2, 12.5 / 24, { gesture: expect.any(String) });
    key(trims[2], "End");
    expect(setParam).toHaveBeenLastCalledWith(4, 1, { gesture: expect.any(String) });
    key(trims[1], "PageDown");                                 // -3 dB
    expect(setParam.mock.lastCall![0]).toBe(3);
    expect(setParam.mock.lastCall![1]).toBeCloseTo(9 / 24, 9);
  });

  it("makes one trim drag one gesture, sideways across the full range", async () => {
    render(ott());
    const trim = host.querySelector('[data-testid="v3-ott-trim"]')!;
    const frame = () => act(async () => { await new Promise((r) => setTimeout(r, 40)); });   // let the per-frame send flush
    act(() => { trim.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, button: 0, clientX: 100, pointerId: 1 })); });
    act(() => { trim.dispatchEvent(new PointerEvent("pointermove", { bubbles: true, clientX: 110, pointerId: 1 })); });
    await frame();
    act(() => { trim.dispatchEvent(new PointerEvent("pointermove", { bubbles: true, clientX: 120, pointerId: 1 })); });
    await frame();
    act(() => { trim.dispatchEvent(new PointerEvent("pointerup", { bubbles: true, clientX: 120, pointerId: 1 })); });
    // jsdom has no layout: the drag span falls back to 80 px for the full 24 dB, so 10 px = +3 dB, 20 px = +6 dB
    const values = setParam.mock.calls.map((c) => c[1] as number);
    expect(values[0]).toBeCloseTo(15 / 24, 9);
    expect(setParam).toHaveBeenLastCalledWith(2, 18 / 24, { gesture: expect.any(String) });
    // several sends during the drag, all under the one gesture (one undo step)
    expect(setParam.mock.calls.length).toBeGreaterThanOrEqual(2);
    const gestures = new Set(setParam.mock.calls.map((c) => (c[2] as { gesture: string }).gesture));
    expect(gestures.size).toBe(1);
    // the next drag is a new gesture
    act(() => { trim.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, button: 0, clientX: 100, pointerId: 1 })); });
    act(() => { trim.dispatchEvent(new PointerEvent("pointermove", { bubbles: true, clientX: 90, pointerId: 1 })); });
    act(() => { trim.dispatchEvent(new PointerEvent("pointerup", { bubbles: true, clientX: 90, pointerId: 1 })); });
    expect(new Set(setParam.mock.calls.map((c) => (c[2] as { gesture: string }).gesture)).size).toBe(2);
  });

  it("says when Amount 0 leaves only Output, and dims Mix but keeps it adjustable", () => {
    render(ott({ 0: 0 }));
    expect(host.querySelector('[data-testid="v3-ott-note"]')).not.toBeNull();
    expect(host.querySelector('[data-testid="v3-ott-mixw"]')!.classList.contains("inert")).toBe(true);
    const mix = host.querySelector('[data-testid="v3-ott-mix"] [role="slider"]')!;
    expect(mix.getAttribute("tabindex")).toBe("0");
    expect(mix.getAttribute("aria-valuetext")).toBe("100%, skipped at Amount 0");
    key(mix, "Home");
    expect(setParam).toHaveBeenLastCalledWith(5, 0, { gesture: expect.any(String) });
    render(ott());
    expect(host.querySelector('[data-testid="v3-ott-note"]')).toBeNull();
    expect(host.querySelector('[data-testid="v3-ott-mixw"]')!.classList.contains("inert")).toBe(false);
  });

  it("minimized ticks are idle without a frame and follow the bands with one", () => {
    render(ott(), "Mini");
    const mini = () => host.querySelector('[data-testid="v3-ott-mini"]')!;
    expect(mini().classList.contains("idle")).toBe(true);
    expect(mini().querySelectorAll("rect")).toHaveLength(0);
    meter([{ levelDb: -50, gainDb: 3 }, { levelDb: -10, gainDb: -6 }, { levelDb: -30, gainDb: 0 }]);
    expect(mini().classList.contains("idle")).toBe(false);
    const rects = [...mini().querySelectorAll("rect")];
    expect(rects.map((r) => Number(r.getAttribute("height")))).toEqual([3, 6]);
  });
});
