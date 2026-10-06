import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useStore } from "../../store";
import type { Plugin, Snapshot } from "../../types";
import {
  COMB_TAU_S, ONSET_S, dampCoefOf, dampingForHfRt60, decayEnd, decayGeometry, dryDb, feedbackOf, fmtSec, plotSpan,
  reverbModel, reverbSummary, rt60, sizeForRt60, wetDb,
} from "./reverb";
import { reverbPanelDef } from "./ReverbPanel";
import type { PanelProps } from "./types";

/** A reverb as the engine sends it: six 0-1 params, Freeze last (tracktion_Reverb.cpp:21-52). */
function reverb(values: number[] = [0.3, 0.5, 1 / 3, 0.5, 1, 0], enabled = true): Plugin {
  const names = ["Room Size", "Damping", "Wet Level", "Dry Level", "Width", "Freeze"];
  return {
    index: 2, name: "Reverb", type: "reverb", enabled, external: false, builtin: true, isInstrument: false,
    params: names.map((name, index) => ({ index, name, value: values[index] })),
  };
}

describe("reverb maths (juce::Reverb / FreeVerb)", () => {
  it("uses the engine's comb lengths: τ = 1378/44100 s, first reflection at 1116/44100 s", () => {
    expect(COMB_TAU_S).toBeCloseTo(0.0312472, 6);
    expect(ONSET_S * 1000).toBeCloseTo(25.306, 2);
  });

  it("low-frequency decay by Size matches the research's reference values", () => {
    const at = (size: number) => rt60(feedbackOf(size), dampCoefOf(0.5), 0, 48000);
    expect(at(0)).toBeCloseTo(0.6052, 3);
    expect(at(0.3)).toBeCloseTo(0.8870, 3);
    expect(at(0.5)).toBeCloseTo(1.2380, 3);
    expect(at(0.8)).toBeCloseTo(2.7308, 3);
    expect(at(1)).toBeCloseTo(10.684, 2);
  });

  it("damping shortens the highs per the one-pole loop filter, at the session rate", () => {
    const g = feedbackOf(0.3), d = dampCoefOf(0.5);
    expect(g).toBeCloseTo(0.784, 6);
    expect(d).toBeCloseTo(0.2, 6);
    expect(rt60(g, d, 500, 48000)).toBeCloseTo(0.8846, 3);
    expect(rt60(g, d, 8000, 48000)).toBeCloseTo(0.5690, 3);
    expect(rt60(g, d, 10000, 48000)).toBeCloseTo(0.4977, 3);
    expect(rt60(g, d, 24000, 48000)).toBeCloseTo(0.3327, 3);
    expect(rt60(g, d, 8000, 44100)).toBeCloseTo(0.5416, 3);   // same setting, lower rate: darker
    expect(rt60(g, 0, 8000, 48000)).toBeCloseTo(rt60(g, 0, 0, 48000), 9);   // no damping: flat
  });

  it("freeze is infinite (feedback 1, damping 0)", () => {
    expect(rt60(feedbackOf(0.3, true), dampCoefOf(0.5, true), 8000, 48000)).toBe(Infinity);
    const m = reverbModel(reverb([0.3, 0.5, 1 / 3, 0.5, 1, 0.5]), 48000);
    expect(m.frozen).toBe(true);           // the engine's threshold is >= 0.5
    expect(m.rtLow).toBe(Infinity);
    expect(m.rtLowSet).toBeCloseTo(0.887, 3);
    expect(reverbModel(reverb([0.3, 0.5, 1 / 3, 0.5, 1, 0.499]), 48000).frozen).toBe(false);
  });

  it("inverts decay time to Size and 8 kHz decay to Damping (clamped to what the engine reaches)", () => {
    expect(sizeForRt60(rt60(feedbackOf(0.42), 0, 0, 48000))).toBeCloseTo(0.42, 9);
    expect(sizeForRt60(0.1)).toBe(0);
    expect(sizeForRt60(100)).toBe(1);
    expect(dampingForHfRt60(0.5690, 0.3, 48000)).toBeCloseTo(0.5, 3);
    expect(dampingForHfRt60(5, 0.3, 48000)).toBe(0);
    expect(dampingForHfRt60(0.01, 0.3, 48000)).toBe(1);
  });

  it("Wet is 3v and Dry 2v as gains", () => {
    expect(wetDb(1 / 3)).toBeCloseTo(0, 9);
    expect(wetDb(1)).toBeCloseTo(9.542, 3);
    expect(dryDb(0.5)).toBeCloseTo(0, 9);
    expect(dryDb(1)).toBeCloseTo(6.021, 3);
    expect(wetDb(0)).toBe(-Infinity);
  });

  it("formats seconds compactly", () => {
    expect(fmtSec(0.887)).toBe("0.89 s");
    expect(fmtSec(2.7308)).toBe("2.7 s");
    expect(fmtSec(10.684)).toBe("11 s");
    expect(fmtSec(Infinity)).toBe("∞");
  });

  it("draws the LF tail ending at -60 dB inside a span of 1.25 × its decay, and clips a longer one", () => {
    const m = reverbModel(reverb(), 48000);
    const span = plotSpan(m.rtLowSet);
    expect(span).toBeCloseTo(1.10875, 4);
    const g = decayGeometry(m.rtLow, m.rtHigh, span);
    expect(g.low.x).toBeCloseTo(233.39, 1);
    expect(g.low.y).toBe(45);
    expect(g.high.x).toBeLessThan(g.low.x);   // highs die first
    // Size 1, no damping (10.7 s) in a held 0.5 s view: leaves the right edge near the top.
    const clipped = decayEnd(rt60(feedbackOf(1), 0, 0, 48000), 0.5);
    expect(clipped.x).toBe(283);
    expect(clipped.y).toBeCloseTo(4.866, 2);
  });

  it("summarises what it is doing in one line", () => {
    expect(reverbSummary(reverb())).toBe("~0.89 s · highs 0.57 s · wet 0.0 dB");
    expect(reverbSummary(reverb([0.3, 0.5, 1 / 3, 0.5, 1, 1]))).toBe("frozen ∞ · wet 0.0 dB");
    expect(reverbSummary(reverb([0.3, 0.5, 1 / 3, 0.25, 0.5, 0]))).toBe("~0.89 s · highs 0.57 s · wet 0.0 dB · dry -6.0 dB · 50% wide");
    expect(reverbSummary(reverb([0.8, 0, 0, 0.5, 1, 0]))).toBe("~2.7 s · highs 2.7 s · wet off");
  });

  it("the row's summary uses the session's sample rate", () => {
    useStore.setState({ snapshot: { session: { sampleRate: 44100 } } as unknown as Snapshot });
    expect(reverbPanelDef.summary(reverb())).toBe("~0.89 s · highs 0.54 s · wet 0.0 dB");
    useStore.setState({ snapshot: null as unknown as Snapshot });
  });
});

