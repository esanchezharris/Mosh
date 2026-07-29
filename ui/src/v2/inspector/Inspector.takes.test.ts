// The clip Inspector's Takes tab (wave clip with >1 recorded take).
//
// A wave clip with a native take tree gets a "Takes" tab: one button per take, the
// current one carrying a visual `on` highlight. This asserts the SELECTED state is
// exposed to assistive tech via aria-pressed (the v2 house pattern — Mix Mute/Solo,
// Warp toggle) so a screen-reader user can tell which take plays, not just sighted
// users. Heavy sibling panels (FX/Gen/Lyrics) are stubbed to keep the render focused.

import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Inspector } from "./Inspector";
import { useStore } from "../../store";
import { useShell } from "../shellState";
import type { CommandResult, Clip, Snapshot, Track } from "../../types";

// Stub the tabs that pull the classic Dock (Rack/GenDrawer), the Lyrics panel, and
// the drum-window store — mirrors the Warp-tab harness.
vi.mock("../../ui/Rack", () => ({ Rack: () => null }));
vi.mock("../../ui/GenDrawer", () => ({ GenDrawer: () => null }));
vi.mock("./LyricPanel", () => ({ LyricPanel: () => null }));
vi.mock("../../ui/dock/useFloatingWindow", () => ({
  useDrumWindow: { getState: () => ({ open: () => {} }) },
}));

function takesClip(over?: Partial<Clip>): Clip {
  return {
    id: "c1", name: "vox", type: "wave", start: 0, length: 4, offset: 0, hasRenderLayer: false,
    numTakes: 3, currentTakeIndex: 1,
    takes: [
      { index: 0, isCurrent: false },
      { index: 1, isCurrent: true },
      { index: 2, isCurrent: false },
    ],
    ...over,
  };
}
function makeSnapshot(clip: Clip): Snapshot {
  const track: Track = {
    id: "t1", index: 0, name: "Vocals", type: "audio",
    volumeDb: 0, pan: 0, mute: false, solo: false, clips: [clip], plugins: [],
  } as unknown as Track;
  return { schemaVersion: 1, session: {}, tracks: [track] } as unknown as Snapshot;
}

describe("v2 Inspector Takes tab", () => {
  let host: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
    useStore.setState({
      selectedTrackId: "t1",
      exec: vi.fn(async (command: string): Promise<CommandResult> => ({ ok: true, command })),
    });
    useShell.setState({ selectedClipId: "c1", inspectorTab: "takes" });
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

  it("exposes the current take's selected state via aria-pressed", () => {
    render(makeSnapshot(takesClip()));
    const takeBtns = Array.from(host.querySelectorAll<HTMLButtonElement>("button.v2-take"));
    expect(takeBtns.length).toBe(3);
    const current = takeBtns.find((b) => b.classList.contains("on"))!;
    const other = takeBtns.find((b) => !b.classList.contains("on"))!;
    expect(current).toBeTruthy();
    expect(other).toBeTruthy();
    expect(current.getAttribute("aria-pressed")).toBe("true");
    expect(other.getAttribute("aria-pressed")).toBe("false");
  });

  it("hides the decorative current-take dot from assistive tech", () => {
    render(makeSnapshot(takesClip()));
    const dot = host.querySelector("button.v2-take .cur");
    expect(dot).not.toBeNull();
    expect(dot!.getAttribute("aria-hidden")).toBe("true");
  });
});
