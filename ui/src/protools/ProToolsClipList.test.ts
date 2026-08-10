import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useStore } from "../store";
import type { CommandResult, Snapshot } from "../types";
import { ProToolsClipList } from "./ProToolsClipList";

const SNAPSHOT: Snapshot = {
  schemaVersion: 1,
  session: {
    sampleRate: 48_000,
    tempo: 120,
    editFile: "/tmp/protools-clip-groups.mosh",
    key: { tonic: "C", mode: "major" },
  },
  tracks: [
    {
      id: "drums",
      index: 0,
      name: "Drums",
      type: "audio",
      clips: [{
        id: "kick",
        name: "Kick",
        type: "wave",
        start: 0,
        length: 2,
        offset: 0,
        hasRenderLayer: false,
      }],
    },
    {
      id: "bass",
      index: 1,
      name: "Bass",
      type: "audio",
      clips: [{
        id: "bass-clip",
        name: "Bass Take",
        type: "wave",
        start: 0,
        length: 2,
        offset: 0,
        hasRenderLayer: false,
      }, {
        id: "fill",
        name: "Fill",
        type: "wave",
        start: 4,
        length: 1,
        offset: 0,
        hasRenderLayer: false,
      }],
    },
  ],
  clipGroups: [{
    id: "rhythm-group",
    name: "Rhythm Group",
    clipIds: ["kick", "bass-clip"],
    active: true,
  }],
  transport: {
    playing: false,
    recording: false,
    position: 0,
    looping: false,
    loopStart: 0,
    loopEnd: 0,
  },
};

describe("Pro Tools Clip List groups", () => {
  let host: HTMLDivElement;
  let root: Root;
  let exec: ReturnType<typeof vi.fn>;
  const original = useStore.getState();

  beforeEach(() => {
    Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
    exec = vi.fn(async (command: string): Promise<CommandResult> => ({ ok: true, command }));
    useStore.setState({
      snapshot: SNAPSHOT,
      selection: new Set<string>(),
      selectedTrackId: null,
      editingClipId: null,
      exec,
    });
    act(() => root.render(React.createElement(ProToolsClipList, {
      snapshot: SNAPSHOT,
      open: true,
      onOpenChange: vi.fn(),
    })));
  });

  afterEach(() => {
    act(() => root.unmount());
    host.remove();
    document.body.querySelectorAll(".v2-menu-panel-floating").forEach((node) => node.remove());
    useStore.setState({
      snapshot: original.snapshot,
      selection: original.selection,
      selectedTrackId: original.selectedTrackId,
      editingClipId: original.editingClipId,
      exec: original.exec,
    });
  });

  it("renders an active clip group once and selects every member without opening an editor", async () => {
    const rows = host.querySelectorAll<HTMLButtonElement>("[data-testid=pt-clip-list-item]");
    expect(rows).toHaveLength(2);
    expect(rows[0]?.dataset.entryKind).toBe("group");
    expect(rows[0]?.textContent).toContain("Rhythm Group");
    expect(rows[0]?.textContent).toContain("2 clips");

    await act(async () => rows[0]?.click());

    expect([...useStore.getState().selection]).toEqual(["kick", "bass-clip"]);
    expect(useStore.getState().selectedTrackId).toBe("drums");
    expect(useStore.getState().editingClipId).toBeNull();
  });

  it("exposes keyboard-operable Group, Ungroup, and Regroup actions through store.exec", async () => {
    act(() => useStore.setState({ selection: new Set(["kick", "bass-clip"]) }));
    const trigger = host.querySelector<HTMLButtonElement>("[data-testid=pt-clip-group-menu]");
    if (!trigger) throw new Error("Clip Group menu trigger is missing");
    await act(async () => trigger.click());

    const ungroup = document.querySelector<HTMLButtonElement>("[data-testid=pt-clip-group-ungroup]");
    const group = document.querySelector<HTMLButtonElement>("[data-testid=pt-clip-group-create]");
    const regroup = document.querySelector<HTMLButtonElement>("[data-testid=pt-clip-group-regroup]");
    expect(group?.getAttribute("aria-disabled")).toBe("true");
    expect(ungroup?.getAttribute("aria-disabled")).toBe("false");
    expect(regroup?.getAttribute("aria-disabled")).toBe("true");
    await act(async () => ungroup?.click());

    expect(exec).toHaveBeenCalledWith("ungroup_clip_group", { clipId: "kick" });
  });
});
