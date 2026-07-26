// UI-REACH (sketch_beatbox) — the bpm/bars confirmation dialog. Requirement #4 of the
// backlog item: validate bpm/bars in the UI so the engine's own rejection
// ("bpm must be 20..300") never has to surface as an error toast. Pure command-surface
// assertions (store.exec) — no engine concepts leak. Rendered standalone (mirrors
// RightRail.master.test.ts's posture for a small, self-contained control).

import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SketchBeatboxDialog, sketchBpmValid } from "./SketchBeatboxDialog";
import { useStore } from "../store";
import type { CommandResult, Snapshot } from "../types";

const nativeInputValueSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")!.set!;
function setInputValue(input: HTMLInputElement, value: string): void {
  nativeInputValueSetter.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

function makeSnapshot(tempo = 120): Snapshot {
  return { schemaVersion: 1, session: { tempo }, tracks: [] } as unknown as Snapshot;
}

describe("sketchBpmValid (pure)", () => {
  it("accepts the boundary values 20 and 300", () => {
    expect(sketchBpmValid("20")).toBe(true);
    expect(sketchBpmValid("300")).toBe(true);
  });
  it("rejects just outside the boundary", () => {
    expect(sketchBpmValid("19")).toBe(false);
    expect(sketchBpmValid("301")).toBe(false);
  });
  it("rejects empty, non-numeric, and whitespace-only input", () => {
    expect(sketchBpmValid("")).toBe(false);
    expect(sketchBpmValid("   ")).toBe(false);
    expect(sketchBpmValid("fast")).toBe(false);
  });
});

describe("SketchBeatboxDialog", () => {
  let host: HTMLDivElement;
  let root: Root;
  let onClose: ReturnType<typeof vi.fn>;
  const execCalls: { command: string; args?: Record<string, unknown> }[] = [];

  beforeEach(() => {
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    execCalls.length = 0;
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
    onClose = vi.fn();
    useStore.setState({
      snapshot: makeSnapshot(140),
      exec: vi.fn(async (command: string, args?: Record<string, unknown>): Promise<CommandResult> => {
        execCalls.push({ command, args });
        return { ok: true, command };
      }),
    });
  });

  afterEach(() => { act(() => root.unmount()); host.remove(); });

  const render = (file = "/tmp/boombap.wav") =>
    act(() => { root.render(React.createElement(SketchBeatboxDialog, { file, onClose })); });
  const bpmInput = () => document.querySelector('[data-testid="sketch-bpm-input"]') as HTMLInputElement;
  const confirmBtn = () => document.querySelector('[data-testid="sketch-beatbox-confirm"]') as HTMLButtonElement;
  const hint = () => document.querySelector('[data-testid="sketch-bpm-hint"]');

  it("defaults the tempo field to the PROJECT's own tempo, not a hardcoded guess", () => {
    render();
    expect(bpmInput().value).toBe("140");
  });

  it("names the source file (sans path) so the user knows which take this is", () => {
    render("/Users/you/Music/boombap take 2.wav");
    // Rendered via createPortal to document.body (matches ClipMenu's precedent, so the
    // plain `.modal`/`.btn` styles apply rather than the browser-dock's scoped overrides
    // this dialog isn't nested under) — assert against the portaled node, not `host`.
    const dialog = document.querySelector('[data-testid="sketch-beatbox-dialog"]')!;
    expect(dialog.textContent).toContain("boombap take 2.wav");
    expect(dialog.textContent).not.toContain("/Users/you/Music/");
  });

  it("dispatches sketch_beatbox with wait:false and closes on confirm", () => {
    render();
    act(() => setInputValue(bpmInput(), "128"));
    act(() => confirmBtn().dispatchEvent(new MouseEvent("click", { bubbles: true })));
    expect(execCalls).toEqual([
      { command: "sketch_beatbox", args: { file: "/tmp/boombap.wav", bpm: 128, bars: 1, wait: false } },
    ]);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("bars toggles between 1 and 2 (the engine's own clamp — never a free-text third option)", () => {
    render();
    const bars2 = document.querySelector('[data-testid="sketch-bars-2"]') as HTMLButtonElement;
    act(() => bars2.dispatchEvent(new MouseEvent("click", { bubbles: true })));
    act(() => confirmBtn().dispatchEvent(new MouseEvent("click", { bubbles: true })));
    expect(execCalls[0].args).toMatchObject({ bars: 2 });
  });

  it("an out-of-range bpm disables confirm, shows the hint, and NEVER reaches exec — " +
     "the engine's own 'bpm must be 20..300' rejection must not surface as an error toast", () => {
    render();
    act(() => setInputValue(bpmInput(), "400"));
    expect(confirmBtn().disabled).toBe(true);
    expect(hint()).not.toBeNull();
    act(() => confirmBtn().dispatchEvent(new MouseEvent("click", { bubbles: true })));
    expect(execCalls).toEqual([]);
    expect(onClose).not.toHaveBeenCalled();
  });

  it("re-entering a valid bpm re-enables confirm and clears the hint", () => {
    render();
    act(() => setInputValue(bpmInput(), "400"));
    expect(confirmBtn().disabled).toBe(true);
    act(() => setInputValue(bpmInput(), "128"));
    expect(confirmBtn().disabled).toBe(false);
    expect(hint()).toBeNull();
  });

  it("Cancel closes without dispatching anything", () => {
    render();
    const cancel = [...document.querySelectorAll("button")].find((b) => b.textContent === "Cancel")!;
    act(() => cancel.dispatchEvent(new MouseEvent("click", { bubbles: true })));
    expect(execCalls).toEqual([]);
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
