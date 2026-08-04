// CAP-CLP-017 — the RIPPLE mode is modal, and the mode is the risk.
//
// Two of the four reference DAWs (Pro Tools' Shuffle, Reaper's ripple) make ripple a MODE
// rather than a per-drag modifier, and both make that mode visible, because a ripple drag
// rearranges material the producer usually cannot see. So the properties pinned here are
// not "the toggle toggles" — they are the three that make the mode safe:
//
//   1. it is OFF on a cold start (nobody inherits a destructive mode);
//   2. while it is ON the shell SAYS SO in text, not colour alone (a lit chip that only
//      differs by hue tells a producer who cannot resolve it nothing at all); and
//   3. it never crosses the bridge on its own — it is view state, and the backend hears
//      about it only as an argument on the command a real gesture issues.
//
// The gesture wiring itself (move_clip/trim_clip picking the flag up) lives in
// ui/src/ui/clipDrag.test.ts; the engine behaviour lives in `Mosh --selftest`.

import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TopBar } from "./TopBar";
import { useStore } from "../store";
import type { CommandResult, Snapshot } from "../types";

vi.mock("../ui/TopbarTools", () => ({
  TrainingTool: () => null,
  CommandLogTool: () => null,
  RemoteTool: () => null,
  MultiplayerTool: () => null,
  HelpTool: () => null,
  MemoryTool: () => null,
}));

function makeSnapshot(): Snapshot {
  return {
    schemaVersion: 1,
    session: {
      sampleRate: 48000, tempo: 120, timeSigNumerator: 4, timeSigDenominator: 4,
      metronome: false, key: { tonic: "C", mode: "major" }, length: 16,
      editFile: "/mock/song.mosh",
    },
    tracks: [],
  } as unknown as Snapshot;
}

describe("v2 TopBar — ripple edit mode is modal and visible", () => {
  let host: HTMLDivElement;
  let root: Root;
  const execCalls: { command: string; args?: Record<string, unknown> }[] = [];

  beforeEach(() => {
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    execCalls.length = 0;
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
    useStore.setState({
      snap: true,
      snapDivision: "1/4",
      ripple: false,
      exec: vi.fn(async (command: string, args?: Record<string, unknown>): Promise<CommandResult> => {
        execCalls.push({ command, args });
        return { ok: true, command };
      }),
    });
  });

  afterEach(() => {
    act(() => root.unmount());
    host.remove();
    useStore.setState({ ripple: false });
  });

  const render = () => act(() => { root.render(React.createElement(TopBar, { snapshot: makeSnapshot() })); });
  const chip = () => host.querySelector<HTMLButtonElement>('[data-testid="v2-ripple"]');

  // getInitialState(), NOT getState(): this suite's own beforeEach writes ripple:false,
  // so getState() would be asserting the fixture back to itself. Flipping the store's
  // real default to `true` left the getState() version of this test GREEN — the exact
  // "a test that cannot fail looks like one that passes" shape. getInitialState() reads
  // the value the store was created with, which is the thing that actually ships.
  it("ripple is OFF in the store's shipped default, not merely in this fixture", () => {
    expect(useStore.getInitialState().ripple, "a destructive mode must never default on").toBe(false);
  });

  it("ships a reachable control that renders the store's current (off) state", () => {
    render();
    expect(chip(), "a mouse-only producer must have a ripple control in the shipped shell").not.toBeNull();
    expect(chip()!.getAttribute("aria-pressed")).toBe("false");
    expect(chip()!.dataset.on).toBe("false");
  });

  it("says it is on in TEXT, not by colour alone", () => {
    render();
    const off = chip()!.textContent ?? "";
    act(() => { chip()!.click(); });
    expect(useStore.getState().ripple).toBe(true);
    const on = chip()!.textContent ?? "";
    expect(on, "the label must change when the mode is armed").not.toBe(off);
    expect(on.toLowerCase()).toContain("on");
    expect(chip()!.getAttribute("aria-pressed")).toBe("true");
    expect(chip()!.dataset.on).toBe("true");
    // …and the title explains what it will do, not just that it is on.
    expect(chip()!.title.toLowerCase()).toContain("later clip");
  });

  it("toggles back off", () => {
    useStore.setState({ ripple: true });
    render();
    act(() => { chip()!.click(); });
    expect(useStore.getState().ripple).toBe(false);
  });

  it("never crosses the bridge on its own — arming a mode is not an edit", () => {
    render();
    act(() => { chip()!.click(); });
    act(() => { chip()!.click(); });
    expect(execCalls, "the ripple toggle is UI-local view state, like snap").toEqual([]);
  });
});
