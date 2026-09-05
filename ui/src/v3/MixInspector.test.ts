import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MixInspector, inspectorHasForbiddenTabs } from "./MixInspector";
import { useStore } from "../store";
import type { CommandResult, Plugin, Snapshot, Track } from "../types";

vi.mock("../ui/GenDrawer", () => ({ GenDrawer: () => React.createElement("div", { "data-testid": "v3-gen" }, "gen") }));

function snapshot(): Snapshot {
  const plugin = {
    index: 0, name: "Serum", type: "VST3", enabled: true, external: true, isInstrument: true, params: [],
  } as Plugin;
  const track = {
    id: "t1", index: 0, name: "Keys", type: "audio", volumeDb: 0, pan: 0,
    mute: false, solo: false, clips: [], plugins: [plugin],
  } as unknown as Track;
  return { schemaVersion: 1, session: { sampleRate: 48000, tempo: 120, length: 16 }, tracks: [track] } as unknown as Snapshot;
}

describe("v3 Mix inspector", () => {
  let host: HTMLDivElement;
  let root: Root;
  const calls: { command: string; args?: Record<string, unknown> }[] = [];

  beforeEach(() => {
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    calls.length = 0;
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
    useStore.setState({
      snapshot: snapshot(),
      selectedTrackId: "t1",
      waveInputs: null,
      midiInputs: null,
      trackOutputs: null,
      exec: vi.fn(async (command: string, args?: Record<string, unknown>): Promise<CommandResult> => {
        calls.push({ command, args });
        return { ok: true, command };
      }),
      loadRouting: vi.fn(async () => {}),
      loadMidiInputs: vi.fn(async () => {}),
    });
  });

  afterEach(() => {
    act(() => root.unmount());
    host.remove();
  });

  it("is Mix-only stacked sections with no FX/Lyrics tabs", () => {
    act(() => root.render(React.createElement(MixInspector, { snapshot: snapshot() })));
    expect(host.querySelector('[data-testid="v3-inspector"]')).not.toBeNull();
    expect(host.querySelector('[role="tablist"]')).toBeNull();
    expect(inspectorHasForbiddenTabs(host)).toBe(false);
    expect(host.textContent).toMatch(/Levels/);
    expect(host.textContent).toMatch(/Generative/);
    expect(host.textContent).toMatch(/Sends/);
    expect(host.textContent).toMatch(/Plugins/);
  });

  it("Open Editor calls open_plugin_editor", () => {
    act(() => root.render(React.createElement(MixInspector, { snapshot: snapshot() })));
    const btn = host.querySelector<HTMLButtonElement>('[data-testid="v3-open-editor"]');
    expect(btn).not.toBeNull();
    act(() => btn!.click());
    expect(calls).toContainEqual({ command: "open_plugin_editor", args: { trackId: "t1", index: 0 } });
  });
});
