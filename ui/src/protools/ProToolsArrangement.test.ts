import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useStore } from "../store";
import type { Clip, CommandResult, Snapshot } from "../types";
import { useProTools } from "./proToolsState";
import { ProToolsArrangement } from "./ProToolsArrangement";

vi.mock("./ProToolsClipList", () => ({ ProToolsClipList: () => React.createElement("aside") }));
vi.mock("./ProToolsRulers", () => ({ ProToolsRulers: () => React.createElement("div") }));
vi.mock("./ProToolsTimeline", () => ({
  ProToolsTimeline: ({ snapshot, onSpotClip }: {
    readonly snapshot: Snapshot;
    readonly onSpotClip?: (clip: Clip) => void;
  }) => React.createElement("div", null,
    React.createElement("button", {
      type: "button",
      onClick: () => {
        const clip = snapshot.tracks[0]?.clips[0];
        if (clip && onSpotClip) onSpotClip(clip);
      },
    }, "Request spot"),
    React.createElement("div", { className: "pt-timeline-content" },
      snapshot.tracks.map((track) => React.createElement("div", {
        key: track.id,
        className: "pt-lane",
        "data-track-id": track.id,
        "data-testid": "mock-edit-lane",
      }, React.createElement("span", {
        "data-testid": `mock-edit-surface-${track.id}`,
      }, `Edit ${track.name}`))),
    ),
  ),
}));
vi.mock("./ProToolsTrackHeaders", () => ({ ProToolsTrackHeaders: () => React.createElement("div") }));

const SNAPSHOT: Snapshot = {
  schemaVersion: 1,
  session: {
    sampleRate: 48_000,
    tempo: 120,
    editFile: "/tmp/protools-arrangement.mosh",
    key: { tonic: "C", mode: "major" },
  },
  tracks: [{
    id: "audio-track",
    index: 0,
    name: "Vocal",
    type: "audio",
    clips: [{
      id: "audio-clip",
      name: "Verse Vocal",
      type: "wave",
      start: 2,
      length: 4,
      offset: 0,
      hasRenderLayer: false,
    }],
  }, {
    id: "bass-track",
    index: 1,
    name: "Bass",
    type: "audio",
    clips: [],
  }, {
    id: "keys-track",
    index: 2,
    name: "Keys",
    type: "audio",
    clips: [],
  }],
  transport: { playing: false, recording: false, position: 0, looping: false, loopStart: 0, loopEnd: 0 },
};

const inputValueSetter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;

