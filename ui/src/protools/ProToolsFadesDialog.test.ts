import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useStore, type State } from "../store";
import type { Clip, CommandResult } from "../types";
import { ProToolsFadesDialog } from "./ProToolsFadesDialog";
import type { ProToolsFadeTarget } from "./proToolsFades";

const OUTGOING: Clip = {
  id: "outgoing",
  name: "Lead A",
  type: "wave",
  start: 2,
  length: 4,
  offset: 0,
  autoCrossfade: true,
  hasRenderLayer: false,
};
const INCOMING: Clip = {
  id: "incoming",
  name: "Lead B",
  type: "wave",
  start: 5,
  length: 4,
  offset: 0,
  autoCrossfade: true,
  hasRenderLayer: false,
};
const TARGETS: readonly ProToolsFadeTarget[] = [
  { trackId: "vocal", trackIndex: 0, clip: OUTGOING },
  { trackId: "vocal", trackIndex: 0, clip: INCOMING },
];

describe("Pro Tools Fades dialog", () => {
  let host: HTMLDivElement;
  let root: Root;
  let trigger: HTMLButtonElement;
  let onClose: ReturnType<typeof vi.fn>;
  let exec: ReturnType<typeof vi.fn>;
  let runAtomic: ReturnType<typeof vi.fn>;
  const original = useStore.getState();

  beforeEach(() => {
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    trigger = document.createElement("button");
    trigger.textContent = "Fades";
    document.body.appendChild(trigger);
    trigger.focus();
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
    onClose = vi.fn();
    exec = vi.fn(async (command: string): Promise<CommandResult> => ({ ok: true, command }));
    runAtomic = vi.fn(async (_label: string, body: (run: State["exec"]) => Promise<void>) => body(exec));
    useStore.setState({ projectEpoch: 71, exec, runAtomic });
    act(() => root.render(React.createElement(ProToolsFadesDialog, { targets: TARGETS, onClose })));
  });

  afterEach(() => {
    act(() => root.unmount());
    host.remove();
    trigger.remove();
    useStore.setState({ projectEpoch: original.projectEpoch, exec: original.exec, runAtomic: original.runAtomic });
    vi.restoreAllMocks();
  });

  function control<T extends HTMLElement>(testId: string): T {
    const element = host.querySelector<T>(`[data-testid=${testId}]`);
    if (!element) throw new Error(`${testId} is missing`);
    return element;
  }

  it("starts on the length field, contains focus, and restores the trigger after Escape", async () => {
    const dialog = control<HTMLElement>("pt-fades-dialog");
    const length = control<HTMLInputElement>("pt-fades-length");
    expect(dialog.getAttribute("aria-modal")).toBe("true");
    expect(document.activeElement).toBe(length);

    length.dispatchEvent(new KeyboardEvent("keydown", {
      key: "Tab",
      shiftKey: true,
      bubbles: true,
    }));
    expect(dialog.contains(document.activeElement)).toBe(true);

    await act(async () => window.dispatchEvent(new KeyboardEvent("keydown", {
      key: "Escape",
      bubbles: true,
    })));
    expect(onClose).toHaveBeenCalledTimes(1);
    act(() => root.render(null));
    expect(document.activeElement).toBe(trigger);
  });

  it("applies edge fades and the exact overlap curves as one atomic edit", async () => {
    const length = control<HTMLInputElement>("pt-fades-length");
    const curveIn = control<HTMLSelectElement>("pt-fades-curve-in");
    const curveOut = control<HTMLSelectElement>("pt-fades-curve-out");
    act(() => {
      setValue(length, "25");
      setValue(curveIn, "convex");
      setValue(curveOut, "concave");
    });

    await act(async () => control<HTMLButtonElement>("pt-fades-apply").click());

    expect(runAtomic).toHaveBeenCalledWith("create fades", expect.any(Function));
    expect(exec.mock.calls).toEqual([
      ["set_clip_crossfade", { clipId: OUTGOING.id, enabled: false }],
      ["set_clip_crossfade", { clipId: INCOMING.id, enabled: false }],
      ["set_clip_fade", {
        clipId: OUTGOING.id,
        fadeInSec: 0.025,
        fadeOutSec: 1,
        curveIn: "convex",
        curveOut: "concave",
      }],
      ["set_clip_fade", {
        clipId: INCOMING.id,
        fadeInSec: 1,
        fadeOutSec: 0.025,
        curveIn: "convex",
        curveOut: "concave",
      }],
    ]);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("keeps a rejected command visible and invalidates drafts when the project changes", async () => {
    exec.mockImplementation(async (command: string): Promise<CommandResult> => (
      command === "set_clip_fade"
        ? { ok: false, command, error: "clip is locked by Ada" }
        : { ok: true, command }
    ));
    await act(async () => control<HTMLButtonElement>("pt-fades-apply").click());
    expect(control<HTMLElement>("pt-fades-error").textContent).toContain("locked by Ada");
    expect(onClose).not.toHaveBeenCalled();

    act(() => useStore.setState({ projectEpoch: 72 }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});

function setValue(control: HTMLInputElement | HTMLSelectElement, value: string): void {
  const prototype = control instanceof HTMLInputElement
    ? HTMLInputElement.prototype
    : HTMLSelectElement.prototype;
  const descriptor = Object.getOwnPropertyDescriptor(prototype, "value");
  descriptor?.set?.call(control, value);
  control.dispatchEvent(new Event("change", { bubbles: true }));
  control.dispatchEvent(new Event("input", { bubbles: true }));
}
