import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { builtinPlugin } from "../../mock/builtins";
import { useStore } from "../../store";
import type { FeedbackMeter, Plugin, Snapshot } from "../../types";
import { xFeedbackPanelDef } from "./XFeedbackPanel";
import {
  fmtRingHz, juceRoundToInt, xfAppliedDb, xfAutoOn, xfBlend, xfCurveFreqs, xfCutChip, xfCutsDb, xfCutsNorm, xfMaxCuts,
  XF_STRIP, XF_SUMMARY_CHARS, xfMeterOf, xfNotch, xfSettings, xfStatus, xfSummary, xfThreshold, xfTopHz, xfVisibleChips,
} from "./xfeedback";
import type { PanelProps } from "./types";

/** A native-default Mosh X-FDBK, with overrides as normalised values by param index. */
function xf(norms: Record<number, number> = {}, enabled = true): Plugin {
  const p = builtinPlugin("moshXFeedback", 0)!;
  return { ...p, enabled, params: p.params.map((q) => (q.index in norms ? { ...q, value: norms[q.index] } : q)) };
}
const frame = (candidates: FeedbackMeter["candidates"], cuts: FeedbackMeter["cuts"]): FeedbackMeter =>
  ({ trackId: "t1", index: 0, type: "moshXFeedback", candidates, cuts });

