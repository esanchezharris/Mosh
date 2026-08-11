import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useStore } from "../store";
import { sendLevelKey, type Snapshot, type Track } from "../types";
import { ProToolsMixSends } from "./ProToolsMixSends";

const TRACK: Track = {
  id: "vocal",
  index: 0,
  name: "Lead Vocal",
  type: "audio",
  clips: [],
  sends: [{ bus: 1, db: -8, pan: 0.2, mute: false, preFader: false }],
};

const SNAPSHOT: Snapshot = {
  schemaVersion: 1,
  session: {
    sampleRate: 48_000,
    tempo: 120,
    editFile: "/tmp/protools-mix-send-meter.mosh",
    key: { tonic: "C", mode: "major" },
  },
  tracks: [TRACK],
  buses: [{ bus: 1, name: "Plate", trackId: "plate-return" }],
  transport: {
    playing: false, recording: false, position: 0, looping: false, loopStart: 0, loopEnd: 0,
  },
};

describe("Pro Tools Mix send meter", () => {
  let host: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
    useStore.setState({
      sendLevels: { [sendLevelKey("vocal", 1)]: { l: -10, r: -12 } },
    });
    vi.stubGlobal("requestAnimationFrame", vi.fn(() => 1));
    vi.stubGlobal("cancelAnimationFrame", vi.fn());
  });

  afterEach(() => {
    act(() => root.unmount());
    host.remove();
    vi.unstubAllGlobals();
  });

  it("places one accessible stereo meter in the assigned send row", () => {
    act(() => root.render(React.createElement(ProToolsMixSends, {
      snapshot: SNAPSHOT,
      track: TRACK,
      targetTrackIds: [TRACK.id],
    })));

    const row = host.querySelector(".pt-mix-send-row");
    const meter = row?.querySelector<HTMLElement>('[role="meter"]');
    expect(meter?.getAttribute("aria-label")).toBe("Plate send output");
    expect(row?.querySelectorAll('[role="meter"]')).toHaveLength(1);
    expect(meter?.hasAttribute("aria-live")).toBe(false);
    expect(meter?.hasAttribute("tabindex")).toBe(false);
  });
});
