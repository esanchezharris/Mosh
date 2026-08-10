import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useStore } from "../store";
import type { CommandResult, Snapshot } from "../types";
import { ProToolsRulers } from "./ProToolsRulers";
import { useProTools } from "./proToolsState";

const SNAPSHOT: Snapshot = {
  schemaVersion: 1,
  session: {
    sampleRate: 48_000,
    tempo: 120,
    editFile: "/tmp/protools-marker-ruler.mosh",
    key: { tonic: "C", mode: "major" },
  },
  tracks: [],
  transport: {
    playing: false,
    recording: false,
    position: 1,
    looping: false,
    loopStart: 0,
    loopEnd: 0,
  },
  annotations: [{ id: "marker-1", text: "Verse", beat: 4, color: "#4a90d9" }],
};

describe("Pro Tools Marker ruler", () => {
  let host: HTMLDivElement;
  let root: Root;
  let exec: ReturnType<typeof vi.fn>;
  const originalState = useStore.getState();

  beforeEach(() => {
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
    exec = vi.fn(async (command: string): Promise<CommandResult> => ({ ok: true, command }));
    useStore.setState({
      snapshot: SNAPSHOT,
      transport: SNAPSHOT.transport,
      projectEpoch: 60,
      exec,
    });
    useProTools.getState().resetForProject(60);
    act(() => root.render(React.createElement(ProToolsRulers, {
      snapshot: SNAPSHOT,
      rulersVisible: useProTools.getState().rulersVisible,
      contentWidth: 960,
      fieldRef: React.createRef<HTMLDivElement>(),
      getScrollLeft: () => 0,
    })));
  });

  afterEach(() => {
    act(() => root.unmount());
    host.remove();
    useStore.setState({
      snapshot: originalState.snapshot,
      transport: originalState.transport,
      projectEpoch: originalState.projectEpoch,
      exec: originalState.exec,
    });
  });

  function button(testId: string): HTMLButtonElement {
    const control = host.querySelector<HTMLButtonElement>(`[data-testid=${testId}]`);
    if (!control) throw new Error(`${testId} is missing`);
    return control;
  }

  it("renders persistent markers and exposes create, recall, edit, and Alt-remove gestures", async () => {
    expect(host.querySelectorAll("[data-ruler]")).toHaveLength(5);
    expect(host.querySelector("[data-ruler=markers]")?.textContent).toContain("Verse");

    await act(async () => button("pt-memory-ruler-add").click());
    expect(useProTools.getState().memoryLocationEditor).toEqual({ mode: "create", seconds: 1 });

    await act(async () => button("pt-memory-marker-marker-1").click());
    expect(exec).toHaveBeenCalledWith("set_transport", { position: 2 });

    act(() => button("pt-memory-marker-marker-1")
      .dispatchEvent(new MouseEvent("dblclick", { bubbles: true })));
    expect(useProTools.getState().memoryLocationEditor).toEqual({
      mode: "edit",
      annotationId: "marker-1",
    });

    await act(async () => button("pt-memory-marker-marker-1")
      .dispatchEvent(new MouseEvent("click", { bubbles: true, altKey: true })));
    expect(exec).toHaveBeenCalledWith("remove_annotation", { annotationId: "marker-1" });
  });
});
