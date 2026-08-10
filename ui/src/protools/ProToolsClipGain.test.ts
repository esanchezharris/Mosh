import React, { act, useRef } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useStore } from "../store";
import type { CommandResult, Snapshot } from "../types";
import { ProToolsTimeline } from "./ProToolsTimeline";
import { useProTools } from "./proToolsState";

const waveProbe = vi.hoisted(() => ({
  renders: [] as Array<{ amplitudeAt?: (ratio: number) => number }>,
}));

vi.mock("../bridge", async () => {
  const actual = await vi.importActual<typeof import("../bridge")>("../bridge");
  return { ...actual, onEvent: vi.fn(() => () => {}), pickFiles: vi.fn(), pickSaveFile: vi.fn() };
});

vi.mock("../ui/clipRenderers", async () => {
  const actual = await vi.importActual<typeof import("../ui/clipRenderers")>("../ui/clipRenderers");
  return {
    ...actual,
    ClipWave: (props: { amplitudeAt?: (ratio: number) => number }) => {
      waveProbe.renders.push(props);
      return React.createElement("canvas");
    },
  };
});

const CLIP_ID = "audio-clip";
const SNAPSHOT: Snapshot = {
  schemaVersion: 1,
  session: {
    sampleRate: 48_000,
    tempo: 120,
    editFile: "/tmp/protools-inline-gain.mosh",
    key: { tonic: "C", mode: "major" },
  },
  tracks: [{
    id: "audio-track",
    index: 0,
    name: "Lead Vocal",
    type: "audio",
    clips: [{
      id: CLIP_ID,
      name: "Verse Take",
      type: "wave",
      start: 2,
      length: 4,
      offset: 0,
      gainDb: -6,
      hasRenderLayer: false,
    }],
  }],
  transport: { playing: false, recording: false, position: 0, looping: false, loopStart: 0, loopEnd: 0 },
};

function Harness({ snapshot = SNAPSHOT }: { readonly snapshot?: Snapshot }) {
  const scrollRef = useRef<HTMLDivElement>(null);
  return React.createElement(ProToolsTimeline, {
    snapshot,
    contentWidth: 800,
    scrollRef,
    onScroll: () => {},
    onSpotClip: () => {},
  });
}