describe("ReverbPanel", () => {
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

  const render = (plugin: Plugin) => {
    const props: PanelProps = { plugin, trackId: "t1", sampleRate: 48000, setParam, setState };
    act(() => root.render(React.createElement(reverbPanelDef.Panel, props)));
  };
  const key = (el: Element, k: string) =>
    act(() => { el.dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true })); });
  const $ = (sel: string) => host.querySelector(sel)!;

  it("shows the computed decay and every control in real units", () => {
    render(reverb());
    expect($('[data-testid="pp-reverb-decay"]').textContent).toBe("~0.89 s");
    expect($('[data-testid="pp-reverb-size"] .v').textContent).toBe("~0.89 s");
    expect($('[data-testid="pp-reverb-damping"] .v').textContent).toBe("50%");
    expect($('[data-testid="pp-reverb-wet"] .v').textContent).toBe("0.0 dB");
    expect($('[data-testid="pp-reverb-dry"] .v').textContent).toBe("0.0 dB");
    expect($('[data-testid="pp-reverb-width"] .v').textContent).toBe("100%");
    expect($('[data-testid="pp-reverb-freeze"]').getAttribute("aria-pressed")).toBe("false");
    expect($('[data-testid="pp-reverb-plot"]').classList.contains("bypassed")).toBe(false);
  });

  it("End on the Size dial sends param 0 = 1 with a gesture id", () => {
    render(reverb());
    key($('[data-testid="pp-reverb-size"] svg'), "End");
    expect(setParam).toHaveBeenCalledTimes(1);
    expect(setParam).toHaveBeenCalledWith(0, 1, { gesture: expect.stringMatching(/^ui-/) });
  });

  it("Home on the Wet dial sends param 2 = 0", () => {
    render(reverb());
    key($('[data-testid="pp-reverb-wet"] svg'), "Home");
    expect(setParam).toHaveBeenCalledWith(2, 0, { gesture: expect.any(String) });
  });

  it("the Size handle on the plot nudges Size by 1 % per arrow key", () => {
    render(reverb());
    key($('[data-testid="pp-reverb-size-node"]'), "ArrowRight");
    expect(setParam).toHaveBeenCalledTimes(1);
    expect(setParam.mock.calls[0][0]).toBe(0);
    expect(setParam.mock.calls[0][1]).toBeCloseTo(0.31, 9);
    key($('[data-testid="pp-reverb-damp-node"]'), "End");
    expect(setParam).toHaveBeenLastCalledWith(1, 1, { gesture: expect.any(String) });
  });

  it("End on Damping, Dry and Width sends params 1, 3 and 4 = 1; double-click Wet returns to 1/3 (0 dB)", () => {
    render(reverb([0.3, 0.5, 0.8, 0.5, 1, 0]));
    key($('[data-testid="pp-reverb-damping"] svg'), "End");
    expect(setParam).toHaveBeenLastCalledWith(1, 1, { gesture: expect.any(String) });
    key($('[data-testid="pp-reverb-dry"] svg'), "End");
    expect(setParam).toHaveBeenLastCalledWith(3, 1, { gesture: expect.any(String) });
    key($('[data-testid="pp-reverb-width"] svg'), "Home");
    expect(setParam).toHaveBeenLastCalledWith(4, 0, { gesture: expect.any(String) });
    act(() => { $('[data-testid="pp-reverb-wet"] svg').dispatchEvent(new MouseEvent("dblclick", { bubbles: true })); });
    expect(setParam).toHaveBeenLastCalledWith(2, 1 / 3, { gesture: expect.any(String) });
    act(() => { $('[data-testid="pp-reverb-size"] svg').dispatchEvent(new MouseEvent("dblclick", { bubbles: true })); });
    expect(setParam).toHaveBeenLastCalledWith(0, 0.3, { gesture: expect.any(String) });
  });

  /** The plot's SVG is 286 × 48 px on screen, so client px = viewBox units. */
  const stubPlot = () => {
    const svg = $('[data-testid="pp-reverb-plot"]') as SVGSVGElement;
    svg.getBoundingClientRect = () => ({ left: 0, top: 0, width: 286, height: 48, right: 286, bottom: 48, x: 0, y: 0, toJSON() {} }) as DOMRect;
  };
  const Ptr = (typeof PointerEvent === "function" ? PointerEvent : MouseEvent) as typeof MouseEvent;
  const ptr = (el: Element, type: string, clientX: number, clientY = 20) =>
    act(() => { el.dispatchEvent(new Ptr(type, { bubbles: true, clientX, clientY, button: 0 })); });
  /** Time → x in the default view (span 1.25 × 0.887 s, held during the drag). */
  const span0 = plotSpan(rt60(feedbackOf(0.3), 0, 0, 48000));
  const xAt = (t: number) => 3 + (t / span0) * 280;

  it("dragging the Size handle to a 1.0 s decay sends the inverted Size (0.37806), one gesture", () => {
    render(reverb());
    stubPlot();
    const node = $('[data-testid="pp-reverb-size-node"]');
    ptr(node, "pointerdown", xAt(ONSET_S + 0.887));
    ptr(node, "pointermove", xAt(ONSET_S + 0.95));
    ptr(node, "pointermove", xAt(ONSET_S + 1.0));
    ptr(node, "pointerup", xAt(ONSET_S + 1.0));
    const last = setParam.mock.calls[setParam.mock.calls.length - 1];
    expect(last[0]).toBe(0);
    expect(last[1]).toBeCloseTo(0.378064, 5);
    expect(rt60(feedbackOf(last[1]), 0, 0, 48000)).toBeCloseTo(1.0, 6);
    expect(new Set(setParam.mock.calls.map((c) => c[2].gesture)).size).toBe(1);
  });

  it("dragging the Damping handle to a 0.4 s 8 kHz decay sends the solved Damping (0.86481)", () => {
    render(reverb());
    stubPlot();
    const node = $('[data-testid="pp-reverb-damp-node"]');
    // The handle sits halfway down the 8 kHz line, so its time is half that decay.
    ptr(node, "pointerdown", xAt(ONSET_S + 0.569 / 2));
    ptr(node, "pointermove", xAt(ONSET_S + 0.2));
    ptr(node, "pointerup", xAt(ONSET_S + 0.2));
    const last = setParam.mock.calls[setParam.mock.calls.length - 1];
    expect(last[0]).toBe(1);
    expect(last[1]).toBeCloseTo(0.864813, 5);
    expect(rt60(feedbackOf(0.3), dampCoefOf(last[1]), 8000, 48000)).toBeCloseTo(0.4, 6);
  });

  it("Freeze writes only 0 or 1, reading the engine's >= 0.5 threshold", () => {
    render(reverb());
    act(() => ($('[data-testid="pp-reverb-freeze"]') as HTMLButtonElement).click());
    expect(setParam).toHaveBeenLastCalledWith(5, 1);
    render(reverb([0.3, 0.5, 1 / 3, 0.5, 1, 0.5]));
    act(() => ($('[data-testid="pp-reverb-freeze"]') as HTMLButtonElement).click());
    expect(setParam).toHaveBeenLastCalledWith(5, 0);
  });

  it("frozen: a flat tail, no Size/Damping handles, Size and Damping marked as held", () => {
    render(reverb([0.3, 0.5, 1 / 3, 0.5, 1, 1]));
    expect(host.querySelector('[data-testid="pp-reverb-frozen"]')).not.toBeNull();
    expect(host.querySelector('[data-testid="pp-reverb-size-node"]')).toBeNull();
    expect(host.querySelectorAll(".pp-reverb-held")).toHaveLength(2);
    // The sliders themselves say so (the title is only on a wrapper).
    expect($('[data-testid="pp-reverb-size"] svg').getAttribute("aria-valuetext")).toMatch(/, no effect while Freeze is on$/);
    expect($('[data-testid="pp-reverb-damping"] svg').getAttribute("aria-valuetext")).toMatch(/, no effect while Freeze is on$/);
    expect($('[data-testid="pp-reverb-freeze"]').getAttribute("aria-pressed")).toBe("true");
  });

  it("a bypassed reverb draws its plot greyed", () => {
    render(reverb(undefined, false));
    expect($('[data-testid="pp-reverb-plot"]').classList.contains("bypassed")).toBe(true);
  });

  it("the mini wedge: closed through the corner past 4 s, flat when frozen", () => {
    const props = (plugin: Plugin): PanelProps => ({ plugin, trackId: "t1", sampleRate: 48000, setParam, setState });
    act(() => root.render(React.createElement(reverbPanelDef.Mini!, props(reverb()))));
    expect($('[data-testid="pp-reverb-mini"] path').getAttribute("d")).toMatch(/^M0 0 L8\.\d 12\.0 L5\.\d 12\.0 Z$/);
    // Size 0.9: low decay 4.39 s leaves the right edge at y = 12·4/4.39; the highs (1.17 s)
    // reach the floor at x = 10.5. The wedge must include the bottom-right corner.
    act(() => root.render(React.createElement(reverbPanelDef.Mini!, props(reverb([0.9, 0.5, 1 / 3, 0.5, 1, 0])))));
    expect($('[data-testid="pp-reverb-mini"] path').getAttribute("d")).toBe("M0 0 L36.0 10.9 L36 12 L10.5 12.0 Z");
    act(() => root.render(React.createElement(reverbPanelDef.Mini!, props(reverb([0.3, 0.5, 1 / 3, 0.5, 1, 1])))));
    expect($('[data-testid="pp-reverb-mini"] path').getAttribute("d")).toBe("M0 0.5 L36 0.5 L36 12 L0 12 Z");
  });
});
