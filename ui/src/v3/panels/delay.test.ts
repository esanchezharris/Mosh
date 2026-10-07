import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useStore } from "../../store";
import type { Plugin, Snapshot } from "../../types";
import {
  MAX_TAPS, SUMMARY_CHARS, delayModel, delaySummary, dryGainOf, fmtFeedback, loopGainOf, matchingNote, noteMs, periodOf, tailText,
  timeFromDrag, timeKey, viewMs, wetGainOf,
} from "./delay";
import { delayPanelDef } from "./DelayPanel";
import type { PanelProps } from "./types";

/** A delay as the engine sends it: Feedback (-30..0 dB) and Mix (0..1) with min/max, and
 *  the time in `state` (contract). Defaults: -6 dB = 0.8, 30 % wet, 150 ms. */
function delay({ fb = 0.8, mix = 0.3, ms = 150, enabled = true, legacy = false } = {}): Plugin {
  return {
    index: 1, name: "Delay", type: "delay", enabled, external: false, builtin: true, isInstrument: false,
    params: [
      { index: 0, name: "Feedback", value: fb, min: -30, max: 0 },
      { index: 1, name: "Mix proportion", value: mix, min: 0, max: 1 },
    ],
    // An older engine publishes no `state` (and cannot set the time).
    ...(legacy ? {} : { state: { lengthMs: { value: ms, min: 1, max: 2000, step: 1, unit: "ms" } } }),
  };
}

