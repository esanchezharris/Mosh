import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DrumSequencer } from "./DrumSequencer";
import { useStore } from "../store";
import type { Clip, CommandResult, Snapshot } from "../types";

vi.mock("../bridge", async () => {
  const actual = await vi.importActual<typeof import("../bridge")>("../bridge");
  return {
    ...actual,
    pickFiles: vi.fn(async () => ({ ok: false, files: [] })),
  };
});

function makeSnapshot(): Snapshot {
  return {
    schemaVersion: 1,
    session: {
      sampleRate: 48000,
      tempo: 120,
      timeSigNumerator: 4,
      timeSigDenominator: 4,
      metronome: false,
      length: 16,
      editFile: "/mock/song.mosh",
      key: { tonic: "C", mode: "major" },
    },
    tracks: [
      {
        id: "t1",
        index: 0,
        name: "Drums",
        type: "drum",
        clips: [],
      },
    ],
  } as unknown as Snapshot;
}

describe("DrumSequencer swing batching", () => {
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
      snapshot: makeSnapshot(),
      exec: vi.fn(async (command: string, args?: Record<string, unknown>): Promise<CommandResult> => {
        execCalls.push({ command, args });
        return { ok: true, command };
      }),
    });
  });

  afterEach(() => {
    act(() => root.unmount());
    host.remove();
    vi.unstubAllGlobals();
  });

  it("does not create an undo batch when swing changes nothing", () => {
    const clip: Clip = {
      id: "clip-1",
      name: "beat",
      type: "midi",
      start: 0,
      length: 4,
      offset: 0,
      hasRenderLayer: false,
      notes: [],
    };

    act(() => {
      root.render(React.createElement(DrumSequencer, { clip }));
    });
    act(() => {
      [...host.querySelectorAll("button")].find((b) => b.textContent?.includes("Apply Swing"))?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    expect(execCalls).toEqual([]);
  });
});
