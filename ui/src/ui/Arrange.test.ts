import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Arrange } from "./Arrange";
import { useStore } from "../store";
import { useDrumWindow } from "./dock/useFloatingWindow";
import type { CommandResult, Snapshot, Track } from "../types";

vi.mock("../bridge", async () => {
  const actual = await vi.importActual<typeof import("../bridge")>("../bridge");
  return {
    ...actual,
    onEvent: vi.fn(() => () => {}),
    pickFiles: vi.fn(),
    pickSaveFile: vi.fn(),
  };
});

const clip = (id: string, notes: NonNullable<Track["clips"][number]["notes"]>) => ({
  id,
  name: id,
  type: "midi" as const,
  start: 0,
  length: 4,
  offset: 0,
  hasRenderLayer: false,
  notes,
});

function snapshotFor(track: Track): Snapshot {
  return {
    schemaVersion: 1,
    session: {
      sampleRate: 48000,
      tempo: 120,
      timeSigNumerator: 4,
      timeSigDenominator: 4,
      metronome: false,
      length: 16,
      editFile: "/tmp/arrange-test.tracktionedit",
      key: { tonic: "A", mode: "minor" },
    },
    tracks: [track],
    transport: { playing: false, recording: false, position: 0, looping: false, loopStart: 0, loopEnd: 0 },
    master: { volumeDb: 0, pan: 0 },
  };
}

function doubleClick(el: Element) {
  act(() => {
    el.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, pointerId: 1, clientX: 20, clientY: 20 }));
    el.dispatchEvent(new PointerEvent("pointerup", { bubbles: true, pointerId: 1, clientX: 20, clientY: 20 }));
    el.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, pointerId: 2, clientX: 20, clientY: 20 }));
    el.dispatchEvent(new PointerEvent("pointerup", { bubbles: true, pointerId: 2, clientX: 20, clientY: 20 }));
  });
}

describe("Arrange clip open routing", () => {
  let host: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({
      scale: vi.fn(),
      clearRect: vi.fn(),
      fillRect: vi.fn(),
      globalAlpha: 1,
      fillStyle: "",
    } as unknown as CanvasRenderingContext2D);
    useDrumWindow.setState({ clipId: null });
    useStore.setState({
      pxPerSec: 80,
      tool: "move",
      snap: false,
      snapDivision: "1/4",
      selection: new Set<string>(),
      timeRange: null,
      expandedTracks: new Set<string>(),
      levels: { tracks: {}, master: { l: -100, r: -100 } },
      exec: vi.fn(async (command: string): Promise<CommandResult> => ({ ok: true, command })),
    });
  });

  afterEach(() => {
    act(() => root.unmount());
    host.remove();
    useDrumWindow.setState({ clipId: null });
    useStore.setState({ editingClipId: null, selection: new Set<string>() });
    vi.restoreAllMocks();
  });

  it("opens a drum-track MIDI clip in the drum sequencer", () => {
    const track: Track = {
      id: "t-drums",
      index: 0,
      name: "Drums",
      type: "drum",
      clips: [clip("c-drums", [{ i: 0, pitch: 36, start: 0, length: 0.25, velocity: 110 }])],
    };
    act(() => root.render(React.createElement(Arrange, { snapshot: snapshotFor(track) })));

    doubleClick(host.querySelector('[data-clip-id="c-drums"]')!);

    expect(useDrumWindow.getState().clipId).toBe("c-drums");
    expect(useStore.getState().editingClipId).toBeNull();
  });

  it("opens a drum-like MIDI clip in the drum sequencer", () => {
    const track: Track = {
      id: "t-beat",
      index: 0,
      name: "Beat",
      type: "audio",
      clips: [clip("c-beat", [{ i: 0, pitch: 42, start: 0, length: 0.25, velocity: 110 }])],
    };
    act(() => root.render(React.createElement(Arrange, { snapshot: snapshotFor(track) })));

    doubleClick(host.querySelector('[data-clip-id="c-beat"]')!);

    expect(useDrumWindow.getState().clipId).toBe("c-beat");
    expect(useStore.getState().editingClipId).toBeNull();
  });

  it("keeps melodic MIDI clips in the piano roll", () => {
    const track: Track = {
      id: "t-keys",
      index: 0,
      name: "Keys",
      type: "audio",
      clips: [clip("c-keys", [{ i: 0, pitch: 64, start: 0, length: 1, velocity: 100 }])],
    };
    act(() => root.render(React.createElement(Arrange, { snapshot: snapshotFor(track) })));

    doubleClick(host.querySelector('[data-clip-id="c-keys"]')!);

    expect(useDrumWindow.getState().clipId).toBeNull();
    expect(useStore.getState().editingClipId).toBe("c-keys");
  });
});
