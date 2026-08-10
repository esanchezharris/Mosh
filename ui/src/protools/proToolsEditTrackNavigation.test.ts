import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useStore } from "../store";
import type { CommandResult, Snapshot } from "../types";
import { useShell } from "../v2/shellState";
import { handleProToolsEditTrackNavigation } from "./proToolsEditTrackNavigation";
import { useProTools } from "./proToolsState";

const VISIBLE_TRACK_IDS = ["drums", "bass", "vocal", "keys"] as const;

const SNAPSHOT: Snapshot = {
  schemaVersion: 1,
  session: {
    sampleRate: 48_000,
    tempo: 120,
    editFile: "/tmp/protools-edit-track-navigation.mosh",
    key: { tonic: "C", mode: "major" },
  },
  tracks: VISIBLE_TRACK_IDS.map((id, index) => ({
    id,
    index,
    name: id,
    type: "audio",
    clips: [],
  })),
  transport: {
    playing: false,
    recording: false,
    position: 0,
    looping: false,
    loopStart: 0,
    loopEnd: 0,
  },
  annotations: [],
};

describe("Pro Tools vertical Edit-selection keyboard navigation", () => {
  const originalExec = useStore.getState().exec;
  const exec = vi.fn(async (command: string): Promise<CommandResult> => ({ ok: true, command }));
  let outside: HTMLButtonElement;

  beforeEach(() => {
    exec.mockReset();
    useProTools.getState().resetForProject();
    useShell.setState({ timeRange: { start: 2, end: 6 } });
    useStore.setState({ snapshot: SNAPSHOT, selectedTrackId: "vocal", exec });
    outside = document.createElement("button");
    document.body.appendChild(outside);
    outside.focus();
  });

  afterEach(() => {
    outside.remove();
    useStore.setState({ snapshot: null, selectedTrackId: null, exec: originalExec });
    useShell.setState({ timeRange: null });
  });

  it.each([
    {
      label: "up",
      code: "KeyP",
      expectedIds: ["drums", "bass", "vocal"],
      expectedFocus: "drums",
    },
    {
      label: "down",
      code: "Semicolon",
      expectedIds: ["bass", "vocal", "keys"],
      expectedFocus: "keys",
    },
  ])("extends the linked Edit selection $label while preserving its time span", ({
    code,
    expectedIds,
    expectedFocus,
  }) => {
    // Given Bass and Vocal own one linked Edit span.
    useProTools.setState({
      editSelectionTrackId: "vocal",
      editSelectionTrackIds: ["bass", "vocal"],
      trackSelectionIds: ["bass", "vocal"],
    });

    // When Avid's Mac Extend Edit shortcut is used.
    const event = new KeyboardEvent("keydown", {
      code,
      ctrlKey: true,
      shiftKey: true,
      cancelable: true,
    });
    const handled = handleProToolsEditTrackNavigation(event);

    // Then one neighboring visible track joins both linked sets without a command.
    expect(handled).toBe(true);
    expect(event.defaultPrevented).toBe(true);
    expect(useProTools.getState().editSelectionTrackIds).toEqual(expectedIds);
    expect(useProTools.getState().trackSelectionIds).toEqual(expectedIds);
    expect(useProTools.getState().editSelectionTrackId).toBe(expectedFocus);
    expect(useStore.getState().selectedTrackId).toBe(expectedFocus);
    expect(useShell.getState().timeRange).toEqual({ start: 2, end: 6 });
    expect(exec).not.toHaveBeenCalled();
  });

  it.each([
    {
      label: "top",
      code: "KeyP",
      expectedIds: ["bass", "vocal"],
      expectedFocus: "bass",
    },
    {
      label: "bottom",
      code: "Semicolon",
      expectedIds: ["drums", "bass"],
      expectedFocus: "bass",
    },
  ])("removes the $label edge from a linked Edit selection", ({
    code,
    expectedIds,
    expectedFocus,
  }) => {
    // Given three visible tracks own the linked Edit span.
    useProTools.setState({
      editSelectionTrackId: "bass",
      editSelectionTrackIds: ["drums", "bass", "vocal"],
      trackSelectionIds: ["drums", "bass", "vocal"],
    });

    // When Avid's Mac Remove Edit shortcut is used.
    const event = new KeyboardEvent("keydown", {
      code,
      ctrlKey: true,
      altKey: true,
      cancelable: true,
    });
    const handled = handleProToolsEditTrackNavigation(event);

    // Then only the requested outer edge leaves both linked sets.
    expect(handled).toBe(true);
    expect(event.defaultPrevented).toBe(true);
    expect(useProTools.getState().editSelectionTrackIds).toEqual(expectedIds);
    expect(useProTools.getState().trackSelectionIds).toEqual(expectedIds);
    expect(useProTools.getState().editSelectionTrackId).toBe(expectedFocus);
    expect(useStore.getState().selectedTrackId).toBe(expectedFocus);
    expect(useShell.getState().timeRange).toEqual({ start: 2, end: 6 });
    expect(exec).not.toHaveBeenCalled();
  });

  it("changes only Edit ownership while Track/Edit is unlinked", () => {
    // Given Bass owns Edit while Keys remains the independent Track selection.
    useProTools.setState({
      trackEditLinked: false,
      editSelectionTrackId: "bass",
      editSelectionTrackIds: ["bass"],
      trackSelectionIds: ["keys"],
    });
    useStore.setState({ selectedTrackId: "keys" });

    // When Extend Edit Up is used.
    const event = new KeyboardEvent("keydown", {
      code: "KeyP",
      ctrlKey: true,
      shiftKey: true,
      cancelable: true,
    });
    handleProToolsEditTrackNavigation(event);

    // Then Edit expands upward while Track selection and inspector remain on Keys.
    expect(useProTools.getState().editSelectionTrackIds).toEqual(["drums", "bass"]);
    expect(useProTools.getState().editSelectionTrackId).toBe("drums");
    expect(useProTools.getState().trackSelectionIds).toEqual(["keys"]);
    expect(useStore.getState().selectedTrackId).toBe("keys");
    expect(exec).not.toHaveBeenCalled();
  });

  it.each([
    { label: "an Extend past the top", code: "KeyP", shiftKey: true, altKey: false },
    { label: "a Remove from one owner", code: "Semicolon", shiftKey: false, altKey: true },
  ])("does not claim $label boundary operation", ({ code, shiftKey, altKey }) => {
    // Given the first track is the only Edit owner.
    useProTools.setState({
      editSelectionTrackId: "drums",
      editSelectionTrackIds: ["drums"],
      trackSelectionIds: ["drums"],
    });
    useStore.setState({ selectedTrackId: "drums" });

    // When the operation has no applicable destination.
    const event = new KeyboardEvent("keydown", {
      code,
      ctrlKey: true,
      shiftKey,
      altKey,
      cancelable: true,
    });
    const handled = handleProToolsEditTrackNavigation(event);

    // Then state and native key handling stay untouched.
    expect(handled).toBe(false);
    expect(event.defaultPrevented).toBe(false);
    expect(useProTools.getState().editSelectionTrackIds).toEqual(["drums"]);
    expect(useShell.getState().timeRange).toEqual({ start: 2, end: 6 });
    expect(exec).not.toHaveBeenCalled();
  });
});
