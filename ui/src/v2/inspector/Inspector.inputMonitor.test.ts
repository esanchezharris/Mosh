// UI-REACH — set_input_monitor. The snapshot already carried track.monitor
// (off|automatic|on, types.ts) and cmdSetInputMonitor was complete backend-side, but
// nothing in either shell ever called it. A "Monitor" select now sits in the v2
// Inspector's Mix tab beside MidiInputField/OutputField.
//
// Two things this control must not get wrong, both covered below:
//  - it is DEVICE-level (every track fed by the same physical input shares one
//    monitor mode) — the select's title says so, this isn't asserted by DOM content
//    alone since it's a tooltip, but the presence of that caveat is checked.
//  - `applied:false` (no input device instance targets this track) is `ok:true` and
//    would NOT trip the store's normal lastError banner, so it needs its own inline
//    surfacing — silently doing nothing would be worse than a control that says so.
//
// Same createRoot + act render harness as the sibling Inspector.clip.test.ts.

import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Inspector } from "./Inspector";
import { useStore } from "../../store";
import { useShell } from "../shellState";
import type { CommandResult, Snapshot, Track } from "../../types";

vi.mock("../../ui/Dock", () => ({ Rack: () => null, GenDrawer: () => null }));
vi.mock("./LyricPanel", () => ({ LyricPanel: () => null }));
vi.mock("../../ui/dock/useFloatingWindow", () => ({
  useDrumWindow: { getState: () => ({ open: () => {} }) },
}));

function makeSnapshot(track: Partial<Track>): Snapshot {
  const t: Track = { id: "t1", index: 0, name: "Keys", type: "audio", volumeDb: 0, pan: 0, mute: false, solo: false, clips: [], plugins: [], ...track } as unknown as Track;
  return { schemaVersion: 1, session: {}, tracks: [t] } as unknown as Snapshot;
}

describe("v2 Inspector Mix tab — input monitor (UI-REACH set_input_monitor)", () => {
  let host: HTMLDivElement;
  let root: Root;
  const execCalls: { command: string; args?: Record<string, unknown> }[] = [];
  let execImpl: (command: string, args?: Record<string, unknown>) => Promise<CommandResult>;

  beforeEach(() => {
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    execCalls.length = 0;
    execImpl = async (command, args) => { execCalls.push({ command, args }); return { ok: true, command }; };
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
    useStore.setState({
      selectedTrackId: "t1",
      exec: vi.fn((command: string, args?: Record<string, unknown>) => execImpl(command, args)),
    });
    useShell.setState({ selectedClipId: null, inspectorTab: "mix" });
  });

  afterEach(() => {
    act(() => root.unmount());
    host.remove();
  });

  function render(snap: Snapshot) {
    act(() => {
      useStore.setState({ snapshot: snap });
      root.render(React.createElement(Inspector));
    });
  }

  it("shows a Monitor select on the Mix tab, defaulting to automatic when unset", () => {
    render(makeSnapshot({}));
    const select = host.querySelector<HTMLSelectElement>('[data-testid="v2-input-monitor"]');
    expect(select).not.toBeNull();
    expect(select!.value).toBe("automatic");
  });

  it("reflects an already-set monitor mode from the snapshot", () => {
    render(makeSnapshot({ monitor: "on" }));
    const select = host.querySelector<HTMLSelectElement>('[data-testid="v2-input-monitor"]');
    expect(select!.value).toBe("on");
  });

  it("names the device-level scope in its title, so it never reads as per-track-independent", () => {
    render(makeSnapshot({}));
    const select = host.querySelector<HTMLSelectElement>('[data-testid="v2-input-monitor"]');
    expect(select!.title.toLowerCase()).toContain("every track");
  });

  it("changing the select execs set_input_monitor with the track id and chosen mode", () => {
    render(makeSnapshot({}));
    const select = host.querySelector<HTMLSelectElement>('[data-testid="v2-input-monitor"]')!;
    act(() => {
      select.value = "on";
      select.dispatchEvent(new Event("change", { bubbles: true }));
    });
    const call = execCalls.find((c) => c.command === "set_input_monitor");
    expect(call).toBeTruthy();
    expect(call!.args).toMatchObject({ trackId: "t1", mode: "on" });
  });

  it("shows no warning when the backend applied the change", async () => {
    render(makeSnapshot({}));
    const select = host.querySelector<HTMLSelectElement>('[data-testid="v2-input-monitor"]')!;
    await act(async () => {
      select.value = "on";
      select.dispatchEvent(new Event("change", { bubbles: true }));
      await Promise.resolve();
    });
    expect(host.querySelector('[data-testid="v2-input-monitor-warn"]')).toBeNull();
  });

  it("surfaces applied:false inline instead of silently doing nothing (ok:true would not trip the global error banner)", async () => {
    execImpl = async (command, args) => {
      execCalls.push({ command, args });
      if (command === "set_input_monitor")
        return { ok: true, command, data: { trackId: "t1", mode: "on", applied: false, reason: "no input device" } };
      return { ok: true, command };
    };
    render(makeSnapshot({}));
    const select = host.querySelector<HTMLSelectElement>('[data-testid="v2-input-monitor"]')!;
    await act(async () => {
      select.value = "on";
      select.dispatchEvent(new Event("change", { bubbles: true }));
      await Promise.resolve();
    });
    const warn = host.querySelector('[data-testid="v2-input-monitor-warn"]');
    expect(warn).not.toBeNull();
    expect(warn!.textContent).toContain("no input device");
  });
});
