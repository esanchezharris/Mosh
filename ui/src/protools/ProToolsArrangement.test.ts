import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Snapshot } from "../types";
import { useProTools } from "./proToolsState";
import { ProToolsArrangement } from "./ProToolsArrangement";

vi.mock("./ProToolsClipList", () => ({ ProToolsClipList: () => React.createElement("aside") }));
vi.mock("./ProToolsRulers", () => ({ ProToolsRulers: () => React.createElement("div") }));
vi.mock("./ProToolsTimeline", () => ({ ProToolsTimeline: () => React.createElement("div") }));
vi.mock("./ProToolsTrackHeaders", () => ({ ProToolsTrackHeaders: () => React.createElement("div") }));

const SNAPSHOT: Snapshot = {
  schemaVersion: 1,
  session: {
    sampleRate: 48_000,
    tempo: 120,
    editFile: "/tmp/protools-arrangement.mosh",
    key: { tonic: "C", mode: "major" },
  },
  tracks: [],
  transport: { playing: false, recording: false, position: 0, looping: false, loopStart: 0, loopEnd: 0 },
};

describe("ProToolsArrangement compact behavior", () => {
  let host: HTMLDivElement;
  let root: Root;
  let compact = true;
  let changeListener: (() => void) | undefined;

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
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
  });

  afterEach(() => {
    act(() => root.unmount());
    host.remove();
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
});
