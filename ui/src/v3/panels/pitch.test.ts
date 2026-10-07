import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  SUMMARY_CHARS, fmtRatioX, fmtSemitones, intervalName, pitchLatencyMs, pitchSummary, pitchValueText, semitoneNorm, semitonesOf,
  snapSemitones,
} from "./pitch";
import { MINI_H, MINI_PX_PER_ST, MINI_W, pitchKeyTarget, pitchShifterPanelDef, pitchWheelTarget } from "./PitchPanel";
import type { Plugin } from "../../types";

/** As the engine (and the mock) send it: one param, linear on -24..+24. */
function shifter(semis = 0, extra: Record<string, unknown> = {}): Plugin {
  return {
    index: 0, name: "Pitch Shifter", type: "pitchShifter", enabled: true, builtin: true,
    params: [{ index: 0, name: "Semitones", value: (semis + 24) / 48, min: -24, max: 24, ...extra }],
  } as unknown as Plugin;
}

describe("pitch maths (tracktion_PitchShift.cpp)", () => {
  it("semitones = -24 + 48·v; +7 st is v = 31/48", () => {
    expect(semitoneNorm(shifter(), 7)).toBeCloseTo(31 / 48, 12);
    expect(semitoneNorm(shifter(), 0)).toBe(0.5);
    expect(semitoneNorm(shifter(), -30)).toBe(0);
    expect(semitonesOf(shifter(-12))).toBeCloseTo(-12, 9);
    // No min/max sent (older engines): the documented ±24 range.
    const bare = { ...shifter(), params: [{ index: 0, name: "Semitones", value: 31 / 48 }] } as unknown as Plugin;
    expect(semitonesOf(bare)).toBeCloseTo(7, 9);
  });
  it("names the interval and the ratio", () => {
    expect(intervalName(7)).toBe("perfect 5th up");
    expect(intervalName(-12)).toBe("octave down");
    expect(intervalName(24)).toBe("2 octaves up");
    expect(intervalName(19)).toBe("octave + perfect 5th up");
    expect(intervalName(-5)).toBe("perfect 4th down");
    expect(intervalName(6)).toBe("tritone up");
    expect(intervalName(0.3)).toBe("detuned up");
    expect(intervalName(0)).toBe("original pitch");
    expect(fmtRatioX(7)).toBe("×1.498");
    expect(fmtRatioX(-12)).toBe("×0.500");
    expect(fmtRatioX(0)).toBe("×1.000");
  });
  it("read-outs in semitones and cents", () => {
    expect(fmtSemitones(7)).toBe("+7 st");
    expect(fmtSemitones(-12)).toBe("-12 st");
    expect(fmtSemitones(0)).toBe("0 st");
    expect(fmtSemitones(7.2)).toBe("+7 st +20¢");
    expect(fmtSemitones(-0.3)).toBe("0 st -30¢");
    expect(fmtSemitones(6.999999)).toBe("+7 st");       // float noise never reads "+7.00"
    expect(pitchValueText(1)).toBe("+1 semitone, minor 2nd up");
    expect(pitchValueText(-7)).toBe("-7 semitones, perfect 5th down");
    expect(pitchValueText(0)).toBe("0 semitones, original pitch");
  });
  it("half semitones round away from zero both ways, so the read-out and the interval agree", () => {
    expect(fmtSemitones(-6.5)).toBe("-7 st +50¢");
    expect(intervalName(-6.5)).toBe("perfect 5th down");
    expect(fmtSemitones(6.5)).toBe("+7 st -50¢");
    expect(intervalName(6.5)).toBe("perfect 5th up");
    expect(fmtSemitones(-0.5)).toBe("-1 st +50¢");
    expect(intervalName(-0.5)).toBe("minor 2nd down");
    expect(pitchSummary(shifter(-6.5))).toBe("-7 st +50¢ · 5th");
  });
  it("snaps to whole semitones, or whole cents when fine", () => {
    expect(snapSemitones(7.04)).toBe(7);
    expect(snapSemitones(7.04, true)).toBe(7.04);
    expect(snapSemitones(7.0449, true)).toBe(7.04);
  });
  it("SoundTouch latency: 8192 samples", () => {
    expect(pitchLatencyMs(48000)).toBeCloseTo(170.67, 2);
    expect(pitchLatencyMs(44100)).toBeCloseTo(185.76, 2);
  });
  it("summary: the setting first, then the interval as long as it fits the minimized row's 16 characters", () => {
    expect(SUMMARY_CHARS).toBe(16);
    expect(pitchSummary(shifter(0))).toBe("original pitch");
    expect(pitchSummary(shifter(7))).toBe("+7 st · 5th");
    expect(pitchSummary(shifter(-12))).toBe("-12 st · octave");
    expect(pitchSummary(shifter(4))).toBe("+4 st · maj 3rd");   // "major 3rd" would be 17
    expect(pitchSummary(shifter(-3))).toBe("-3 st · min 3rd");
    expect(pitchSummary(shifter(-24))).toBe("-24 st");             // "2 octaves" does not fit
    expect(pitchSummary(shifter(11))).toBe("+11 st · maj 7th");
    expect(pitchSummary(shifter(6))).toBe("+6 st · tritone");
    expect(pitchSummary(shifter(19))).toBe("+19 st");               // "octave + 5th" does not fit
    expect(pitchSummary(shifter(7.2))).toBe("+7 st +20¢ · 5th");
    expect(pitchSummary(shifter(0.2))).toBe("0 st +20¢");            // a detune: no interval
    // Every whole semitone and a cent offset on each: never past the budget, never a
    // single-letter abbreviation.
    for (let semis = -24; semis <= 24; semis++) for (const c of [0, 0.01, -0.01, 0.37, -0.5]) {
      const line = pitchSummary(shifter(Math.max(-24, Math.min(24, semis + c))));
      expect(line.length).toBeLessThanOrEqual(SUMMARY_CHARS);
      expect(line).not.toMatch(/\b[A-Z]\b/);
    }
  });
  it("keys: a semitone, Alt 0.1, Shift and PageUp/Down an octave; Home/End left to the dial", () => {
    const k = (key: string, mods: { altKey?: boolean; shiftKey?: boolean } = {}) =>
      pitchKeyTarget({ key, altKey: !!mods.altKey, shiftKey: !!mods.shiftKey }, 7);
    expect(k("ArrowUp")).toBe(8);
    expect(k("ArrowLeft")).toBe(6);
    expect(k("ArrowUp", { altKey: true })).toBeCloseTo(7.1, 9);
    expect(k("ArrowDown", { shiftKey: true })).toBe(-5);
    expect(k("PageUp")).toBe(19);
    expect(k("Home")).toBeNull();
    // From a fractional setting, an arrow goes to the NEXT whole semitone, not ±1 then snap.
    const from = (key: string, st: number) => pitchKeyTarget({ key, altKey: false, shiftKey: false }, st);
    expect(from("ArrowDown", 7.2)).toBe(7);
    expect(from("ArrowUp", 7.2)).toBe(8);
    expect(from("ArrowUp", 7.6)).toBe(8);
    expect(from("ArrowDown", -0.5)).toBe(-1);
    expect(from("PageDown", 7.2)).toBe(-5);
    // The wheel: whole semitones per notch, the same way.
    expect(pitchWheelTarget(7.2, -1, false)).toBe(7);
    expect(pitchWheelTarget(7.2, 2, false)).toBe(9);
    expect(pitchWheelTarget(7, 1, true)).toBeCloseTo(7.1, 9);
  });
});