function enterValue(input: HTMLInputElement, value: string): void {
  if (!inputValueSetter) throw new Error("native input value setter is unavailable");
  inputValueSetter.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

describe("ProToolsArrangement", () => {
  let host: HTMLDivElement;
  let root: Root;
  let exec: ReturnType<typeof vi.fn>;
  let compact = true;
  let changeListener: (() => void) | undefined;
  const originalExec = useStore.getState().exec;

  beforeEach(() => {
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    compact = true;
    changeListener = undefined;
    vi.stubGlobal("matchMedia", vi.fn(() => ({
      get matches() { return compact; },
      addEventListener: (_event: string, listener: () => void) => { changeListener = listener; },
      removeEventListener: vi.fn(),
    })));
    useProTools.getState().resetForProject();
    useProTools.setState({ clipListOpen: true });
    exec = vi.fn(async (command: string): Promise<CommandResult> => ({ ok: true, command }));
    useStore.setState({ snapshot: SNAPSHOT, projectEpoch: 51, selectedTrackId: null, exec });
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
  });

  afterEach(() => {
    act(() => root.unmount());
    host.remove();
    useStore.setState({ snapshot: null, selectedTrackId: null, exec: originalExec });
    vi.unstubAllGlobals();
  });

  it("closes the default Clip List when the Edit Window enters compact width", async () => {
    act(() => root.render(React.createElement(ProToolsArrangement, { snapshot: SNAPSHOT })));

    await vi.waitFor(() => expect(useProTools.getState().clipListOpen).toBe(false));
  });

  it("closes an open Clip List when the viewport becomes compact", () => {
    compact = false;
    act(() => root.render(React.createElement(ProToolsArrangement, { snapshot: SNAPSHOT })));
    useProTools.setState({ clipListOpen: true });
    compact = true;
    if (!changeListener) throw new Error("compact listener is missing");

    act(() => changeListener?.());

    expect(useProTools.getState().clipListOpen).toBe(false);
  });

  it("selects the lane associated with a linked Edit interaction", () => {
    // Given no active track in the default linked Track/Edit state.
    compact = false;
    act(() => root.render(React.createElement(ProToolsArrangement, { snapshot: SNAPSHOT })));
    const lane = host.querySelector<HTMLElement>("[data-testid=mock-edit-lane]");
    if (!lane) throw new Error("mock Edit lane is missing");

    // When the producer begins an Edit interaction in the Vocal lane.
    act(() => lane.dispatchEvent(new PointerEvent("pointerdown", {
      button: 0,
      bubbles: true,
      cancelable: true,
    })));

    // Then the associated track becomes active without a project command.
    expect(useStore.getState().selectedTrackId).toBe("audio-track");
    expect(exec).not.toHaveBeenCalled();
  });

  it("associates a vertical Edit drag with every contiguous visible track", () => {
    // Given three visible lanes and the linked Selector surface.
    compact = false;
    act(() => root.render(React.createElement(ProToolsArrangement, { snapshot: SNAPSHOT })));
    const lanes = Array.from(host.querySelectorAll<HTMLElement>("[data-testid=mock-edit-lane]"));
    lanes.forEach((lane, index) => {
      vi.spyOn(lane, "getBoundingClientRect").mockReturnValue(new DOMRect(160, 100 + index * 92, 800, 92));
    });
    const firstSurface = host.querySelector<HTMLElement>("[data-testid=mock-edit-surface-audio-track]");
    if (!firstSurface) throw new Error("first Edit surface is missing");

    // When the Edit drag crosses from Vocal through Keys.
    act(() => {
      firstSurface.dispatchEvent(new PointerEvent("pointerdown", {
        pointerId: 7,
        button: 0,
        clientY: 120,
        bubbles: true,
        cancelable: true,
      }));
      firstSurface.dispatchEvent(new PointerEvent("pointermove", {
        pointerId: 7,
        buttons: 1,
        clientY: 304,
        bubbles: true,
        cancelable: true,
      }));
      firstSurface.dispatchEvent(new PointerEvent("pointerup", {
        pointerId: 7,
        button: 0,
        clientY: 304,
        bubbles: true,
        cancelable: true,
      }));
    });

    // Then Edit and Track selection share the ordered lane set and Keys is active.
    expect(useProTools.getState().editSelectionTrackIds)
      .toEqual(["audio-track", "bass-track", "keys-track"]);
    expect(useProTools.getState().trackSelectionIds)
      .toEqual(["audio-track", "bass-track", "keys-track"]);
    expect(useStore.getState().selectedTrackId).toBe("keys-track");
    expect(exec).not.toHaveBeenCalled();
  });

  it("restores both track sets when a vertical Edit drag is cancelled", () => {
    // Given Bass owns the linked Edit and Track selection before a new drag.
    compact = false;
    useProTools.setState({
      editSelectionTrackId: "bass-track",
      editSelectionTrackIds: ["bass-track"],
      trackSelectionIds: ["bass-track"],
    });
    useStore.setState({ selectedTrackId: "bass-track" });
    act(() => root.render(React.createElement(ProToolsArrangement, { snapshot: SNAPSHOT })));
    const lanes = Array.from(host.querySelectorAll<HTMLElement>("[data-testid=mock-edit-lane]"));
    lanes.forEach((lane, index) => {
      vi.spyOn(lane, "getBoundingClientRect").mockReturnValue(new DOMRect(160, 100 + index * 92, 800, 92));
    });
    const firstSurface = host.querySelector<HTMLElement>("[data-testid=mock-edit-surface-audio-track]");
    if (!firstSurface) throw new Error("first Edit surface is missing");

    // When a Vocal-to-Keys drag is cancelled by the pointer system.
    act(() => {
      firstSurface.dispatchEvent(new PointerEvent("pointerdown", {
        pointerId: 8,
        button: 0,
        clientY: 120,
        bubbles: true,
        cancelable: true,
      }));
      firstSurface.dispatchEvent(new PointerEvent("pointermove", {
        pointerId: 8,
        buttons: 1,
        clientY: 304,
        bubbles: true,
        cancelable: true,
      }));
      firstSurface.dispatchEvent(new PointerEvent("pointercancel", {
        pointerId: 8,
        bubbles: true,
        cancelable: true,
      }));
    });

    // Then the prior Bass-only ownership and active track return without a command.
    expect(useProTools.getState().editSelectionTrackIds).toEqual(["bass-track"]);
    expect(useProTools.getState().trackSelectionIds).toEqual(["bass-track"]);
    expect(useStore.getState().selectedTrackId).toBe("bass-track");
    expect(exec).not.toHaveBeenCalled();
  });

  it("contains focus in the Spot dialog and restores the originating clip on Escape", () => {
    // Given: a focused clip activation surface in the full-width Edit Window.
    compact = false;
    act(() => root.render(React.createElement(ProToolsArrangement, { snapshot: SNAPSHOT })));
    const trigger = Array.from(host.querySelectorAll<HTMLButtonElement>("button"))
      .find((button) => button.textContent === "Request spot");
    if (!trigger) throw new Error("Spot trigger is missing");
    trigger.focus();

    // When: the timeline requests precise placement for its clip.
    act(() => trigger.click());

    // Then: Start owns initial focus and Tab cannot escape the modal controls.
    const dialog = host.querySelector<HTMLElement>("[data-testid=pt-spot-dialog]");
    const start = host.querySelector<HTMLInputElement>("[data-testid=pt-spot-start]");
    const submit = host.querySelector<HTMLButtonElement>("button[type=submit]");
    if (!dialog || !start || !submit) throw new Error("Spot dialog controls are missing");
    expect(document.activeElement).toBe(start);
    act(() => start.dispatchEvent(new KeyboardEvent("keydown", {
      key: "Tab",
      shiftKey: true,
      bubbles: true,
      cancelable: true,
    })));
    expect(document.activeElement).toBe(submit);

    // When: Escape dismisses the top-most Pro Tools overlay.
    act(() => window.dispatchEvent(new KeyboardEvent("keydown", {
      key: "Escape",
      bubbles: true,
      cancelable: true,
    })));

    // Then: the dialog is gone and focus returns to its clip trigger.
    expect(host.querySelector("[data-testid=pt-spot-dialog]")).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });

  it("preserves the clip location when the Spot Time Scale changes", () => {
    // Given: a two-second clip start opened in the default Minutes:Seconds scale.
    compact = false;
    act(() => root.render(React.createElement(ProToolsArrangement, { snapshot: SNAPSHOT })));
    const trigger = Array.from(host.querySelectorAll<HTMLButtonElement>("button"))
      .find((button) => button.textContent === "Request spot");
    if (!trigger) throw new Error("Spot trigger is missing");
    act(() => trigger.click());
    const start = host.querySelector<HTMLInputElement>("[data-testid=pt-spot-start]");
    const scale = host.querySelector<HTMLSelectElement>("#pt-spot-scale");
    if (!start || !scale) throw new Error("Spot time controls are missing");
    expect(start.value).toBe("00:02.000");

    // When: the producer chooses the Samples time scale.
    act(() => {
      scale.value = "samples";
      scale.dispatchEvent(new Event("change", { bubbles: true }));
    });

    // Then: the same two-second location is represented as 96,000 samples.
    expect(start.value).toBe("96,000");
  });

  it("moves the clip through the command seam after a valid Spot submission", async () => {
    // Given: a Spot dialog for the vocal clip with a valid Minutes:Seconds destination.
    compact = false;
    act(() => root.render(React.createElement(ProToolsArrangement, { snapshot: SNAPSHOT })));
    const trigger = Array.from(host.querySelectorAll<HTMLButtonElement>("button"))
      .find((button) => button.textContent === "Request spot");
    if (!trigger) throw new Error("Spot trigger is missing");
    act(() => trigger.click());
    const start = host.querySelector<HTMLInputElement>("[data-testid=pt-spot-start]");
    const submit = host.querySelector<HTMLButtonElement>("button[type=submit]");
    if (!start || !submit) throw new Error("Spot submission controls are missing");
    act(() => {
      enterValue(start, "00:05.500");
    });

    // When: the producer confirms the precise location.
    await act(async () => submit.click());

    // Then: one MoshOps move command is sent and the successful dialog closes.
    expect(exec).toHaveBeenCalledTimes(1);
    expect(exec).toHaveBeenCalledWith("move_clip", { clipId: "audio-clip", start: 5.5 });
    expect(host.querySelector("[data-testid=pt-spot-dialog]")).toBeNull();
  });

  it("keeps an invalid Spot location out of the command seam", async () => {
    // Given: a Spot dialog whose Start value is not valid Minutes:Seconds input.
    compact = false;
    act(() => root.render(React.createElement(ProToolsArrangement, { snapshot: SNAPSHOT })));
    const trigger = Array.from(host.querySelectorAll<HTMLButtonElement>("button"))
      .find((button) => button.textContent === "Request spot");
    if (!trigger) throw new Error("Spot trigger is missing");
    act(() => trigger.click());
    const start = host.querySelector<HTMLInputElement>("[data-testid=pt-spot-start]");
    const submit = host.querySelector<HTMLButtonElement>("button[type=submit]");
    if (!start || !submit) throw new Error("Spot submission controls are missing");
    act(() => {
      enterValue(start, "tomorrow");
    });

    // When: the producer tries to confirm it.
    await act(async () => submit.click());

    // Then: no command runs, the field is marked invalid, and its error owns focus.
    expect(exec).not.toHaveBeenCalled();
    expect(start.getAttribute("aria-invalid")).toBe("true");
    expect(host.querySelector("[role=alert]")).not.toBeNull();
    expect(document.activeElement).toBe(start);
  });

  it("keeps the Spot dialog modal while its move command is pending", async () => {
    // Given: the bridge has accepted a valid Spot request but has not answered yet.
    compact = false;
    let resolveCommand: ((result: CommandResult) => void) | undefined;
    exec.mockImplementation(() => new Promise<CommandResult>((resolve) => {
      resolveCommand = resolve;
    }));
    act(() => root.render(React.createElement(ProToolsArrangement, { snapshot: SNAPSHOT })));
    const trigger = Array.from(host.querySelectorAll<HTMLButtonElement>("button"))
      .find((button) => button.textContent === "Request spot");
    if (!trigger) throw new Error("Spot trigger is missing");
    act(() => trigger.click());
    const submit = host.querySelector<HTMLButtonElement>("button[type=submit]");
    if (!submit) throw new Error("Spot submit control is missing");
    await act(async () => {
      submit.click();
      await Promise.resolve();
    });

    // When: Escape is pressed while the command owns the dialog lifecycle.
    act(() => window.dispatchEvent(new KeyboardEvent("keydown", {
      key: "Escape",
      bubbles: true,
      cancelable: true,
    })));

    // Then: the modal remains visible until the command resolves successfully.
    expect(host.querySelector("[data-testid=pt-spot-dialog]")).not.toBeNull();
    if (!resolveCommand) throw new Error("Spot command resolver is missing");
    await act(async () => resolveCommand?.({ ok: true, command: "move_clip" }));
    expect(host.querySelector("[data-testid=pt-spot-dialog]")).toBeNull();
  });
});
