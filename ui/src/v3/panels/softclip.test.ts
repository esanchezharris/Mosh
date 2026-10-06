import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useStore } from "../../store";
import type { Plugin } from "../../types";
import {
  CEILING, CLIP_ZONE_FROM_KNEE_DB, clipGrDb, clipHint, clipOutDb, clipSettings, clipSummary, DRIVE, fmtDbfs, kneeInDb, kneeTo,
} from "./softclip";
import { softClipPanelDef } from "./SoftClipPanel";
import { normOf } from "./params";

/** A soft clipper as the engine sends it (min/max on both params). */
function clip(driveDb = 6, ceilDb = -0.5, enabled = true): Plugin {
  return {
    index: 0, name: "Mosh Soft Clipper", type: "softclip", enabled, external: false, builtin: true, isInstrument: false,
    params: [
      { index: 0, name: "Drive", value: normOf(undefined, driveDb, DRIVE), ...DRIVE },
      { index: 1, name: "Ceiling", value: normOf(undefined, ceilDb, CEILING), ...CEILING },
    ],
  } as Plugin;
}

describe("the curve is y = c·tanh(g·x/c), in dB", () => {
  it("pins the research numbers at the defaults (drive 6, ceiling -0.5)", () => {
    expect(kneeInDb(6, -0.5)).toBe(-6.5);
    expect(clipOutDb(0, 6, -0.5)).toBeCloseTo(-0.7536, 3);
    expect(clipGrDb(0, 6, -0.5)).toBeCloseTo(6.7536, 3);
  });
  it("sits 2.37 dB under the ceiling at the knee; 6.34 dB of reduction at u = 2", () => {
    expect(clipOutDb(-6.5, 6, -0.5)).toBeCloseTo(-0.5 - 2.3655, 3);
    expect(clipGrDb(-6.5, 6, -0.5)).toBeCloseTo(2.3655, 3);
    expect(clipGrDb(-6.5 + 20 * Math.log10(2), 6, -0.5)).toBeCloseTo(6.34, 2);
  });
  it("is drive dB louder for quiet input and never reaches the ceiling", () => {
    expect(clipOutDb(-60, 6, -0.5)).toBeCloseTo(-54, 2);
    expect(clipOutDb(-60, 18, -3)).toBeCloseTo(-42, 2);
    // u = 4.2 here; much further in, tanh rounds to exactly 1 in floating point.
    expect(clipOutDb(0, 12, -0.5)).toBeLessThan(-0.5);
    expect(clipOutDb(0, 12, -0.5)).toBeCloseTo(-0.5 + 20 * Math.log10(Math.tanh(10 ** (12.5 / 20))), 9);
    expect(clipOutDb(0, 12, -0.5)).toBeGreaterThan(-0.51);
    // Even drive 0 / ceiling 0 is not transparent at full scale (plain tanh).
    expect(clipOutDb(0, 0, 0)).toBeCloseTo(-2.3655, 3);
  });
  it("reduction is 0 for quiet input, continuous through the series branch, and monotonic", () => {
    expect(clipGrDb(-120, 0, 0)).toBeCloseTo(0, 9);
    const a = clipGrDb(-80.01, 0, 0), b = clipGrDb(-79.99, 0, 0);   // either side of u = 1e-4
    expect(Math.abs(a - b)).toBeLessThan(1e-6);
    let prev = -1;
    for (let x = -40; x <= 6; x += 0.5) { const g = clipGrDb(x, 6, -0.5); expect(g).toBeGreaterThan(prev); prev = g; }
  });
  it("starts the shaded zone where ~1 dB of reduction begins, 4.2 dB under the knee", () => {
    expect(CLIP_ZONE_FROM_KNEE_DB).toBeCloseTo(-4.22, 1);
    expect(clipGrDb(-6.5 + CLIP_ZONE_FROM_KNEE_DB, 6, -0.5)).toBeCloseTo(1, 3);
  });
});