describe("PitchPanel", () => {
  let host: HTMLDivElement;
  let root: Root;
  const setParam = vi.fn();
  const setState = vi.fn();

  beforeEach(() => {
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    setParam.mockReset();
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
  });
  afterEach(() => {
    act(() => root.unmount());
    host.remove();
  });

  const render = (plugin: Plugin, sampleRate = 48000) =>
    act(() => root.render(React.createElement(pitchShifterPanelDef.Panel, { plugin, trackId: "t1", sampleRate, setParam, setState })));
  const dial = () => host.querySelector<SVGSVGElement>('[data-testid="v3-pitch-dial"] svg')!;
  const key = (k: string, mods: KeyboardEventInit = {}) =>
    act(() => { dial().dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true, ...mods })); });
  const text = (id: string) => host.querySelector(`[data-testid="${id}"]`)!.textContent;

  it("shows the setting big, with the interval, ratio and latency", () => {
    render(shifter(7));
    expect(text("v3-pitch-st")).toBe("+7 st");
    expect(text("v3-pitch-interval")).toBe("perfect 5th up · ×1.498");
    expect(text("v3-pitch-latency")).toBe("Latency 171 ms");
    // Numbers in mono, words in the caption face.
    expect(host.querySelector('[data-testid="v3-pitch-interval"] .num')!.textContent).toBe("×1.498");
    expect(host.querySelector('[data-testid="v3-pitch-chip-7"]')!.classList.contains("pp-btn")).toBe(true);
    expect(dial().getAttribute("aria-valuetext")).toBe("+7 semitones, perfect 5th up");
    expect(host.querySelector('[data-testid="v3-pitch-chip-7"]')!.getAttribute("aria-pressed")).toBe("true");
    expect(host.querySelector('[data-testid="v3-pitch-chip-0"]')!.getAttribute("aria-pressed")).toBe("false");
    expect(host.querySelector('[data-testid="v3-pitch-automated"]')).toBeNull();
    render(shifter(7, { automated: true }));
    expect(host.querySelector('[data-testid="v3-pitch-automated"]')).not.toBeNull();
  });

  it("an arrow key moves exactly one semitone (not 1% of the range); Alt moves 10 cents", () => {
    render(shifter(0));
    key("ArrowUp");
    expect(setParam).toHaveBeenCalledTimes(1);
    expect(setParam).toHaveBeenLastCalledWith(0, 25 / 48, { gesture: expect.any(String) });
    expect(text("v3-pitch-st")).toBe("+1 st");          // shown at once, before the patch
    key("ArrowUp", { altKey: true });                  // steps from the shown +1, not the stale 0
    expect(setParam).toHaveBeenCalledTimes(2);
    expect(setParam.mock.calls[1][1]).toBeCloseTo(25.1 / 48, 12);
    // One burst of keys is one undo step.
    expect(setParam.mock.calls[0][2].gesture).toBe(setParam.mock.calls[1][2].gesture);
  });

  it("the wheel moves a whole semitone per notch (not per event), Alt (from the Dial's modifier keys) 10 cents, and never scrolls the inspector", () => {
    render(shifter(0));
    const svg = dial();
    // A trackpad flick: 30 events of 5 px are 150 px, one 100 px notch (the Dial's), not 30 semitones.
    const evs = Array.from({ length: 30 }, () => new WheelEvent("wheel", { bubbles: true, cancelable: true, deltaY: -5 }));
    act(() => { for (const e of evs) svg.dispatchEvent(e); });
    expect(evs.every((e) => e.defaultPrevented)).toBe(true);
    expect(setParam).toHaveBeenCalledTimes(1);
    expect(setParam.mock.calls[0][1]).toBeCloseTo(25 / 48, 12);
    // A mouse click-stop (100 px) is one more; Alt makes it 10 cents.
    act(() => { svg.dispatchEvent(new WheelEvent("wheel", { bubbles: true, cancelable: true, deltaY: -50 })); });   // 150 + 50 = 2 notches
    expect(text("v3-pitch-st")).toBe("+2 st");
    act(() => { svg.dispatchEvent(new WheelEvent("wheel", { bubbles: true, cancelable: true, deltaY: -100, altKey: true })); });
    expect(text("v3-pitch-st")).toBe("+2 st +10¢");
    expect(setParam.mock.calls.at(-1)![1]).toBeCloseTo(26.1 / 48, 12);
  });

  it("ArrowDown from +7 st +20¢ lands on +7, and nothing is sent past an end", () => {
    render(shifter(7.2));
    key("ArrowDown");
    expect(setParam.mock.calls.at(-1)![1]).toBeCloseTo(31 / 48, 12);
    setParam.mockReset();
    act(() => root.unmount());                         // a fresh mount: the +7 is still shown
    root = createRoot(host);
    render(shifter(24));
    key("ArrowUp");
    expect(setParam).not.toHaveBeenCalled();
  });

  it("End and Home reach the ends; double-click returns to the original pitch", () => {
    render(shifter(3));
    key("End");
    key("Home");
    act(() => { dial().dispatchEvent(new MouseEvent("dblclick", { bubbles: true })); });
    expect(setParam.mock.calls.map((c) => c[1])).toEqual([1, 0, 0.5]);
  });

  it("a drag snaps to whole semitones; Alt-drag keeps cents; one gesture per drag", () => {
    render(shifter(0));
    const svg = dial();
    act(() => {
      svg.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, clientY: 100, pointerId: 1 }));
      svg.dispatchEvent(new PointerEvent("pointermove", { bubbles: true, clientY: 78, pointerId: 1 }));   // +22/150 → +7.04 st
      svg.dispatchEvent(new PointerEvent("pointerup", { bubbles: true, clientY: 78, pointerId: 1 }));
    });
    expect(setParam.mock.calls.at(-1)![1]).toBeCloseTo(31 / 48, 12);
    expect(new Set(setParam.mock.calls.map((c) => c[2].gesture)).size).toBe(1);

    // A fresh mount (the first drag's value is still shown while its patch is "in flight").
    setParam.mockReset();
    act(() => root.unmount());
    root = createRoot(host);
    render(shifter(0));
    const svg2 = dial();
    act(() => {
      svg2.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, clientY: 100, pointerId: 2, altKey: true }));
      svg2.dispatchEvent(new PointerEvent("pointermove", { bubbles: true, clientY: 78, pointerId: 2, altKey: true }));
      svg2.dispatchEvent(new PointerEvent("pointerup", { bubbles: true, clientY: 78, pointerId: 2, altKey: true }));
    });
    expect(setParam.mock.calls.at(-1)![1]).toBeCloseTo(31.04 / 48, 12);
  });

  it("a chip sets that interval in one command", () => {
    render(shifter(0));
    act(() => { host.querySelector<HTMLButtonElement>('[data-testid="v3-pitch-chip--7"]')!.click(); });
    expect(setParam).toHaveBeenCalledTimes(1);
    expect(setParam).toHaveBeenCalledWith(0, 17 / 48);
    expect(text("v3-pitch-st")).toBe("-7 st");
    expect(host.querySelector('[data-testid="v3-pitch-chip--7"]')!.getAttribute("aria-pressed")).toBe("true");
  });
  it("minimized: the full name is kept; the thumbnail is a 44×14 bipolar bar from the centre", () => {
    // "Pitch Shifter" measures 69 px at the name column's 11 px semibold: it fits the 76 px.
    expect(pitchShifterPanelDef.shortTitle).toBeUndefined();
    const renderMini = (plugin: Plugin) =>
      act(() => root.render(React.createElement(pitchShifterPanelDef.Mini!, { plugin, trackId: "t1", sampleRate: 48000, setParam, setState })));
    renderMini(shifter(7));
    const svg = host.querySelector('[data-testid="v3-pitch-mini"]')!;
    expect([MINI_W, MINI_H]).toEqual([44, 14]);
    expect([svg.getAttribute("width"), svg.getAttribute("height"), svg.getAttribute("viewBox")]).toEqual(["44", "14", "0 0 44 14"]);
    const bar = () => { const b = host.querySelector('[data-testid="v3-pitch-mini-bar"]'); return b && [Number(b.getAttribute("x")), Number(b.getAttribute("width"))]; };
    // ±24 st across ±21 px from the centre (x 22): +7 grows right, 7 × 0.875 px.
    expect(MINI_PX_PER_ST).toBe(0.875);
    expect(bar()![0]).toBe(22);
    expect(bar()![1]).toBeCloseTo(6.125, 9);
    renderMini(shifter(-24));
    expect(bar()![0]).toBeCloseTo(1, 9);                 // the left end, inside the box
    expect(bar()![1]).toBeCloseTo(21, 9);
    // The octave ticks sit where ±12 st lands.
    const ticks = [...host.querySelectorAll('[data-testid="v3-pitch-mini"] .oct')].map((t) => Number(t.getAttribute("x1")));
    expect(ticks).toEqual([22 - 10.5, 22 + 10.5]);
    renderMini(shifter(0));
    expect(bar()).toBeNull();                            // the original pitch: empty
    renderMini({ ...shifter(5), enabled: false });
    expect(host.querySelector('[data-testid="v3-pitch-mini"]')!.classList.contains("bypassed")).toBe(true);
  });
});
