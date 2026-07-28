import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach } from "vitest";
import { LaneMenu } from "./LaneMenu";
import { describe, it, expect, beforeEach } from "vitest";
import { EditorAction as A } from "../../interaction/actions";
import { resolveGesture } from "../../interaction/gestures";
import { getGestureTable } from "../../interaction/gestureTables";
import { resolveLaneNew } from "./laneNew";

// The lane handler is the composition of three already-tested pieces: the resolver says
// WHICH action, resolveLaneNew says WHICH outcome, and the handler runs it. These tests
// pin the composition (and the guards around it) without mounting the whole timeline.

const TABLE = () => getGestureTable("mosh");

describe("lane gesture composition", () => {
  it("dblclick on empty resolves to LANE_NEW", () => {
    expect(resolveGesture(TABLE(), { region: "empty", gesture: "dblclick", mods: {} })).toBe(A.LANE_NEW);
  });

  it("an instrument track double-clicked yields a clip; a bare one yields the menu", () => {
    expect(resolveLaneNew({ isInstrument: true })).toEqual({ kind: "clip" });
    expect(resolveLaneNew({ isInstrument: false })).toEqual({ kind: "menu" });
  });

  it("right-click on empty resolves to CONTEXT_MENU regardless of track state", () => {
    expect(resolveGesture(TABLE(), { region: "empty", gesture: "contextmenu", mods: {} })).toBe(A.CONTEXT_MENU);
  });
});

describe("LaneMenu", () => {
  let host: HTMLDivElement;
  let root: Root;
  // The menu portals to document.body, so query the DOCUMENT, not the host.
  const q = (id: string) => document.querySelector(`[data-testid="${id}"]`) as HTMLElement | null;

  beforeEach(() => {
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    host = document.createElement("div"); document.body.appendChild(host); root = createRoot(host);
  });
  afterEach(() => { act(() => root.unmount()); host.remove(); });

  const mount = async (isInstrument: boolean) => {
    const track = { id: "t1", name: "Inst", type: "audio", clips: [], plugins: [], isInstrument } as never;
    await act(async () => {
      root.render(React.createElement(LaneMenu, { x: 0, y: 0, track, start: 0, barLen: 2, onClose: () => {} }));
    });
  };

  it("offers instrument, import and MIDI-clip actions on a bare track", async () => {
    await mount(false);
    expect(q("lane-add-instrument")?.textContent).toBe("Add instrument…");
    expect(q("lane-import-audio")).toBeTruthy();
    expect(q("lane-add-midi-clip")).toBeTruthy();
  });

  it("says SWAP once the track already hosts a synth", async () => {
    await mount(true);
    expect(q("lane-add-instrument")?.textContent).toBe("Swap instrument…");
  });
});