describe("delay maths (te::DelayPlugin)", () => {
  it("crossfades with sin(v·π/2): 30 % is wet -6.86 dB, dry -1.00 dB", () => {
    expect(20 * Math.log10(wetGainOf(0.3))).toBeCloseTo(-6.859, 3);
    expect(20 * Math.log10(dryGainOf(0.3))).toBeCloseTo(-1.002, 3);
    expect(wetGainOf(0.5)).toBeCloseTo(Math.SQRT1_2, 9);
    expect(dryGainOf(1)).toBeCloseTo(0, 12);
  });

  it("turns the loop OFF at the -30 dB bottom (strict >), unity at 0 dB", () => {
    expect(loopGainOf(-30)).toBe(0);
    expect(loopGainOf(-29.99)).toBeGreaterThan(0.0316);
    expect(loopGainOf(-6)).toBeCloseTo(0.501, 3);
    expect(loopGainOf(0)).toBe(1);
  });

  it("truncates the delay to whole samples", () => {
    expect(periodOf(150, 48000)).toEqual({ samples: 7200, seconds: 0.15 });
    expect(periodOf(1, 44100).samples).toBe(44);
    expect(periodOf(1, 44100).seconds * 1000).toBeCloseTo(0.99773, 4);
  });

  it("defaults: 9 echoes above -60 dB at 150 ms steps, falling 6 dB each, 60 dB in 1.5 s", () => {
    const m = delayModel(delay(), 48000);
    expect(m.feedbackDb).toBeCloseTo(-6, 9);
    expect(m.taps).toHaveLength(9);
    expect(m.taps[0].ms).toBeCloseTo(150, 9);
    expect(m.taps[0].db).toBeCloseTo(-6.859, 3);
    expect(m.taps[8].ms).toBeCloseTo(1350, 9);
    expect(m.taps[8].db).toBeCloseTo(-54.859, 3);
    expect(m.tailS).toBeCloseTo(1.5, 9);
    expect(viewMs(m)).toBeCloseTo(1440, 6);
  });

  it("one repeat at the bottom, endless at the top, nothing with Mix at 0", () => {
    const off = delayModel(delay({ fb: 0 }), 48000);
    expect(off.oneRepeat).toBe(true);
    expect(off.taps).toHaveLength(1);
    expect(off.tailS).toBeNull();
    expect(viewMs(off)).toBeCloseTo(390, 6);   // two periods + room, so the second-echo handle shows
    const inf = delayModel(delay({ fb: 1 }), 48000);
    expect(inf.infinite).toBe(true);
    expect(inf.taps).toHaveLength(MAX_TAPS);
    expect(inf.taps[63].db).toBeCloseTo(-6.859, 3);
    expect(inf.tailS).toBe(Infinity);
    expect(delayModel(delay({ mix: 0 }), 48000).taps).toHaveLength(0);
  });

  it("time drag: 60 px up doubles, down halves (240 with Shift), whole ms, 1..2000", () => {
    expect(timeFromDrag(150, 60)).toBe(300);
    expect(timeFromDrag(150, -60)).toBe(75);
    expect(timeFromDrag(150, 60, true)).toBe(178);
    expect(timeFromDrag(1500, 120)).toBe(2000);
    expect(timeFromDrag(3, -600)).toBe(1);
  });

  it("time keys: ±1 ms (Shift ±10), double/halve, ends", () => {
    expect(timeKey(150, "ArrowUp")).toBe(151);
    expect(timeKey(150, "ArrowLeft", true)).toBe(140);
    expect(timeKey(150, "PageUp")).toBe(300);
    expect(timeKey(150, "PageDown")).toBe(75);
    expect(timeKey(150, "Home")).toBe(1);
    expect(timeKey(150, "End")).toBe(2000);
    expect(timeKey(2000, "ArrowUp")).toBe(2000);
    expect(timeKey(150, "a")).toBeNull();
  });

  it("note values give whole ms at the tempo, and the current time is matched to one", () => {
    expect(noteMs(0.5, 120)).toBe(250);
    expect(noteMs(1 / 3, 120)).toBe(167);
    expect(noteMs(0.75, 90)).toBe(500);
    expect(matchingNote(250, 120)).toBe("1/8");
    expect(matchingNote(251, 120)).toBeNull();
  });

  it("read-outs and the minimized line (at most 16 characters, lowercase words, time first)", () => {
    expect(SUMMARY_CHARS).toBe(16);
    expect(delaySummary(delay())).toBe("150 ms · fb -6");
    expect(delaySummary(delay({ fb: 0, ms: 375 }))).toBe("375 ms · fb off");     // the loop is off: one echo
    expect(delaySummary(delay({ fb: 0, ms: 1500 }))).toBe("1500 ms · fb off");
    expect(delaySummary(delay({ fb: 1, mix: 0.5 }))).toBe("150 ms · fb ∞");       // 0 dB: never decays
    expect(delaySummary(delay({ mix: 0 }))).toBe("dry only");
    expect(delaySummary(delay({ fb: 0.9 }))).toBe("150 ms · fb -3");
    expect(delaySummary(delay({ fb: 23.5 / 30 }))).toBe("150 ms · fb -6.5");
    expect(delaySummary(delay({ ms: 1500 }))).toBe("1500 ms · fb -6");
    expect(delaySummary(delay({ ms: 2000, fb: 23.5 / 30 }))).toBe("2000 ms·fb -6.5");   // tight separator
    expect(delaySummary(delay({ ms: 5 }))).toBe("5 ms · fb -6 dB");                      // room for the unit
    expect(fmtFeedback(delayModel(delay({ fb: 0 }), 48000))).toBe("1 repeat");
    expect(tailText(delayModel(delay({ fb: 1 }), 48000))).toBe("∞ repeats, no decay");
  });

  it("no setting gives a summary longer than 16 characters", () => {
    let longest = "";
    for (const ms of [1, 5, 50, 150, 999, 1000, 1500, 2000, 3000, 10000]) for (let i = 0; i <= 60; i += 1) for (const mix of [0.01, 0.3, 1]) {
      const t = delaySummary(delay({ fb: i / 60, mix, ms }));
      if (t.length > longest.length) longest = t;
    }
    expect(longest.length).toBeLessThanOrEqual(SUMMARY_CHARS);
  });
});