describe("Pro Tools inline clip gain", () => {
  let host: HTMLDivElement;
  let root: Root;
  let exec: ReturnType<typeof vi.fn>;
  const originalState = useStore.getState();

  const slider = () => {
    const control = host.querySelector<HTMLElement>('[role="slider"][data-testid="pt-clip-gain-handle"]');
    if (!control) throw new Error("inline clip gain handle did not render");
    return control;
  };

  const pointer = (element: HTMLElement, type: string, init: PointerEventInit) => {
    act(() => element.dispatchEvent(new PointerEvent(type, { bubbles: true, ...init })));
  };

  const renderWithPoints = (points: NonNullable<Snapshot["tracks"][number]["clips"][number]["clipGainPoints"]>) => {
    const snapshot: Snapshot = {
      ...SNAPSHOT,
      tracks: [{
        ...SNAPSHOT.tracks[0],
        clips: [{ ...SNAPSHOT.tracks[0].clips[0], clipGainPoints: points }],
      }],
    };
    act(() => root.render(React.createElement(Harness, { snapshot })));
  };

  const setEnvelopeRect = () => {
    const envelope = host.querySelector<SVGSVGElement>("[data-testid=pt-clip-gain-envelope]");
    if (!envelope) throw new Error("dynamic clip gain envelope did not render");
    vi.spyOn(envelope, "getBoundingClientRect").mockReturnValue({
      x: 0, y: 0, left: 0, top: 0, right: 400, bottom: 100,
      width: 400, height: 100, toJSON: () => ({}),
    });
    return envelope;
  };

  const waveAmplitudeAt = () => {
    const amplitudeAt = waveProbe.renders.at(-1)?.amplitudeAt;
    if (!amplitudeAt) throw new Error("Pro Tools did not supply envelope-aware waveform scaling");
    return amplitudeAt;
  };

  beforeEach(() => {
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
    exec = vi.fn(async (command: string): Promise<CommandResult> => ({ ok: true, command }));
    waveProbe.renders.length = 0;
    useStore.setState({
      snapshot: SNAPSHOT,
      transport: SNAPSHOT.transport,
      selection: new Set([CLIP_ID]),
      pxPerSec: 100,
      projectEpoch: 80,
      peaks: { [CLIP_ID]: [[-0.5, 0.5]] },
      ensurePeaks: vi.fn(),
      exec,
    });
    useProTools.setState({
      smartToolEnabled: true,
      activeTool: "selector",
      nudgeValue: 0.25,
      audioWaveformZoom: 1,
    });
    act(() => root.render(React.createElement(Harness)));
  });

  afterEach(() => {
    act(() => root.unmount());
    host.remove();
    useStore.setState({
      snapshot: originalState.snapshot,
      transport: originalState.transport,
      selection: originalState.selection,
      pxPerSec: originalState.pxPerSec,
      projectEpoch: originalState.projectEpoch,
      peaks: originalState.peaks,
      ensurePeaks: originalState.ensurePeaks,
      exec: originalState.exec,
    });
    vi.restoreAllMocks();
  });

  it("shows the selected clip value and supplies static waveform amplitude", () => {
    // Given: a selected audio clip whose static gain is -6 dB.
    const control = slider();
    const stack = host.querySelector<HTMLElement>("[data-testid=pt-audio-clip-stack]");
    const line = host.querySelector<HTMLElement>("[data-testid=pt-clip-gain-line]");
    if (!stack || !line) throw new Error("inline gain feedback did not render");

    // When: the timeline paints the clip from the snapshot.
    const scale = waveAmplitudeAt()(0.5);

    // Then: assistive value text, the gain line, and the dB amplitude transform agree.
    expect(control.getAttribute("aria-valuenow")).toBe("-6");
    expect(control.getAttribute("aria-valuetext")).toBe("-6.0 dB");
    expect(scale).toBeCloseTo(0.5011872336, 8);
    expect(line.getAttribute("aria-hidden")).toBe("true");
  });

  it("maps the waveform amplitude through static and dynamic gain at each horizontal position", () => {
    renderWithPoints([{ t: 0, gainDb: -6 }, { t: 2, gainDb: 0 }, { t: 4, gainDb: 6 }]);
    const amplitudeAt = waveAmplitudeAt();

    expect(amplitudeAt(0)).toBeCloseTo(10 ** (-12 / 20), 8);
    expect(amplitudeAt(0.5)).toBeCloseTo(10 ** (-6 / 20), 8);
    expect(amplitudeAt(1)).toBeCloseTo(1, 8);
  });

  it("composes waveform vertical zoom with clip gain without changing project data", () => {
    act(() => useProTools.getState().setAudioWaveformZoom(2));
    const amplitudeAt = waveAmplitudeAt();

    expect(amplitudeAt(0.5)).toBeCloseTo(2 * (10 ** (-6 / 20)), 8);
    expect(exec).not.toHaveBeenCalled();
  });

  it("keeps an upward pointer draft local until release and commits its exact gain", () => {
    // Given: pointer capture begins on the selected clip's -6 dB handle.
    const control = slider();
    pointer(control, "pointerdown", { pointerId: 4, button: 0, clientY: 60 });

    // When: the producer drags 20 px upward, then releases.
    pointer(control, "pointermove", { pointerId: 4, buttons: 1, clientY: 40 });
    expect(control.getAttribute("aria-valuenow")).toBe("-1");
    expect(waveAmplitudeAt()(0.5)).toBeCloseTo(10 ** (-1 / 20), 8);
    expect(exec).not.toHaveBeenCalled();
    pointer(control, "pointerup", { pointerId: 4, clientY: 40 });

    // Then: one MoshOps command commits the previewed value.
    expect(exec).toHaveBeenCalledTimes(1);
    expect(exec).toHaveBeenCalledWith("set_clip_gain", { clipId: CLIP_ID, gainDb: -1 });
  });

  it("abandons a pointer draft when the browser cancels it", () => {
    // Given: an upward drag has previewed a different clip gain.
    const control = slider();
    pointer(control, "pointerdown", { pointerId: 5, button: 0, clientY: 60 });
    pointer(control, "pointermove", { pointerId: 5, buttons: 1, clientY: 40 });
    expect(control.getAttribute("aria-valuenow")).toBe("-1");

    // When: pointer capture is cancelled before release.
    pointer(control, "pointercancel", { pointerId: 5, clientY: 40 });

    // Then: the snapshot value returns and no command is issued.
    expect(control.getAttribute("aria-valuenow")).toBe("-6");
    expect(exec).not.toHaveBeenCalled();
  });

  it("cancels an active pointer draft with Escape", () => {
    // Given: an active gesture has previewed a gain above the snapshot value.
    const control = slider();
    pointer(control, "pointerdown", { pointerId: 7, button: 0, clientY: 60 });
    pointer(control, "pointermove", { pointerId: 7, buttons: 1, clientY: 40 });
    expect(control.getAttribute("aria-valuenow")).toBe("-1");

    // When: the producer presses Escape before releasing the pointer.
    act(() => control.dispatchEvent(new KeyboardEvent("keydown", {
      key: "Escape",
      bubbles: true,
      cancelable: true,
    })));

    // Then: the snapshot value returns and nothing enters the command trail.
    expect(control.getAttribute("aria-valuenow")).toBe("-6");
    expect(exec).not.toHaveBeenCalled();
  });

  it("does not address the old clip after a project epoch change", () => {
    // Given: an inline gain drag is active for the current project.
    const control = slider();
    pointer(control, "pointerdown", { pointerId: 6, button: 0, clientY: 60 });
    pointer(control, "pointermove", { pointerId: 6, buttons: 1, clientY: 40 });

    // When: the project is replaced before the matching pointer release.
    act(() => useStore.setState((state) => ({ projectEpoch: state.projectEpoch + 1 })));
    pointer(control, "pointerup", { pointerId: 6, clientY: 40 });

    // Then: the preview is invalidated and the stale clip receives no command.
    expect(control.getAttribute("aria-valuenow")).toBe("-6");
    expect(exec).not.toHaveBeenCalled();
  });

  it("supports precise keyboard adjustment through the same command seam", () => {
    // Given: keyboard focus is on the selected clip's gain handle.
    const control = slider();
    control.focus();

    // When: ArrowUp requests one supported gain step.
    act(() => control.dispatchEvent(new KeyboardEvent("keydown", {
      key: "ArrowUp",
      bubbles: true,
      cancelable: true,
    })));

    // Then: the visible value and command both advance by 0.5 dB.
    expect(control.getAttribute("aria-valuenow")).toBe("-5.5");
    expect(exec).toHaveBeenCalledWith("set_clip_gain", { clipId: CLIP_ID, gainDb: -5.5 });
  });

  it("keeps the reference line visible while hiding the handle on an unselected clip", () => {
    // Given: the audio clip loses selection.
    act(() => useStore.setState({ selection: new Set() }));

    // Then: its gain remains legible without adding an inactive focus target.
    expect(host.querySelector("[data-testid=pt-clip-gain-line]")).not.toBeNull();
    expect(host.querySelector("[data-testid=pt-clip-gain-handle]")).toBeNull();
  });

  it("renders clip-local breakpoint sliders and a line grounded in the static gain", () => {
    renderWithPoints([{ t: 1, gainDb: 0 }, { t: 3, gainDb: 3 }]);

    const points = [...host.querySelectorAll<HTMLElement>("[data-testid=pt-clip-gain-point]")];
    expect(points).toHaveLength(2);
    expect(points[0].getAttribute("aria-valuetext")).toContain("-6.0 dB clip gain");
    expect(points[1].getAttribute("aria-valuetext")).toContain("+3.0 dB dynamic");
    expect(host.querySelector("[data-testid=pt-clip-gain-envelope]")).not.toBeNull();
  });

  it("adds a breakpoint by clicking the gain line without claiming the rest of the clip", () => {
    const envelope = setEnvelopeRect();
    const line = host.querySelector<SVGPathElement>("[data-testid=pt-clip-gain-line-hit]");
    if (!line) throw new Error("gain line hit target did not render");

    act(() => line.dispatchEvent(new PointerEvent("pointerdown", {
      bubbles: true, cancelable: true, pointerId: 20, button: 0, clientX: 200, clientY: 50,
    })));

    expect(envelope).not.toBeNull();
    expect(exec).toHaveBeenCalledWith("write_clip_gain_curve", {
      clipId: CLIP_ID,
      points: [{ t: 2, gainDb: 0 }],
    });

    act(() => useProTools.setState({ smartToolEnabled: false, activeTool: "selector" }));
    expect(host.querySelector("[data-testid=pt-clip-gain-line-hit]")).toBeNull();
  });

  it("previews a breakpoint move locally and commits the whole curve once", () => {
    renderWithPoints([{ t: 1, gainDb: 0 }, { t: 3, gainDb: -6 }]);
    setEnvelopeRect();
    const point = host.querySelector<HTMLElement>("[data-testid=pt-clip-gain-point]");
    if (!point) throw new Error("clip gain breakpoint did not render");

    pointer(point, "pointerdown", { pointerId: 21, button: 0, clientX: 100, clientY: 20 });
    pointer(point, "pointermove", { pointerId: 21, buttons: 1, clientX: 150, clientY: 0 });
    expect(point.getAttribute("aria-valuenow")).toBe("5");
    expect(waveAmplitudeAt()(0.375)).toBeCloseTo(10 ** (-1 / 20), 8);
    expect(exec).not.toHaveBeenCalled();
    pointer(point, "pointerup", { pointerId: 21, clientX: 150, clientY: 0 });

    expect(exec).toHaveBeenCalledTimes(1);
    expect(exec).toHaveBeenCalledWith("write_clip_gain_curve", {
      clipId: CLIP_ID,
      points: [{ t: 1.5, gainDb: 5 }, { t: 3, gainDb: -6 }],
    });
  });

  it("cancels a breakpoint draft on pointercancel and project replacement", () => {
    renderWithPoints([{ t: 1, gainDb: 0 }, { t: 3, gainDb: -6 }]);
    setEnvelopeRect();
    const point = host.querySelector<HTMLElement>("[data-testid=pt-clip-gain-point]")!;

    pointer(point, "pointerdown", { pointerId: 22, button: 0, clientX: 100, clientY: 20 });
    pointer(point, "pointermove", { pointerId: 22, buttons: 1, clientX: 150, clientY: 0 });
    expect(waveAmplitudeAt()(0.375)).toBeCloseTo(10 ** (-1 / 20), 8);
    pointer(point, "pointercancel", { pointerId: 22, clientX: 150, clientY: 0 });
    expect(exec).not.toHaveBeenCalled();
    expect(point.getAttribute("aria-valuenow")).toBe("0");
    expect(waveAmplitudeAt()(0.25)).toBeCloseTo(10 ** (-6 / 20), 8);

    pointer(point, "pointerdown", { pointerId: 23, button: 0, clientX: 100, clientY: 20 });
    pointer(point, "pointermove", { pointerId: 23, buttons: 1, clientX: 150, clientY: 0 });
    act(() => useStore.setState((state) => ({ projectEpoch: state.projectEpoch + 1 })));
    pointer(point, "pointerup", { pointerId: 23, clientX: 150, clientY: 0 });
    expect(exec).not.toHaveBeenCalled();
  });

  it("rolls an optimistic breakpoint edit back when MoshOps rejects it", async () => {
    renderWithPoints([{ t: 1, gainDb: 0 }, { t: 3, gainDb: -6 }]);
    let settle: ((result: CommandResult) => void) | undefined;
    const pending = new Promise<CommandResult>((resolve) => { settle = resolve; });
    exec.mockImplementation(() => pending);
    act(() => useStore.setState({ exec }));
    const point = host.querySelector<HTMLElement>("[data-testid=pt-clip-gain-point]")!;

    act(() => point.dispatchEvent(new KeyboardEvent("keydown", {
      key: "ArrowUp", bubbles: true, cancelable: true,
    })));
    expect(point.getAttribute("aria-valuenow")).toBe("0.5");

    await act(async () => {
      settle?.({ ok: false, command: "write_clip_gain_curve", error: "track is frozen" });
      await pending;
    });
    expect(point.getAttribute("aria-valuenow")).toBe("0");
  });

  it("supports keyboard gain, time, and delete edits through one envelope command", () => {
    renderWithPoints([{ t: 1, gainDb: 0 }, { t: 3, gainDb: -6 }]);
    const points = [...host.querySelectorAll<HTMLElement>("[data-testid=pt-clip-gain-point]")];
    const key = (element: HTMLElement, value: string) => act(() => element.dispatchEvent(
      new KeyboardEvent("keydown", { key: value, bubbles: true, cancelable: true }),
    ));

    key(points[0], "ArrowUp");
    expect(exec).toHaveBeenLastCalledWith("write_clip_gain_curve", {
      clipId: CLIP_ID,
      points: [{ t: 1, gainDb: 0.5 }, { t: 3, gainDb: -6 }],
    });
    key(points[1], "ArrowLeft");
    expect(exec).toHaveBeenLastCalledWith("write_clip_gain_curve", {
      clipId: CLIP_ID,
      points: [{ t: 1, gainDb: 0.5 }, { t: 2.75, gainDb: -6 }],
    });
    key(points[1], "Delete");
    expect(exec).toHaveBeenLastCalledWith("write_clip_gain_curve", {
      clipId: CLIP_ID,
      points: [{ t: 1, gainDb: 0.5 }],
    });
  });
});