describe("Mosh X-FDBK maths (MoshXFeedbackDsp.cpp)", () => {
  it("maps Sensitivity to the detector threshold 0.06 + 0.36·(1 − s)", () => {
    expect(xfThreshold(0.65)).toBeCloseTo(0.186, 9);
    expect(xfThreshold(0)).toBeCloseTo(0.42, 9);
    expect(xfThreshold(1)).toBeCloseTo(0.06, 9);
  });

  it("rounds Max Cuts like the engine and sends n as (n − 1)/3", () => {
    expect(xfMaxCuts(1.49)).toBe(1);
    expect(xfMaxCuts(1.51)).toBe(2);
    expect(xfMaxCuts(3.6)).toBe(4);
    // JUCE roundToInt rounds an exact .5 to even (the 1.5·2^52 trick): norm 0.5 → 2.5 → 2 cuts
    expect(xfMaxCuts(2.5)).toBe(2);
    expect(xfMaxCuts(3.5)).toBe(4);
    expect(xfMaxCuts(1.5)).toBe(2);
    expect([0.5, 1.5, 2.5, -0.5, 2.4999].map(juceRoundToInt)).toEqual([0, 2, 2, 0, 2]);
    expect(xfSettings(xf({ 1: 0.5 })).maxCuts).toBe(2);
    expect([1, 2, 3, 4].map(xfCutsNorm)).toEqual([0, 1 / 3, 2 / 3, 1]);
    expect(xfCutsNorm(0)).toBe(0);
    expect(xfCutsNorm(9)).toBe(1);
    expect(xfAutoOn(0.5)).toBe(true);
    expect(xfAutoOn(0.49)).toBe(false);
  });

  it("reads native defaults (Auto Suppress off, 2 cuts, 18 dB, 500 ms)", () => {
    expect(xfSettings(xf())).toEqual({
      sensitivity: expect.closeTo(0.65, 9), maxCuts: 2, maxDepth: expect.closeTo(18, 9), release: expect.closeTo(500, 9),
      auto: false, mix: 1, output: expect.closeTo(0, 9),
    });
  });

  it("draws the Q = 30 notch: exactly -depth at the centre, 0 dB far away", () => {
    const n = xfNotch(1000, 48000);
    const w0 = 2 * Math.PI * 1000 / 48000, alpha = Math.sin(w0) / 60;
    expect(n.b0).toBeCloseTo(1 / (1 + alpha), 12);
    expect(n.a2).toBeCloseTo((1 - alpha) / (1 + alpha), 12);
    const cut = [{ hz: 1260, depthDb: 12.7 }];
    expect(xfCutsDb(1260, cut, 1, 48000)).toBeCloseTo(-12.7, 6);
    expect(Math.abs(xfCutsDb(300, cut, 1, 48000))).toBeLessThan(0.05);
    // Mix scales the blend: m = (1 − 10^(−12.7/20))·0.5 → 20·log10(1 − m) = -4.21 dB at the centre
    expect(xfBlend(12.7, 0.5)).toBeCloseTo(0.5 * (1 - 10 ** (-12.7 / 20)), 12);
    expect(xfCutsDb(1260, cut, 0.5, 48000)).toBeCloseTo(-4.211, 2);
    // two cuts in series: each centre still reads its own depth
    const two = [{ hz: 1260, depthDb: 12.7 }, { hz: 5000, depthDb: 6 }];
    expect(xfCutsDb(1260, two, 1, 48000)).toBeCloseTo(-12.7, 1);
    expect(xfCutsDb(5000, two, 1, 48000)).toBeCloseTo(-6, 1);
    // narrow: one percent off the centre the cut is already mostly gone
    expect(xfCutsDb(1260 * 1.05, cut, 1, 48000)).toBeGreaterThan(-1);
  });

  it("samples the curve through each notch centre and caps the band at 0.48·fs", () => {
    const fs = xfCurveFreqs([{ hz: 1260 }], 250, 10000);
    expect(fs).toContain(1260);
    expect(fs[0]).toBe(250);
    expect(fs[fs.length - 1]).toBeCloseTo(10000, 6);
    expect(fs.every((f, i) => i === 0 || f >= fs[i - 1])).toBe(true);
    expect(xfTopHz(48000)).toBe(10000);
    expect(xfTopHz(16000)).toBeCloseTo(7680, 6);
  });

  it("reports a cut at the depth actually applied at Mix (the curve's own centre)", () => {
    expect(xfAppliedDb(12.7, 1)).toBeCloseTo(-12.7, 9);
    expect(xfAppliedDb(12.7, 0.5)).toBeCloseTo(xfCutsDb(1260, [{ hz: 1260, depthDb: 12.7 }], 0.5, 48000), 6);
    expect(xfAppliedDb(12.7, 0)).toBe(0);
    expect(xfCutChip({ hz: 1260, depthDb: 12.7 }, 0.5)).toBe("1.26 kHz -4.2 dB");
    expect(xfCutChip({ hz: 1260, depthDb: 12.7 }, 0)).toBe("1.26 kHz 0.0 dB");
    expect(xfStatus(frame([], [{ hz: 1260, score: 0.6, depthDb: 12.7 }]), true, true, 0.5).chips).toEqual(["1.26 kHz -4.2 dB"]);
  });

  it("folds chips past the line's width into +N, and accepts only its own frames", () => {
    expect(xfVisibleChips(["a", "b"], 2)).toEqual({ shown: ["a", "b"], more: null, rest: [] });
    expect(xfVisibleChips(["a", "b", "c", "d"], 2)).toEqual({ shown: ["a", "b"], more: "+2", rest: ["c", "d"] });
    const own = frame([], []);
    expect(xfMeterOf(own)).toBe(own);
    expect(xfMeterOf({ trackId: "t1", index: 0, type: "compressor", grDb: 3, inDb: -6, outDb: -9 })).toBeUndefined();
    expect(xfMeterOf({ ...own, itemId: "a" }, "b")).toBeUndefined();
    expect(xfMeterOf({ trackId: "t1", index: 0, type: "moshXFeedback" } as unknown as FeedbackMeter)).toBeUndefined();
  });

  it("writes chips, status and summary", () => {
    expect(xfCutChip({ hz: 1260, depthDb: 12.7 })).toBe("1.26 kHz -12.7 dB");
    expect(fmtRingHz(850)).toBe("850 Hz");
    expect(xfStatus(undefined, true, true)).toEqual({ kind: "idle", text: "no signal", chips: [] });
    expect(xfStatus(frame([], []), false, true).kind).toBe("bypassed");
    expect(xfStatus(frame([], []), true, true)).toEqual({ kind: "quiet", text: "nothing ringing", chips: [] });
    expect(xfStatus(frame([{ hz: 2610, score: 0.4 }], []), true, false))
      .toEqual({ kind: "ringing", text: "would cut", chips: ["2.61 kHz"] });
    expect(xfStatus(frame([{ hz: 1260, score: 0.6 }], [{ hz: 1260, score: 0.6, depthDb: 12.7 }]), true, true))
      .toEqual({ kind: "cutting", text: "cutting", chips: ["1.26 kHz -12.7 dB"] });

    // the minimized row fits 16 characters: the mode's own facts first, whole
    expect(xfSummary(xf())).toBe("detect sens 65%");
    expect(xfSummary(xf({ 0: 1 }))).toBe("detect sens 100%");
    expect(xfSummary(xf({ 0: 0, 6: 0.5 }))).toBe("detect sens 0%");   // Output does not fit whole
    expect(xfSummary(xf({ 4: 1 }))).toBe("≤2 cuts · ≤18 dB");
    expect(xfSummary(xf({ 4: 1, 1: 0, 5: 0.5, 6: 0.5 }))).toBe("≤1 cut · ≤18 dB");
    expect(xfSummary(xf({ 4: 1, 2: 0 }))).toBe("≤2 cuts · ≤3 dB");
    // every corner of every setting stays within the budget, and never ends cut mid-fact
    for (const auto of [0, 1]) for (const sens of [0, 0.65, 1]) for (const cuts of [0, 1]) for (const depth of [0, 1])
      for (const mix of [0, 0.5, 1]) for (const out of [0, 0.75, 1]) {
        const t = xfSummary(xf({ 4: auto, 0: sens, 1: cuts, 2: depth, 5: mix, 6: out }));
        expect(t.length, t).toBeLessThanOrEqual(XF_SUMMARY_CHARS);
        expect(t).toMatch(auto ? /^≤[14] cuts? · ≤(3|36) dB/ : /^detect/);
      }
    expect(XF_SUMMARY_CHARS).toBe(16);
  });
});