describe("DelayPanel", () => {
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
    useStore.setState({ snapshot: { session: { sampleRate: 48000, tempo: 120 } } as unknown as Snapshot });
  });
  afterEach(() => {
    act(() => root.unmount());
    host.remove();
    useStore.setState({ snapshot: null as unknown as Snapshot });
  });

  const render = (plugin: Plugin) => {
    const props: PanelProps = { plugin, trackId: "t1", sampleRate: 48000, setParam, setState };
    act(() => root.render(React.createElement(delayPanelDef.Panel, props)));
  };
  const $ = (sel: string) => host.querySelector(sel)!;
  const key = (el: Element, k: string, shiftKey = false) =>
    act(() => { el.dispatchEvent(new KeyboardEvent("keydown", { key: k, shiftKey, bubbles: true })); });
  const Ptr = (typeof PointerEvent === "function" ? PointerEvent : MouseEvent) as typeof MouseEvent;
  /** The time read-out drags vertically, like a dial: `clientY` only. */
  const pointer = (el: Element, type: string, clientY: number) =>
    act(() => { el.dispatchEvent(new Ptr(type, { bubbles: true, clientY, button: 0 })); });

  it("draws the dry stem and the 9 echoes, with the decay in words", () => {
    render(delay());
    expect(host.querySelectorAll('[data-testid="pp-delay-tap"]')).toHaveLength(9);
    expect(host.querySelector('[data-testid="pp-delay-dry"]')).not.toBeNull();
    expect($('[data-testid="pp-delay-tail"]').textContent).toBe("-60 dB in 1.5 s");
    expect($('[data-testid="pp-delay-feedback"] .v').textContent).toBe("-6.0 dB");
    expect($('[data-testid="pp-delay-mix"] .v').textContent).toBe("30%");
    expect($('[data-testid="pp-delay-mix"] svg').getAttribute("aria-valuetext")).toMatch(/^30% wet: /);
    expect($('[data-testid="pp-delay-time"] .v').textContent).toBe("150 ms");
    expect($('[data-testid="pp-delay-time"]').getAttribute("aria-valuetext")).toBe("150 ms");
  });

  it("the tail read-out sits top-right, and drops to the bottom when a handle is under it", () => {
    render(delay());
    expect($('[data-testid="pp-delay-tail"]').getAttribute("y")).toBe("11");   // top 3 + 8
    // 2000 ms: the view is 4 s, so the second-echo handle (4000 ms, about -13 dB) sits at the
    // right edge under the top-right text.
    render(delay({ ms: 2000 }));
    const node = $('[data-testid="pp-delay-fb-node"]');
    expect(Number(/translate\(([\d.]+)/.exec(node.getAttribute("transform")!)![1])).toBeGreaterThan(260);
    expect($('[data-testid="pp-delay-tail"]').getAttribute("y")).toBe("42");     // bottom 45 − 3
  });

  it("warns at 0 dB feedback and marks a single echo at the bottom", () => {
    render(delay({ fb: 1 }));
    expect($('[data-testid="pp-delay-strip"]').classList.contains("inf")).toBe(true);
    expect($('[data-testid="pp-delay-tail"]').classList.contains("warn")).toBe(true);
    render(delay({ fb: 0 }));
    expect(host.querySelectorAll('[data-testid="pp-delay-tap"]')).toHaveLength(1);
    expect($('[data-testid="pp-delay-fb-node"]').classList.contains("hollow")).toBe(true);
  });

  it("a time drag previews without sending (the strip follows), then sends ONE set_plugin_state on release", () => {
    render(delay());
    const time = $('[data-testid="pp-delay-time"]');
    pointer(time, "pointerdown", 100);
    pointer(time, "pointermove", 70);    // up, past the 3 px dead zone; measured from 97
    pointer(time, "pointermove", 37);    // 60 px up past the threshold: doubled
    expect(setState).not.toHaveBeenCalled();
    expect(time.getAttribute("aria-valuetext")).toBe("300 ms");
    // The strip draws the previewed time: echoes every 300 ms, the first at x = tx(300) in
    // a view of (9 + 0.6) × 300 ms.
    expect($('[data-testid="pp-delay-strip"]').getAttribute("aria-label")).toContain("Echoes every 300 ms");
    const firstTap = host.querySelector('[data-testid="pp-delay-tap"]')!;
    expect(Number(firstTap.getAttribute("x1"))).toBeCloseTo(4 + (300 / 2880) * 265, 6);
    pointer(time, "pointerup", 37);
    expect(setState).toHaveBeenCalledTimes(1);
    expect(setState).toHaveBeenCalledWith("lengthMs", 300);
  });

  it("a time drag down halves it", () => {
    render(delay());
    const time = $('[data-testid="pp-delay-time"]');
    pointer(time, "pointerdown", 100);
    pointer(time, "pointermove", 110);
    pointer(time, "pointermove", 163);   // 60 px down past the threshold (103)
    pointer(time, "pointerup", 163);
    expect(setState).toHaveBeenCalledWith("lengthMs", 75);
  });

  it("a click, or a pixel of jitter, on the time sends nothing and previews nothing", () => {
    render(delay());
    const time = $('[data-testid="pp-delay-time"]');
    pointer(time, "pointerdown", 100);
    pointer(time, "pointerup", 100);
    pointer(time, "pointerdown", 100);
    pointer(time, "pointermove", 101);
    pointer(time, "pointermove", 102);
    expect(time.getAttribute("aria-valuetext")).toBe("150 ms");
    pointer(time, "pointerup", 102);
    expect(setState).not.toHaveBeenCalled();
  });

  it("a drag out and back sends nothing and then follows the engine again (undo, agent, peers)", () => {
    vi.useFakeTimers();
    try {
      render(delay());
      const time = $('[data-testid="pp-delay-time"]');
      pointer(time, "pointerdown", 100);
      pointer(time, "pointermove", 37);
      expect(time.getAttribute("aria-valuetext")).not.toBe("150 ms");
      pointer(time, "pointermove", 97);
      expect(time.getAttribute("aria-valuetext")).toBe("150 ms");
      pointer(time, "pointerup", 97);
      expect(setState).not.toHaveBeenCalled();
      render(delay({ ms: 400 }));   // e.g. an undo lands
      act(() => { vi.advanceTimersByTime(2000); });
      expect(time.getAttribute("aria-valuetext")).toBe("400 ms");
    } finally {
      vi.useRealTimers();
    }
  });

  it("time keys preview each step and send ONE set_plugin_state when the burst ends", () => {
    vi.useFakeTimers();
    try {
      render(delay());
      const time = $('[data-testid="pp-delay-time"]');
      for (let i = 0; i < 10; i += 1) key(time, "ArrowUp");
      expect(time.getAttribute("aria-valuetext")).toBe("160 ms");
      expect(setState).not.toHaveBeenCalled();
      act(() => { vi.advanceTimersByTime(399); });
      expect(setState).not.toHaveBeenCalled();
      act(() => { vi.advanceTimersByTime(1); });
      expect(setState).toHaveBeenCalledTimes(1);
      expect(setState).toHaveBeenCalledWith("lengthMs", 160);
      // The handle on the strip uses the same path; End reaches 2000 ms.
      setState.mockClear();
      act(() => { vi.advanceTimersByTime(1000); });
      key($('[data-testid="pp-delay-time-node"]'), "End");
      act(() => { vi.advanceTimersByTime(400); });
      expect(setState).toHaveBeenCalledTimes(1);
      expect(setState).toHaveBeenCalledWith("lengthMs", 2000);
    } finally {
      vi.useRealTimers();
    }
  });

  it("a key burst still pending is sent at once on blur", () => {
    vi.useFakeTimers();
    try {
      render(delay());
      const time = $('[data-testid="pp-delay-time"]') as HTMLElement;
      act(() => time.focus());
      key(time, "PageUp");
      act(() => time.blur());
      expect(setState).toHaveBeenCalledTimes(1);
      expect(setState).toHaveBeenCalledWith("lengthMs", 300);
      act(() => { vi.advanceTimersByTime(1000); });
      expect(setState).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("shows an engine time above 2000 ms as it is, and can still set 2000", () => {
    vi.useFakeTimers();
    try {
      const long = delay({ ms: 3000 });
      expect(delayModel(long, 48000).lengthMs).toBe(3000);
      expect(delaySummary(long)).toBe("3000 ms · fb -6");
      render(long);
      const time = $('[data-testid="pp-delay-time"]');
      expect(time.getAttribute("aria-valuetext")).toBe("3000 ms");
      key(time, "End");
      act(() => { vi.advanceTimersByTime(400); });
      expect(setState).toHaveBeenCalledWith("lengthMs", 2000);
    } finally {
      vi.useRealTimers();
    }
  });

  it("double-click defaults: Time 150 ms, Feedback -6 dB (0.8), Mix 30 %", () => {
    render(delay({ fb: 0.5, mix: 0.7, ms: 400 }));
    act(() => { $('[data-testid="pp-delay-time"]').dispatchEvent(new MouseEvent("dblclick", { bubbles: true })); });
    expect(setState).toHaveBeenCalledWith("lengthMs", 150);
    act(() => { $('[data-testid="pp-delay-feedback"] svg').dispatchEvent(new MouseEvent("dblclick", { bubbles: true })); });
    expect(setParam).toHaveBeenLastCalledWith(0, 0.8, { gesture: expect.any(String) });
    act(() => { $('[data-testid="pp-delay-mix"] svg').dispatchEvent(new MouseEvent("dblclick", { bubbles: true })); });
    expect(setParam).toHaveBeenLastCalledWith(1, 0.3, { gesture: expect.any(String) });
  });

  it("the second-echo handle steps feedback by 0.5 dB: -6.5 dB is 0.78333", () => {
    render(delay());
    key($('[data-testid="pp-delay-fb-node"]'), "ArrowDown");
    expect(setParam).toHaveBeenCalledTimes(1);
    expect(setParam.mock.calls[0][0]).toBe(0);
    expect(setParam.mock.calls[0][1]).toBeCloseTo(23.5 / 30, 9);
    expect(setParam.mock.calls[0][2]).toEqual({ gesture: expect.any(String) });
  });

  /** The strip's SVG is 273 × 48 px on screen, so client px = viewBox units. */
  const stubStrip = () => {
    const svg = $('[data-testid="pp-delay-strip"]') as SVGSVGElement;
    svg.getBoundingClientRect = () => ({ left: 0, top: 0, width: 273, height: 48, right: 273, bottom: 48, x: 0, y: 0, toJSON() {} }) as DOMRect;
  };
  const ptr = (el: Element, type: string, clientX: number, clientY: number) =>
    act(() => { el.dispatchEvent(new Ptr(type, { bubbles: true, clientX, clientY, button: 0 })); });
  /** The strip's dB → y (padT 3, 42 units for 60 dB). */
  const yOf = (dB: number) => 3 + (dB / -60) * 42;

  it("dragging the second-echo handle 6 dB down sets Feedback -12 dB (0.6), one gesture", () => {
    render(delay());
    stubStrip();
    const node = $('[data-testid="pp-delay-fb-node"]');
    const y0 = yOf(20 * Math.log10(Math.sin(0.3 * Math.PI / 2)) - 6);   // echo 2 at the default
    ptr(node, "pointerdown", 10, y0);
    ptr(node, "pointermove", 10, y0);
    ptr(node, "pointermove", 10, y0 + 2);
    ptr(node, "pointermove", 10, y0 + 4.2);   // 4.2 units = 6 dB lower
    ptr(node, "pointerup", 10, y0 + 4.2);
    expect(setParam).toHaveBeenCalled();
    const last = setParam.mock.calls[setParam.mock.calls.length - 1];
    expect(last[0]).toBe(0);
    expect(last[1]).toBeCloseTo(0.6, 6);
    expect(new Set(setParam.mock.calls.map((c) => c[2].gesture)).size).toBe(1);
  });

  it("a second-echo handle drawn clamped at the floor does not jump when grabbed", () => {
    // Mix 1 %: echo 1 at -36.1 dB; loop off, so echo 2 "would be" at -66 dB, drawn on -60.
    render(delay({ fb: 0, mix: 0.01 }));
    stubStrip();
    const node = $('[data-testid="pp-delay-fb-node"]');
    ptr(node, "pointerdown", 10, 45);
    ptr(node, "pointermove", 10, 45);
    ptr(node, "pointermove", 10, 44);   // 1 unit up = +60/42 dB from -30
    ptr(node, "pointerup", 10, 44);
    const last = setParam.mock.calls[setParam.mock.calls.length - 1];
    expect(last[1]).toBeCloseTo((60 / 42) / 30, 6);   // -28.57 dB, not -23.9 dB
  });

  it("dragging the first-echo handle previews, then sends ONE time on release", () => {
    render(delay());
    stubStrip();
    const node = $('[data-testid="pp-delay-time-node"]');
    const x0 = 4 + (150 / 1440) * 265;   // tx(150) in the default 1440 ms view (265 inner units)
    ptr(node, "pointerdown", x0, 10);
    ptr(node, "pointermove", x0, 10);
    ptr(node, "pointermove", x0 + 2, 10);   // inside the dead zone
    expect(host.querySelector('[data-testid="pp-delay-time"]')!.getAttribute("aria-valuetext")).toBe("150 ms");
    ptr(node, "pointermove", x0 + 30, 10);   // 27 units past the threshold, view held at 1440 ms
    expect(setState).not.toHaveBeenCalled();
    const want = Math.round(150 + (27 / 265) * 1440);
    expect(want).toBe(297);
    expect($('[data-testid="pp-delay-time"]').getAttribute("aria-valuetext")).toBe("297 ms");
    ptr(node, "pointerup", x0 + 30, 10);
    expect(setState).toHaveBeenCalledTimes(1);
    expect(setState).toHaveBeenCalledWith("lengthMs", 297);
  });

  it("End on the Feedback dial sends 1 (0 dB); Home on Mix sends 0", () => {
    render(delay());
    key($('[data-testid="pp-delay-feedback"] svg'), "End");
    expect(setParam).toHaveBeenLastCalledWith(0, 1, { gesture: expect.any(String) });
    key($('[data-testid="pp-delay-mix"] svg'), "Home");
    expect(setParam).toHaveBeenLastCalledWith(1, 0, { gesture: expect.any(String) });
  });

  it("sets the time from a note value at the session tempo, and shows the match", () => {
    render(delay());
    const sel = $('[data-testid="pp-delay-note"]') as HTMLSelectElement;
    expect(sel.value).toBe("");
    act(() => { sel.value = "1/8"; sel.dispatchEvent(new Event("change", { bubbles: true })); });
    expect(setState).toHaveBeenCalledWith("lengthMs", 250);
    render(delay({ ms: 250 }));
    expect(($('[data-testid="pp-delay-note"]') as HTMLSelectElement).value).toBe("1/8");
  });

  it("a bypassed delay greys its strip; the mini shows the echoes", () => {
    render(delay({ enabled: false }));
    expect($('[data-testid="pp-delay-strip"]').classList.contains("bypassed")).toBe(true);
    const props: PanelProps = { plugin: delay(), trackId: "t1", sampleRate: 48000, setParam, setState };
    act(() => root.render(React.createElement(delayPanelDef.Mini!, props)));
    expect(host.querySelectorAll('[data-testid="pp-delay-mini"] line:not(.dry)')).toHaveLength(9);
    expect(delayPanelDef.summary(delay())).toBe("150 ms · fb -6");
    // The mini fills the header's 44 × 14 thumbnail slot.
    expect($('[data-testid="pp-delay-mini"]').getAttribute("width")).toBe("44");
    expect($('[data-testid="pp-delay-mini"]').getAttribute("height")).toBe("14");
  });

  it("the note menu's placeholder reads as a prompt, not a value", () => {
    render(delay({ ms: 151 }));
    const sel = $('[data-testid="pp-delay-note"]') as HTMLSelectElement;
    expect(sel.value).toBe("");
    expect(sel.options[0].textContent).toBe("Note…");
    expect(sel.options[0].disabled).toBe(true);
  });

  it("an older engine (no plugin.state): Time is read-only, says why, and never sends set_plugin_state", () => {
    vi.useFakeTimers();
    try {
      render(delay({ legacy: true }));
      const time = $('[data-testid="pp-delay-time"]');
      expect(time.getAttribute("aria-disabled")).toBe("true");
      expect(time.getAttribute("tabindex")).toBe("-1");
      expect(time.getAttribute("aria-valuetext")).toBe("150 ms");   // the engine default
      expect($('[data-testid="pp-delay-legacy"]').textContent).toBe("needs the updated Mosh engine");
      expect(host.querySelectorAll('[data-testid="pp-delay-legacy"]')).toHaveLength(1);
      expect(host.querySelector('[data-testid="pp-delay-note"]')).toBeNull();
      expect(host.querySelector('[data-testid="pp-delay-time-node"]')).toBeNull();
      expect(host.querySelector('[data-testid="pp-delay-time-fixed"]')).not.toBeNull();
      pointer(time, "pointerdown", 100);
      pointer(time, "pointermove", 20);
      pointer(time, "pointerup", 20);
      key(time, "PageUp");
      act(() => { time.dispatchEvent(new MouseEvent("dblclick", { bubbles: true })); });
      act(() => { vi.advanceTimersByTime(2000); });
      expect(time.getAttribute("aria-valuetext")).toBe("150 ms");
      expect(setState).not.toHaveBeenCalled();
      // Feedback and Mix are parameters: they still work.
      key($('[data-testid="pp-delay-mix"] svg'), "Home");
      expect(setParam).toHaveBeenLastCalledWith(1, 0, { gesture: expect.any(String) });
    } finally {
      vi.useRealTimers();
    }
  });
});