describe("settings and read-outs", () => {
  it("reads drive and ceiling linearly from the snapshot", () => {
    expect(clipSettings(clip(9, -3))).toEqual({ driveDb: 9, ceilDb: -3 });
    const noRange = { ...clip(), params: [{ index: 0, name: "Drive", value: 0.25 }, { index: 1, name: "Ceiling", value: 23 / 24 }] } as Plugin;
    expect(clipSettings(noRange).driveDb).toBeCloseTo(6, 9);
    expect(clipSettings(noRange).ceilDb).toBeCloseTo(-0.5, 9);
  });
  it("puts the knee where asked: height = ceiling, drive = ceiling - knee input, ceiling clamped first", () => {
    expect(kneeTo(-6.5, -0.5)).toEqual({ driveDb: 6, ceilDb: -0.5 });
    expect(kneeTo(-12, -3)).toEqual({ driveDb: 9, ceilDb: -3 });
    expect(kneeTo(-6.5, 0)).toEqual({ driveDb: 6.5, ceilDb: 0 });
    // Above the top: the ceiling stops at 0 and the drive follows the ceiling it got.
    expect(kneeTo(-6.5, 0.5)).toEqual({ driveDb: 6.5, ceilDb: 0 });
    expect(kneeTo(-40, -1)).toEqual({ driveDb: 24, ceilDb: -1 });
    expect(kneeTo(3, -1)).toEqual({ driveDb: 0, ceilDb: -1 });
    expect(kneeTo(-6.54321, -0.46)).toEqual({ driveDb: 6, ceilDb: -0.5 });
  });
  it("summarises in one short line and says the honest hint", () => {
    expect(clipSummary(clip())).toBe("drive +6.0 dB · ceiling -0.5 dBFS");
    expect(clipSummary(clip(0, 0))).toBe("drive 0.0 dB · ceiling 0.0 dBFS");
    expect(clipHint({ driveDb: 6, ceilDb: -0.5 })).toBe("knee -6.5 dBFS · quiet input +6.0 dB");
    expect(fmtDbfs(-0.01)).toBe("0.0 dBFS");
  });
});

