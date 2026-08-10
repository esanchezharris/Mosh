import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useStore } from "../store";
import type { Clip, CommandResult, Snapshot, Track } from "../types";
import { useShell } from "../v2/shellState";
import { ProToolsTrackHeaders } from "./ProToolsTrackHeaders";
import { useProTools } from "./proToolsState";

const clip = (id: string, start: number, length: number, type: Clip["type"]): Clip => ({
  id,
  name: id,
  type,
  start,
  length,
  offset: 0,
  hasRenderLayer: false,
});

const TRACKS = [
  { id: "audio-empty", index: 0, name: "Room", type: "audio", clips: [] },
  { id: "audio-vocal", index: 1, name: "Vocal", type: "audio", clips: [clip("take", 0, 6, "wave")] },
  { id: "midi", index: 2, name: "MIDI Print", type: "midi", clips: [clip("midi-print", 10, 2, "midi")] },
  { id: "instrument", index: 3, name: "Keys", type: "audio", isInstrument: true, clips: [clip("keys", 1, 2, "midi")] },
  { id: "drums", index: 4, name: "Drums", type: "drum", isInstrument: true, clips: [clip("drums", 4, 2, "midi")] },
  { id: "inactive", index: 5, name: "Print", type: "audio", active: false, clips: [clip("print", 8, 2, "wave")] },
  { id: "frozen", index: 6, name: "Choir", type: "audio", frozen: true, clips: [clip("choir", 3, 1, "wave")] },
  {
    id: "render-only",
    index: 7,
    name: "Hidden Render",
    type: "audio",
    clips: [{ ...clip("render", 2, 2, "wave"), hidden: true }],
  },
] as const satisfies readonly Track[];

const SNAPSHOT: Snapshot = {
  schemaVersion: 1,
  session: {
    sampleRate: 48_000,
    tempo: 120,
    editFile: "/tmp/protools-track-filters.mosh",
    key: { tonic: "C", mode: "major" },
  },
  tracks: [...TRACKS],
  transport: {
    playing: false,
    recording: false,
    position: 0,
    looping: false,
    loopStart: 0,
    loopEnd: 0,
  },
};

const SHOW_ONLY_CASES = [
  ["Audio Tracks", ["audio-empty", "audio-vocal", "inactive", "frozen", "render-only"]],
  ["MIDI Tracks", ["midi"]],
  ["Instrument Tracks", ["instrument", "drums"]],
  ["Inactive Tracks", ["inactive"]],
  ["Frozen Tracks", ["frozen"]],
  ["Tracks With Clips", ["audio-vocal", "midi", "instrument", "drums", "inactive", "frozen"]],
  ["Tracks With Clips Within Timeline Selection", ["audio-vocal", "instrument", "frozen"]],
] as const;

describe("Pro Tools Track List filters", () => {
  let host: HTMLDivElement;
  let root: Root;
  let exec: ReturnType<typeof vi.fn>;
  const originalExec = useStore.getState().exec;

  beforeEach(() => {
    Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
    exec = vi.fn(async (command: string): Promise<CommandResult> => ({ ok: true, command }));
    useStore.setState({ snapshot: SNAPSHOT, projectEpoch: 121, selectedTrackId: null, exec });
    useProTools.getState().resetForProject();
    useShell.setState({ timeRange: { start: 2, end: 4 }, timeRangeDragging: false });
  });

  afterEach(() => {
    act(() => root.unmount());
    host.remove();
    document.body.querySelectorAll(".v2-menu-panel-floating").forEach((node) => node.remove());
    useStore.setState({ snapshot: null, selectedTrackId: null, exec: originalExec });
    useShell.setState({ timeRange: null, timeRangeDragging: false });
  });

  it.each(SHOW_ONLY_CASES)("shows only %s without a project command", async (label, expectedIds) => {
    // Given a mixed session and a 2-4 second Timeline selection.
    act(() => root.render(React.createElement(ProToolsTrackHeaders, { snapshot: SNAPSHOT })));

    // When the matching Show Only filter is chosen.
    await openTrackListMenu(host);
    const action = document.querySelector<HTMLButtonElement>(
      `[aria-label="Show Only ${label}"]`,
    );
    if (!action) throw new Error(`Show Only ${label} is missing`);
    await act(async () => action.click());

    // Then only the hand-derived matching rows remain and project data is untouched.
    expect(shownTrackIds(host)).toEqual(expectedIds);
    expect(exec).not.toHaveBeenCalled();
  });

  it("hides instrument tracks without replacing the current shown set", async () => {
    // Given Room is already hidden in a mixed session.
    useProTools.getState().setTrackShown("audio-empty", false);
    act(() => root.render(React.createElement(ProToolsTrackHeaders, { snapshot: SNAPSHOT })));

    // When Hide Instrument Tracks is chosen.
    await openTrackListMenu(host);
    const action = document.querySelector<HTMLButtonElement>(
      '[aria-label="Hide Instrument Tracks"]',
    );
    if (!action) throw new Error("Hide Instrument Tracks is missing");
    await act(async () => action.click());

    // Then the existing hidden row stays hidden and only matching shown rows are removed.
    expect(shownTrackIds(host)).toEqual([
      "audio-vocal",
      "midi",
      "inactive",
      "frozen",
      "render-only",
    ]);
    expect(exec).not.toHaveBeenCalled();
  });

  it("disables the Timeline-selection clip filter when no Timeline range exists", async () => {
    // Given the producer has no Timeline selection.
    useShell.setState({ timeRange: null });
    act(() => root.render(React.createElement(ProToolsTrackHeaders, { snapshot: SNAPSHOT })));

    // When the Track List menu is opened.
    await openTrackListMenu(host);
    const showOnly = document.querySelector<HTMLButtonElement>(
      '[aria-label="Show Only Tracks With Clips Within Timeline Selection"]',
    );
    const hide = document.querySelector<HTMLButtonElement>(
      '[aria-label="Hide Tracks With Clips Within Timeline Selection"]',
    );

    // Then both range-dependent actions explain their unavailable state semantically.
    expect(showOnly?.getAttribute("aria-disabled")).toBe("true");
    expect(hide?.getAttribute("aria-disabled")).toBe("true");
  });
});

async function openTrackListMenu(host: HTMLElement): Promise<void> {
  const trigger = host.querySelector<HTMLButtonElement>("[data-testid=pt-track-visibility-menu]");
  if (!trigger) throw new Error("Track List menu trigger is missing");
  await act(async () => trigger.click());
}

function shownTrackIds(host: HTMLElement): readonly string[] {
  return [...host.querySelectorAll<HTMLElement>("[data-testid=pt-track-header]")]
    .flatMap((header) => header.dataset.trackId ?? []);
}
