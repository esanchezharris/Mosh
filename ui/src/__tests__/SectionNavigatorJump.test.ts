// FU-SECTIONNAV — jump-to-section must resolve beats→seconds through the canonical,
// denominator-aware time.ts helpers (meterFrom/beatSeconds), not a naive `60 / tempo`
// (which silently assumes x/4 and lands on the wrong time for any x/8, x/2, etc. meter —
// the same math geom.ts's beatToSec and exportSection.ts's resolveSectionExportRange use).

import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SectionNavigator } from "../ui/SectionNavigator";
import { useStore } from "../store";
import type { CommandResult, Snapshot } from "../types";

function makeSnapshot(overrides: Partial<Snapshot["session"]> = {}): Snapshot {
  return {
    schemaVersion: 1,
    session: {
      sampleRate: 48000,
      tempo: 120,
      key: { root: "C", scale: "major" },
      editFile: "/proj/song.mosh",
      dirty: false,
      ...overrides,
    },
    tracks: [],
    transport: { playing: false, position: 0 },
    sections: [{ id: "sec1", name: "Hook", startBeat: 8, endBeat: 16 }],
  } as unknown as Snapshot;
}

describe("FU-SECTIONNAV — SectionNavigator jump respects the time-sig denominator", () => {
  let host: HTMLDivElement;
  let root: Root;
  const originalExec = useStore.getState().exec;
  let execCalls: { command: string; args?: Record<string, unknown> }[];

  beforeEach(() => {
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    execCalls = [];
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
    useStore.setState({
      exec: vi.fn(async (command: string, args?: Record<string, unknown>): Promise<CommandResult> => {
        execCalls.push({ command, args });
        return { ok: true, command };
      }),
    });
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    host.remove();
    useStore.setState({ exec: originalExec });
    vi.restoreAllMocks();
  });

  async function clickJump(snapshot: Snapshot) {
    await act(async () => {
      root.render(React.createElement(SectionNavigator, { snapshot }));
    });
    const jumpBtn = host.querySelector<HTMLButtonElement>(".section-jump");
    expect(jumpBtn).not.toBeNull();
    await act(async () => {
      jumpBtn!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await act(async () => {});
  }

  it("120bpm / 4-4 (the default meter): startBeat 8 -> 4s (60/120 = 0.5s/beat)", async () => {
    await clickJump(makeSnapshot());
    expect(execCalls).toContainEqual({
      command: "set_transport",
      args: { action: "seek", position: 4 },
    });
  });

  it("120bpm / 6-8: startBeat 8 -> 2s, NOT the 4s a naive 60/tempo would give", async () => {
    // den:8 -> beatSeconds = (4/8) * (60/120) = 0.25s/beat -> startBeat 8 = 2s.
    // The old `60 / tempo` (ignoring the denominator) would have produced 4s here —
    // this assertion would FAIL against that implementation.
    await clickJump(makeSnapshot({ timeSigNumerator: 6, timeSigDenominator: 8 }));
    expect(execCalls).toContainEqual({
      command: "set_transport",
      args: { action: "seek", position: 2 },
    });
  });
});