describe("SoftClipPanel", () => {
  let host: HTMLDivElement;
  let root: Root;
  const setParam = vi.fn();
  const render = (plugin: Plugin, which: "Panel" | "Mini" = "Panel") => {
    const C = softClipPanelDef[which]!;
    act(() => root.render(React.createElement(C, { plugin, trackId: "t1", sampleRate: 48000, setParam, setState: vi.fn() })));
  };
  const q = (id: string) => host.querySelector(`[data-testid="${id}"]`);
  const key = (el: Element, k: string) => act(() => { el.dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true })); });
  const frame = (o: Partial<{ grDb: number; inDb: number; outDb: number; type: string }> = {}) =>
    act(() => useStore.setState({
      pluginMeters: { "t1:0": { trackId: "t1", index: 0, type: "softclip", grDb: 2.4, inDb: -3, outDb: clipOutDb(-3, 6, -0.5), ...o } as never },
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
  /** A manual animation-frame queue, so each pointer move of a drag really sends. */
  const manualFrames = () => {
    const frames: FrameRequestCallback[] = [];
    vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => frames.push(cb));
    vi.stubGlobal("cancelAnimationFrame", () => {});
    return () => act(() => { frames.splice(0).forEach((cb) => cb(0)); });
  };
  const xOf = (db: number) => ((db + 36) / 42) * 150, yOf = (db: number) => (-db / 36) * 84;
  const dragKnee = () => {
    const svg = q("pp-softclip-plot") as unknown as SVGSVGElement;
    svg.getBoundingClientRect = () => ({ left: 0, top: 0, width: 150, height: 84, right: 150, bottom: 84, x: 0, y: 0, toJSON: () => ({}) });
    const node = q("pp-softclip-knee")!;
    return (type: string, inDb: number, outDb: number) => act(() => {
      node.dispatchEvent(new PointerEvent(type, { bubbles: true, clientX: xOf(inDb), clientY: yOf(outDb), button: 0, pointerId: 1 }));
    });
  };

  it("draws the exact tanh curve on a -36..+6 / -36..0 plot", () => {
    render(clip());
    const d = q("pp-softclip-curve")!.getAttribute("d")!;
    // The first sample is -36 dBFS in → just under -30 dBFS out (drive is gain): y ≈ 70.
    const out36 = clipOutDb(-36, 6, -0.5);
    expect(out36).toBeCloseTo(-30, 2);
    expect(d.startsWith(`M0.00 ${((-out36 / 36) * 84).toFixed(2)}`)).toBe(true);
    // The last sample is +6 dBFS in.
    const out6 = clipOutDb(6, 6, -0.5);
    expect(d.endsWith(`L150.00 ${((-out6 / 36) * 84).toFixed(2)}`)).toBe(true);
    expect(q("pp-softclip-hint")!.textContent).toBe("knee -6.5 dBFS · quiet input +6.0 dB");
  });

  it("End on Drive sends 1 (24 dB); Home on Ceiling sends 0 (-12 dBFS)", () => {
    render(clip());
    key(q("pp-softclip-drive")!.querySelector('[role="slider"]')!, "End");
    expect(setParam).toHaveBeenLastCalledWith(0, 1, { gesture: expect.any(String) });
    key(q("pp-softclip-ceiling")!.querySelector('[role="slider"]')!, "Home");
    expect(setParam).toHaveBeenLastCalledWith(1, 0, { gesture: expect.any(String) });
    expect(q("pp-softclip-drive")!.textContent).toContain("+6.0 dB");
    expect(q("pp-softclip-ceiling")!.textContent).toContain("-0.5 dBFS");
  });

  it("the knee's keys move it like a drag: Up raises it straight up, Right lowers the drive, one gesture for both", () => {
    render(clip());
    const node = q("pp-softclip-knee")!;
    expect(node.getAttribute("aria-valuetext")).toBe("knee -6.5 dBFS, drive +6.0 dB, ceiling -0.5 dBFS");
    // Up 0.5: ceiling -0.5 → 0, knee input stays at -6.5, so drive 6 → 6.5.
    key(node, "ArrowUp");
    expect(setParam.mock.calls).toEqual([
      [0, 6.5 / 24, { gesture: expect.any(String) }],
      [1, 1, { gesture: expect.any(String) }],
    ]);
    expect(setParam.mock.calls[0][2].gesture).toBe(setParam.mock.calls[1][2].gesture);
    setParam.mockClear();
    key(node, "ArrowRight");
    expect(setParam.mock.calls[0][0]).toBe(0);
    expect(setParam.mock.calls[0][1]).toBeCloseTo(5.5 / 24, 9);
  });

  it("dragging the knee sets drive and ceiling from where it lands; every move of one drag shares one gesture", () => {
    const flush = manualFrames();
    render(clip());
    const ev = dragKnee();
    ev("pointerdown", -6.5, -0.5);
    ev("pointermove", -9, -2);    // knee at -9 in, ceiling -2 → drive 7
    flush();
    ev("pointermove", -12, -3);   // knee at -12 in, ceiling -3 → drive 9
    flush();
    ev("pointerup", -12, -3);
    const calls = setParam.mock.calls;
    expect(calls.map((c) => c[0])).toEqual([0, 1, 0, 1]);
    expect(calls[0][1]).toBeCloseTo(7 / 24, 9);
    expect(calls[1][1]).toBeCloseTo(10 / 12, 9);
    expect(calls[2][1]).toBeCloseTo(9 / 24, 9);
    expect(calls[3][1]).toBeCloseTo(9 / 12, 9);
    const first = calls[0][2].gesture;
    for (const c of calls) expect(c[2].gesture).toBe(first);
    // A second drag is a second undo step.
    setParam.mockClear();
    ev("pointerdown", -12, -3);
    ev("pointermove", -10, -3);
    flush();
    ev("pointerup", -10, -3);
    expect(setParam.mock.calls).toHaveLength(2);
    expect(setParam.mock.calls[0][2].gesture).not.toBe(first);
  });

  it("a straight-up drag and the Up key send the same pair", () => {
    const flush = manualFrames();
    render(clip());
    const ev = dragKnee();
    ev("pointerdown", -6.5, -0.5);
    ev("pointermove", -6.5, 0);
    flush();
    ev("pointerup", -6.5, 0);
    const dragged = setParam.mock.calls.map((c) => [c[0], c[1]]);
    setParam.mockClear();
    key(q("pp-softclip-knee")!, "ArrowUp");
    const keyed = setParam.mock.calls.map((c) => [c[0], c[1]]);
    expect(dragged).toHaveLength(2);
    expect(dragged[0][1]).toBeCloseTo(keyed[0][1] as number, 9);
    expect(dragged[1][1]).toBeCloseTo(keyed[1][1] as number, 9);
    expect(keyed).toEqual([[0, 6.5 / 24], [1, 1]]);
  });

  it("the dot and clipping bar are idle without a frame and live with one", () => {
    render(clip());
    expect(q("pp-softclip-dot")).toBeNull();
    expect(q("pp-softclip-gr")!.getAttribute("data-level")).toBe("idle");
    expect(q("pp-softclip-gr-num")!.textContent).toBe("–");
    frame();
    const dot = q("pp-softclip-dot")!;
    expect(Number(dot.getAttribute("cx"))).toBeCloseTo((33 / 42) * 150, 1);
    expect(Number(dot.getAttribute("cy"))).toBeCloseTo((-clipOutDb(-3, 6, -0.5) / 36) * 84, 1);
    expect(q("pp-softclip-gr-num")!.textContent).toBe("2.4");
    expect(q("pp-softclip-gr")!.getAttribute("data-level")).toBe("mid");
    frame({ grDb: 7.5, inDb: 9, outDb: -0.6 });
    expect(q("pp-softclip-dot")).toBeNull();
    expect(q("pp-softclip-over")).not.toBeNull();
    expect(q("pp-softclip-gr")!.getAttribute("data-level")).toBe("hot");
    frame({ type: "compressor" });
    expect(q("pp-softclip-gr")!.getAttribute("data-live")).toBeNull();
  });

  it("the minimized bar is idle without a frame and fills with one", () => {
    render(clip(), "Mini");
    expect(host.querySelector(".pp-bar")!.classList.contains("idle")).toBe(true);
    frame({ grDb: 3 });
    expect(q("pp-softclip-mini")!.hasAttribute("data-live")).toBe(true);
    expect((host.querySelector(".pp-bar .fill") as HTMLElement).style.width).toBe("25%");
  });
});
