import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useStore } from "../store";
import type { CommandResult, Snapshot } from "../types";
import { ProToolsDetailDock } from "./ProToolsDetailDock";

const CLIP_ID = "vocal-clip";
const SNAPSHOT: Snapshot = {
  schemaVersion: 1,
  session: {
    sampleRate: 48_000,
    tempo: 120,
    editFile: "/tmp/protools-clip.mosh",
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
      gainDb: -3,
      fadeInSec: 0.1,
      fadeOutSec: 0.2,
      mute: false,
      hasRenderLayer: false,
    }],
  }],
  transport: { playing: false, recording: false, position: 0, looping: false, loopStart: 0, loopEnd: 0 },
};

const inputValueSetter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;

function setInputValue(input: HTMLInputElement, value: string): void {
  if (!inputValueSetter) throw new Error("native input value setter is unavailable");
  inputValueSetter.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
  input.dispatchEvent(new Event("change", { bubbles: true }));
}

describe("Pro Tools audio clip inspector", () => {
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
      selectedTrackId: "audio-track",
      editingClipId: CLIP_ID,
      projectEpoch: 70,
      exec,
    });
    act(() => root.render(React.createElement(ProToolsDetailDock)));
  });

  afterEach(() => {
    act(() => root.unmount());
    host.remove();
    useStore.setState({
      snapshot: originalState.snapshot,
      selectedTrackId: originalState.selectedTrackId,
      editingClipId: originalState.editingClipId,
      projectEpoch: originalState.projectEpoch,
      exec: originalState.exec,
    });
  });

  function input(testId: string): HTMLInputElement {
    const control = host.querySelector<HTMLInputElement>(`[data-testid=${testId}]`);
    if (!control) throw new Error(`${testId} is missing`);
    return control;
  }

  function button(testId: string): HTMLButtonElement {
    const control = host.querySelector<HTMLButtonElement>(`[data-testid=${testId}]`);
    if (!control) throw new Error(`${testId} is missing`);
    return control;
  }

  it("renders editable name, mute, and clip-gain controls with the snapshot values", () => {
    expect(host.querySelector("[data-testid=pt-audio-clip-inspector]")).not.toBeNull();
    expect(input("pt-clip-name").value).toBe("Verse Take");
    expect(button("pt-clip-mute").getAttribute("aria-pressed")).toBe("false");
    expect(input("pt-clip-gain-slider").value).toBe("-3");
    expect(input("pt-clip-gain-number").value).toBe("-3");
    expect(host.querySelector("[data-testid=pt-wave-inspector]")?.textContent).toContain("Fade In");
  });

  it("routes clip rename and mute through store.exec", async () => {
    const name = input("pt-clip-name");
    act(() => setInputValue(name, "Verse Comp"));
    await act(async () => name.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })));
    await act(async () => button("pt-clip-mute").click());

    expect(exec).toHaveBeenCalledWith("rename_clip", { clipId: CLIP_ID, name: "Verse Comp" });
    expect(exec).toHaveBeenCalledWith("set_clip_mute", { clipId: CLIP_ID, mute: true });
  });

  it("keeps slider edits local until completion and then commits the exact gain", async () => {
    const slider = input("pt-clip-gain-slider");
    act(() => setInputValue(slider, "-7.5"));
    expect(exec).not.toHaveBeenCalledWith("set_clip_gain", expect.anything());

    await act(async () => slider.dispatchEvent(new Event("pointerup", { bubbles: true })));

    expect(exec).toHaveBeenCalledWith("set_clip_gain", { clipId: CLIP_ID, gainDb: -7.5 });
  });

  it("commits a valid numeric gain and resets gain to zero", async () => {
    const gain = input("pt-clip-gain-number");
    act(() => setInputValue(gain, "6.25"));
    await act(async () => gain.dispatchEvent(new FocusEvent("focusout", { bubbles: true })));
    await act(async () => button("pt-clip-gain-reset").click());

    expect(exec).toHaveBeenCalledWith("set_clip_gain", { clipId: CLIP_ID, gainDb: 6.25 });
    expect(exec).toHaveBeenCalledWith("set_clip_gain", { clipId: CLIP_ID, gainDb: 0 });
  });

  it("rejects empty names and out-of-range gain without issuing commands", async () => {
    const name = input("pt-clip-name");
    act(() => setInputValue(name, "   "));
    await act(async () => name.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })));
    const gain = input("pt-clip-gain-number");
    act(() => setInputValue(gain, "25"));
    await act(async () => gain.dispatchEvent(new FocusEvent("focusout", { bubbles: true })));

    expect(exec).not.toHaveBeenCalled();
    expect(name.getAttribute("aria-invalid")).toBe("true");
    expect(gain.getAttribute("aria-invalid")).toBe("true");
    expect(host.querySelector("#pt-clip-gain-error")?.textContent).toContain("-48 and +24");
  });

  it("cancels a gain draft with Escape", () => {
    const gain = input("pt-clip-gain-number");
    act(() => setInputValue(gain, "8"));

    act(() => gain.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));

    expect(gain.value).toBe("-3");
    expect(exec).not.toHaveBeenCalled();
  });

  it("discards a pending slider draft when the project epoch changes", async () => {
    const slider = input("pt-clip-gain-slider");
    act(() => setInputValue(slider, "9"));
    expect(slider.value).toBe("9");

    act(() => useStore.setState({ projectEpoch: 71 }));
    expect(slider.value).toBe("-3");
    await act(async () => slider.dispatchEvent(new Event("pointerup", { bubbles: true })));

    expect(exec).not.toHaveBeenCalled();
  });
});