describe("Mosh X-FDBK panel", () => {
  let host: HTMLDivElement;
  let root: Root;
  let setParam: ReturnType<typeof vi.fn>;

  const render = (plugin: Plugin, which: "Panel" | "Mini" = "Panel") => {
    const props: PanelProps = { plugin, trackId: "t1", sampleRate: 48000, setParam: setParam as PanelProps["setParam"], setState: vi.fn() };
    const C = which === "Panel" ? xFeedbackPanelDef.Panel : xFeedbackPanelDef.Mini!;
    act(() => root.render(React.createElement(C, props)));
  };
  const q = (id: string) => host.querySelector(`[data-testid="${id}"]`)!;
  const qa = (id: string) => [...host.querySelectorAll(`[data-testid="${id}"]`)];
  const key = (el: Element, k: string) => act(() => { el.dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true })); });
  const send = (m: FeedbackMeter) => act(() => useStore.setState({ pluginMeters: { "t1:0": m } }));

  beforeEach(() => {
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    setParam = vi.fn();
    useStore.setState({ pluginMeters: {}, snapshot: null });
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
  });
  afterEach(() => {
    act(() => root.unmount());
    host.remove();
    useStore.setState({ pluginMeters: {}, snapshot: null });
  });

  it("says 'no signal' with no frame, with the threshold line where Sensitivity puts it", () => {
    render(xf());
    expect(q("v3-xf-strip").hasAttribute("data-live")).toBe(false);
    expect(q("v3-xf-status").textContent).toBe("no signal");
    expect(q("v3-xf-status").getAttribute("data-kind")).toBe("idle");
    expect(host.textContent).not.toMatch(/listening|thr 0/);
    expect(qa("v3-xf-candidate")).toHaveLength(0);
    // the strip is 273 × 38 (1:1 with its drawn px at the 320 px inspector), its top 13 px the
    // status lane: 0.186 on a 0..0.75 axis 25 tall below it, y = 13 + (0.75 − 0.186)/0.75·25
    expect(XF_STRIP).toEqual({ w: 273, h: 38, lane: 13 });
    expect(q("v3-xf-strip").getAttribute("viewBox")).toBe("0 0 273 38");
    expect(Number(q("v3-xf-threshold").getAttribute("y1"))).toBeCloseTo(31.8, 6);
    // the threshold the line marks is in Sensitivity's read-out and tooltip, not its own row
    expect(q("v3-xf-sensitivity").getAttribute("title")).toContain("0.19");
  });

  it("draws candidates, notches and chips from a frame", () => {
    render(xf({ 4: 1 }));
    send(frame([{ hz: 1260, score: 0.6 }, { hz: 2510, score: 0.3 }],
      [{ hz: 1260, score: 0.6, depthDb: 12.7 }, { hz: 2510, score: 0.3, depthDb: 5.4 }]));
    expect(q("v3-xf-strip").hasAttribute("data-live")).toBe(true);
    expect(qa("v3-xf-candidate")).toHaveLength(2);
    expect(q("v3-xf-status").getAttribute("data-kind")).toBe("cutting");
    expect(qa("v3-xf-chip").map((c) => c.textContent)).toEqual(["1.26 kHz -12.7 dB", "2.51 kHz -5.4 dB"]);
    // the notch curve reaches the real depth: 12.7 of 30 dB of the 25 px band below the lane,
    // and hangs from the band's top (never up into the status lane)
    const ys = [...q("v3-xf-cutcurve").getAttribute("d")!.matchAll(/[ML][\d.]+ ([\d.]+)/g)].map((m) => Number(m[1]));
    expect(Math.max(...ys)).toBeCloseTo(13 + (12.7 / 30) * 25, 1);
    expect(Math.min(...ys)).toBeGreaterThanOrEqual(13);
    // a candidate's stem tops out at its score, below the lane: 13 + (0.75 − 0.6)/0.75·25
    const cap = qa("v3-xf-candidate")[0].querySelector("circle")!;
    expect(Number(cap.getAttribute("cy"))).toBeCloseTo(18, 6);
    // even a score past the axis stops at the lane's edge, under the status text
    send(frame([{ hz: 1260, score: 0.9 }], []));
    expect(Number(qa("v3-xf-candidate")[0].querySelector("circle")!.getAttribute("cy"))).toBe(13);
  });

  it("draws candidates as stems, never as notches: 'would cut' in Detect mode with no notch curve", () => {
    render(xf());
    send(frame([{ hz: 2610, score: 0.4 }], []));
    expect(q("v3-xf-status").textContent).toBe("would cut2.61 kHz");
    expect(host.querySelector('[data-testid="v3-xf-cutcurve"]')).toBeNull();
    expect(qa("v3-xf-candidate")[0].classList.contains("would")).toBe(true);
  });

  it("shows the applied depth at Mix and folds a third and fourth cut into +N", () => {
    render(xf({ 4: 1, 5: 0.5 }));
    const cuts = [
      { hz: 1260, score: 0.6, depthDb: 12.7 }, { hz: 2510, score: 0.5, depthDb: 9 },
      { hz: 3980, score: 0.4, depthDb: 7.2 }, { hz: 6300, score: 0.3, depthDb: 5.4 },
    ];
    send(frame(cuts.map(({ hz, score }) => ({ hz, score })), cuts));
    expect(qa("v3-xf-chip").map((c) => c.textContent)).toEqual(["1.26 kHz -4.2 dB", "2.51 kHz -3.4 dB"]);
    expect(q("v3-xf-chip-more").textContent).toBe("+2");
    expect(q("v3-xf-chip-more").getAttribute("title")).toBe("3.98 kHz -2.9 dB, 6.30 kHz -2.3 dB");
    // the curve's deepest point agrees with the first chip: 4.21 of 30 dB of the 25 px band
    const ys = [...q("v3-xf-cutcurve").getAttribute("d")!.matchAll(/[ML][\d.]+ ([\d.]+)/g)].map((m) => Number(m[1]));
    expect(Math.max(...ys)).toBeCloseTo(13 + (4.211 / 30) * 25, 1);
  });

  it("never crashes on another plugin's frame at its key (delete/reorder while playing)", () => {
    act(() => useStore.setState({ pluginMeters: { "t1:0": { trackId: "t1", index: 0, type: "compressor", grDb: 6, inDb: -3, outDb: -9 } } }));
    render(xf({ 4: 1 }), "Mini");
    expect(q("v3-xf-mini").classList.contains("idle")).toBe(true);
    render(xf({ 4: 1 }));
    expect(q("v3-xf-strip").hasAttribute("data-live")).toBe(false);
    expect(q("v3-xf-status").textContent).toBe("no signal");
  });

  it("Detect | Suppress follows the radio keyboard model; the stepper keeps focus at its limits", () => {
    render(xf());
    expect(q("v3-xf-detect").getAttribute("tabindex")).toBe("0");
    expect(q("v3-xf-suppress").getAttribute("tabindex")).toBe("-1");
    (q("v3-xf-detect") as HTMLButtonElement).focus();
    key(q("v3-xf-detect"), "ArrowRight");
    expect(setParam).toHaveBeenLastCalledWith(4, 1);
    expect(document.activeElement).toBe(q("v3-xf-suppress"));
    setParam.mockClear();
    key(q("v3-xf-detect"), "Home");                // already Detect: nothing sent
    expect(setParam).not.toHaveBeenCalled();
    // the arrows and Home/End stay in the switch: they must not also nudge clips or move the playhead
    const seen: string[] = [];
    const onKey = (e: KeyboardEvent) => seen.push(e.key);
    window.addEventListener("keydown", onKey);
    try {
      key(q("v3-xf-suppress"), "ArrowLeft");
      key(q("v3-xf-detect"), "End");
    } finally {
      window.removeEventListener("keydown", onKey);
    }
    expect(seen).toEqual([]);
    setParam.mockClear();

    render(xf({ 1: 1 }));                          // 4 cuts
    const more = host.querySelector('[aria-label="More cuts"]') as HTMLButtonElement;
    expect(more.disabled).toBe(false);
    expect(more.getAttribute("aria-disabled")).toBe("true");
    more.focus();
    act(() => more.click());
    expect(setParam).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(more);
  });

  it("toggles Auto Suppress with 0 or 1, and steps Max Cuts by (n − 1)/3", () => {
    render(xf());
    expect(q("v3-xf-detect").getAttribute("aria-checked")).toBe("true");
    act(() => (q("v3-xf-detect") as HTMLButtonElement).click());
    expect(setParam).not.toHaveBeenCalled();
    act(() => (q("v3-xf-suppress") as HTMLButtonElement).click());
    expect(setParam).toHaveBeenLastCalledWith(4, 1);
    render(xf({ 4: 1 }));
    act(() => (q("v3-xf-detect") as HTMLButtonElement).click());
    expect(setParam).toHaveBeenLastCalledWith(4, 0);

    expect(q("v3-xf-cuts").textContent).toBe("2 cuts");
    act(() => (host.querySelector('[aria-label="More cuts"]') as HTMLButtonElement).click());
    expect(setParam).toHaveBeenLastCalledWith(1, 2 / 3);
    key(q("v3-xf-cuts"), "End");
    expect(setParam).toHaveBeenLastCalledWith(1, 1);
    key(q("v3-xf-cuts"), "ArrowDown");
    expect(setParam).toHaveBeenLastCalledWith(1, 0);
  });

  it("sends each dial's normalised value and moves the threshold with Sensitivity", () => {
    render(xf());
    const slider = (id: string) => host.querySelector(`[data-testid="${id}"] [role="slider"]`)!;
    key(slider("v3-xf-sensitivity"), "End");
    expect(setParam).toHaveBeenLastCalledWith(0, 1, { gesture: expect.any(String) });
    // the line follows before the engine's patch lands: threshold 0.06 → y = 13 + 0.69/0.75·25
    expect(Number(q("v3-xf-threshold").getAttribute("y1"))).toBeCloseTo(36, 6);
    key(slider("v3-xf-depth"), "Home");
    expect(setParam).toHaveBeenLastCalledWith(2, 0, { gesture: expect.any(String) });
    key(slider("v3-xf-release"), "End");
    expect(setParam).toHaveBeenLastCalledWith(3, 1, { gesture: expect.any(String) });
    key(slider("v3-xf-output"), "ArrowDown");
    expect(setParam.mock.lastCall![0]).toBe(6);
    expect(setParam.mock.lastCall![1]).toBeCloseTo(0.74, 9);
    expect(slider("v3-xf-depth").getAttribute("aria-valuetext")).toBe("18.0 dB");
    expect(slider("v3-xf-release").getAttribute("aria-valuetext")).toBe("500 ms");
  });

  it("warns when the buffer is too small to detect", () => {
    useStore.setState({ snapshot: { audio: { bufferSize: 64 } } as unknown as Snapshot });
    render(xf());
    expect(q("v3-xf-buffer-note").textContent).toContain("now 64");
    act(() => useStore.setState({ snapshot: { audio: { bufferSize: 256 } } as unknown as Snapshot }));
    expect(host.querySelector('[data-testid="v3-xf-buffer-note"]')).toBeNull();
  });

  it("minimized strip is idle when bypassed even with a held frame, live otherwise", () => {
    send(frame([{ hz: 1260, score: 0.6 }], [{ hz: 1260, score: 0.6, depthDb: 12 }]));
    render(xf({}, false), "Mini");
    expect(q("v3-xf-mini").classList.contains("idle")).toBe(true);
    render(xf({}, true), "Mini");
    expect(q("v3-xf-mini").classList.contains("idle")).toBe(false);
    expect(q("v3-xf-mini").querySelectorAll("line.cand, line.cut")).toHaveLength(2);
    expect(Number(q("v3-xf-mini-cut").getAttribute("y2"))).toBeCloseTo(7 + (12 / 30) * 7, 6);
    // at Mix 0.5 the tick shows the applied depth, not the pre-Mix depth
    render(xf({ 5: 0.5 }, true), "Mini");
    expect(Number(q("v3-xf-mini-cut").getAttribute("y2"))).toBeCloseTo(7 + (-xfAppliedDb(12, 0.5) / 30) * 7, 6);
    // it fits the minimized row's 44×14 slot
    expect([q("v3-xf-mini").getAttribute("width"), q("v3-xf-mini").getAttribute("height")]).toEqual(["44", "14"]);
  });

  it("marks the suppression dials inert (still adjustable) in Detect, and draws Output from unity", () => {
    render(xf());
    const inert = (id: string) => q(id).classList.contains("inert");
    expect(["v3-xf-depth", "v3-xf-release", "v3-xf-mix"].map(inert)).toEqual([true, true, true]);
    expect(["v3-xf-sensitivity", "v3-xf-output"].map(inert)).toEqual([false, false]);
    expect(q("v3-xf-depth").getAttribute("title")).toContain("no effect in Detect");
    expect(host.querySelector('[data-testid="v3-xf-depth"] [role="slider"]')!.getAttribute("tabindex")).toBe("0");
    key(host.querySelector('[data-testid="v3-xf-mix"] [role="slider"]')!, "Home");
    expect(setParam).toHaveBeenLastCalledWith(5, 0, { gesture: expect.any(String) });
    render(xf({ 4: 1 }));
    expect(["v3-xf-depth", "v3-xf-release", "v3-xf-mix"].map(inert)).toEqual([false, false, false]);
    // Output 0 dB (the default): a unity tick and no arc
    expect(q("v3-xf-output").querySelector("line.unity")).not.toBeNull();
    expect(q("v3-xf-output").querySelector("path.value")!.getAttribute("d")).toBe("");
    // the pressed mode uses the shared switch (aria-checked), not a filled button
    expect(q("v3-xf-suppress").closest(".pp-seg")).not.toBeNull();
    expect(xFeedbackPanelDef.title).toBe("Feedback Suppressor");
    // the minimized name column holds about 11 characters at 11 px semibold
    expect(xFeedbackPanelDef.shortTitle).toBe("Feedback");
  });
});
