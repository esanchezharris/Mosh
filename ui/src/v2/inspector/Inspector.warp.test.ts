// G9 — the clip Inspector's Warp tab (audio warp / time-stretch).
//
// A wave clip gets a "Warp" tab carrying a warp toggle + a stretch-mode select, both
// wired to set_clip_warp. Pure command-surface assertions (store.exec) — no engine
// concepts leak. MIDI clips have no Warp tab. Heavy sibling panels (FX/Gen/Lyrics) are
// stubbed so the render stays focused on the Warp surface.

import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Inspector } from "./Inspector";
import { useStore } from "../../store";
import { useShell } from "../shellState";
import type { CommandResult, Clip, Snapshot, Track } from "../../types";

// Keep the render scoped to the Warp tab — stub the tabs that pull the classic Dock
// (Rack/GenDrawer), the Lyrics panel, and the drum-window store.
vi.mock("../../ui/Dock", () => ({ Rack: () => null, GenDrawer: () => null }));
vi.mock("./LyricPanel", () => ({ LyricPanel: () => null }));
vi.mock("../../ui/dock/useFloatingWindow", () => ({
  useDrumWindow: { getState: () => ({ open: () => {} }) },
}));

function waveClip(over?: Partial<Clip>): Clip {
  return { id: "c1", name: "chords", type: "wave", start: 0, length: 4, offset: 0, hasRenderLayer: false, ...over };
}
function midiClip(over?: Partial<Clip>): Clip {
  return { id: "m1", name: "loop", type: "midi", start: 0, length: 4, offset: 0, hasRenderLayer: false, notes: [], ...over };
}
function makeSnapshot(clip: Clip): Snapshot {
  const track: Track = {
    id: "t1", index: 0, name: "Keys", type: "audio",
    volumeDb: 0, pan: 0, mute: false, solo: false, clips: [clip], plugins: [],
  } as unknown as Track;
  return { schemaVersion: 1, session: {}, tracks: [track] } as unknown as Snapshot;
}

describe("v2 Inspector Warp tab", () => {
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
      selectedTrackId: "t1",
      exec: vi.fn(async (command: string, args?: Record<string, unknown>): Promise<CommandResult> => {
        execCalls.push({ command, args });
        return { ok: true, command };
      }),
    });
    useShell.setState({ selectedClipId: "c1", inspectorTab: "warp" });
  });

  afterEach(() => {
    act(() => root.unmount());
    host.remove();
    useShell.setState({ selectedClipId: null, inspectorTab: "mix" });
  });

  function render(snap: Snapshot) {
    act(() => {
      useStore.setState({ snapshot: snap });
      root.render(React.createElement(Inspector));
    });
  }

  it("shows a Warp tab for a wave clip and none for a MIDI clip", () => {
    render(makeSnapshot(waveClip()));
    expect(host.querySelector('[data-testid="v2-insp-tab-warp"]')).not.toBeNull();

    act(() => useShell.setState({ selectedClipId: "m1", inspectorTab: "warp" }));
    render(makeSnapshot(midiClip()));
    expect(host.querySelector('[data-testid="v2-insp-tab-warp"]')).toBeNull();
  });

  it("clicking the warp toggle execs set_clip_warp with the flipped autoTempo", () => {
    render(makeSnapshot(waveClip({ autoTempo: false })));
    const toggle = host.querySelector<HTMLButtonElement>('[data-testid="v2-warp-toggle"]');
    expect(toggle).not.toBeNull();
    expect(toggle!.getAttribute("aria-pressed")).toBe("false");
    act(() => toggle!.dispatchEvent(new MouseEvent("click", { bubbles: true })));
    const call = execCalls.find((c) => c.command === "set_clip_warp");
    expect(call).toBeTruthy();
    expect(call!.args).toMatchObject({ clipId: "c1", autoTempo: true });
  });

  it("reflects an enabled warp (aria-pressed) and enables the stretch-mode select", () => {
    render(makeSnapshot(waveClip({ autoTempo: true, stretchMode: "SoundTouch (Normal)" })));
    const toggle = host.querySelector<HTMLButtonElement>('[data-testid="v2-warp-toggle"]');
    expect(toggle!.getAttribute("aria-pressed")).toBe("true");
    const select = host.querySelector<HTMLSelectElement>('[data-testid="v2-warp-mode"]');
    expect(select).not.toBeNull();
    expect(select!.disabled).toBe(false);
    expect(select!.value).toBe("SoundTouch (Normal)");
  });

  it("the stretch-mode select is disabled while warp is off", () => {
    render(makeSnapshot(waveClip({ autoTempo: false })));
    const select = host.querySelector<HTMLSelectElement>('[data-testid="v2-warp-mode"]');
    expect(select!.disabled).toBe(true);
  });

  it("changing the stretch mode execs set_clip_warp with autoTempo:true and the mode", () => {
    render(makeSnapshot(waveClip({ autoTempo: true, stretchMode: "SoundTouch (Better)" })));
    const select = host.querySelector<HTMLSelectElement>('[data-testid="v2-warp-mode"]');
    act(() => {
      select!.value = "SoundTouch (Normal)";
      select!.dispatchEvent(new Event("change", { bubbles: true }));
    });
    const call = execCalls.find((c) => c.command === "set_clip_warp");
    expect(call).toBeTruthy();
    expect(call!.args).toMatchObject({ clipId: "c1", autoTempo: true, mode: "SoundTouch (Normal)" });
  });
});
