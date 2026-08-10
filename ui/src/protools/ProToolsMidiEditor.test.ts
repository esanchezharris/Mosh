import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useStore } from "../store";
import type { Clip, CommandResult, Snapshot } from "../types";
import { ProToolsDetailDock } from "./ProToolsDetailDock";

const midiClip = (
  id: string,
  name: string,
  pitch: number,
): Clip => ({
  id,
  name,
  type: "midi",
  start: 0,
  length: 8,
  offset: 0,
  hasRenderLayer: false,
  notes: [{ i: 0, pitch, start: 0, length: 1, velocity: 96 }],
});

const SNAPSHOT: Snapshot = {
  schemaVersion: 1,
  session: {
    sampleRate: 48_000,
    tempo: 120,
    timeSigNumerator: 4,
    timeSigDenominator: 4,
    editFile: "/tmp/protools-midi-editor.mosh",
    key: { tonic: "C", mode: "major" },
  },
  tracks: [
    {
      id: "drums",
      index: 0,
      name: "Drums",
      type: "drum",
      isInstrument: true,
      color: "#a24b55",
      clips: [midiClip("drums-clip", "loop", 60)],
    },
    {
      id: "bass",
      index: 1,
      name: "Bass",
      type: "audio",
      isInstrument: true,
      color: "#4778b8",
      clips: [midiClip("bass-clip", "sub", 36)],
    },
    {
      id: "keys",
      index: 2,
      name: "Keys",
      type: "audio",
      clips: [{
        id: "keys-wave",
        name: "chords",
        type: "wave",
        start: 0,
        length: 8,
        offset: 0,
        hasRenderLayer: false,
      }],
    },
  ],
  transport: { playing: false, recording: false, position: 0, looping: false, loopStart: 0, loopEnd: 0 },
};

describe("Pro Tools multi-track MIDI Editor", () => {
  let host: HTMLDivElement;
  let root: Root;
  const originalState = useStore.getState();

  beforeEach(() => {
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
    useStore.setState({
      snapshot: SNAPSHOT,
      projectEpoch: 7,
      editingClipId: "drums-clip",
      selectedTrackId: "drums",
      exec: vi.fn(async (command: string): Promise<CommandResult> => ({ ok: true, command })),
    });
  });

  afterEach(() => {
    act(() => root.unmount());
    host.remove();
    useStore.setState({
      snapshot: originalState.snapshot,
      projectEpoch: originalState.projectEpoch,
      editingClipId: originalState.editingClipId,
      selectedTrackId: originalState.selectedTrackId,
      exec: originalState.exec,
    });
  });

  const render = (): void => {
    act(() => root.render(React.createElement(ProToolsDetailDock)));
  };

  it("renders only MIDI working tracks with one visible edit target", () => {
    render();

    const list = host.querySelector("[data-testid=pt-midi-track-list]");
    const rows = [...host.querySelectorAll<HTMLElement>("[data-testid=pt-midi-track-row]")];
    const drumsVisible = host.querySelector<HTMLButtonElement>("[aria-label='Show Drums']");
    const drumsTarget = host.querySelector<HTMLButtonElement>("[aria-label='Edit Drums']");

    expect(list?.getAttribute("aria-label")).toBe("MIDI Editor Track List");
    expect(rows.map((row) => row.dataset.trackId)).toEqual(["drums", "bass"]);
    expect(list?.textContent).not.toContain("Keys");
    expect(drumsVisible?.getAttribute("aria-pressed")).toBe("true");
    expect(drumsVisible?.disabled).toBe(true);
    expect(drumsTarget?.getAttribute("aria-pressed")).toBe("true");
  });

  it("shows a second track as disarmed superimposed notes", () => {
    render();
    const showBass = host.querySelector<HTMLButtonElement>("[aria-label='Show Bass']");
    if (!showBass) throw new Error("Bass visibility control is missing");

    act(() => showBass.click());

    expect(showBass.getAttribute("aria-pressed")).toBe("true");
    const context = host.querySelector<HTMLElement>("[data-testid=pr-context-note][data-track-id=bass]");
    expect(context).not.toBeNull();
    expect(context?.getAttribute("aria-hidden")).toBe("true");
  });

  it("switches the sole command target without issuing a project command", () => {
    render();
    const editBass = host.querySelector<HTMLButtonElement>("[aria-label='Edit Bass']");
    if (!editBass) throw new Error("Bass target control is missing");

    act(() => editBass.click());

    expect(useStore.getState().editingClipId).toBe("bass-clip");
    expect(useStore.getState().selectedTrackId).toBe("bass");
    expect(editBass.getAttribute("aria-pressed")).toBe("true");
    expect(host.querySelector(".pr-head")?.textContent).toContain("Piano Roll · sub");
    expect(useStore.getState().exec).not.toHaveBeenCalled();
  });

  it("resets context visibility when the project epoch changes", () => {
    render();
    const showBass = host.querySelector<HTMLButtonElement>("[aria-label='Show Bass']");
    if (!showBass) throw new Error("Bass visibility control is missing");
    act(() => showBass.click());
    expect(showBass.getAttribute("aria-pressed")).toBe("true");

    act(() => useStore.setState({ projectEpoch: 8 }));

    expect(showBass.getAttribute("aria-pressed")).toBe("false");
    expect(host.querySelector("[data-testid=pr-context-note][data-track-id=bass]")).toBeNull();
  });
});
