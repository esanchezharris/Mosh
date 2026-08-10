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
    React.createElement("button", {
      type: "button",
      className: "pt-lane",
      "data-track-id": snapshot.tracks[0]?.id,
      "data-testid": "mock-edit-lane",
    }, "Edit Vocal"),
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
    const lane = host.querySelector<HTMLButtonElement>("[data-testid=mock-edit-lane]");
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
