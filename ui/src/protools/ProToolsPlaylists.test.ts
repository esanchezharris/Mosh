import React, { act, useRef } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useStore } from "../store";
import type { CommandResult, Snapshot } from "../types";
import { ProToolsTimeline } from "./ProToolsTimeline";
import { ProToolsTrackHeaders } from "./ProToolsTrackHeaders";
import { useProTools } from "./proToolsState";

vi.mock("../bridge", async () => {
  const actual = await vi.importActual<typeof import("../bridge")>("../bridge");
  return { ...actual, onEvent: vi.fn(() => () => {}), pickFiles: vi.fn(), pickSaveFile: vi.fn() };
});

vi.mock("../ui/clipRenderers", async () => {
  const actual = await vi.importActual<typeof import("../ui/clipRenderers")>("../ui/clipRenderers");
  return {
    ...actual,
    ClipWave: ({ peaks }: { readonly peaks?: readonly (readonly [number, number])[] }) =>
      React.createElement("span", { "data-testid": "take-wave", "data-peaks": peaks?.length ?? 0 }),
  };
});

const SNAPSHOT: Snapshot = {
  schemaVersion: 1,
  session: {
    sampleRate: 48_000,
    tempo: 120,
    editFile: "/tmp/protools-playlists.mosh",
    key: { tonic: "C", mode: "major" },
  },
  tracks: [{
    id: "vocal-track",
    index: 0,
    name: "Lead Vocal",
    type: "audio",
    clips: [{
      id: "vocal-clip",
      name: "Lead Comp",
      type: "wave",
      start: 1,
      length: 4,
      offset: 0,
      sourceFile: "/tmp/lead.wav",
      hasRenderLayer: false,
      numTakes: 2,
      currentTakeIndex: 0,
    }],
  }],
  transport: {
    playing: false,
    recording: false,
    position: 0,
    looping: false,
    loopStart: 0,
    loopEnd: 0,
  },
};

const TAKES = [{
  index: 0,
  description: "Lead Take 1",
  isCurrent: true,
  peaks: [[-0.4, 0.5], [-0.7, 0.8]],
}, {
  index: 1,
  description: "Lead Take 2",
  isCurrent: false,
  peaks: [[-0.2, 0.3], [-0.6, 0.7]],
}];

function Harness() {
  const scrollRef = useRef<HTMLDivElement>(null);
  return React.createElement(React.Fragment, null,
    React.createElement(ProToolsTrackHeaders, { snapshot: SNAPSHOT }),
    React.createElement(ProToolsTimeline, {
      snapshot: SNAPSHOT,
      contentWidth: 800,
      scrollRef,
      onScroll: () => {},
      onSpotClip: () => {},
    }),
  );
}

describe("Pro Tools Playlists view", () => {
  let host: HTMLDivElement;
  let root: Root;
  let exec: ReturnType<typeof vi.fn>;
  const originalState = useStore.getState();

  beforeEach(() => {
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
    exec = vi.fn(async (command: string): Promise<CommandResult> => command === "list_takes"
      ? { ok: true, command, data: { takes: TAKES, currentTakeIndex: 0 } }
      : { ok: true, command });
    useStore.setState({
      snapshot: SNAPSHOT,
      transport: SNAPSHOT.transport,
      selection: new Set<string>(),
      selectedTrackId: "vocal-track",
      pxPerSec: 100,
      projectEpoch: 120,
      ensurePeaks: vi.fn(),
      exec,
      lastError: null,
    });
    useProTools.getState().resetForProject();
    useProTools.getState().setTrackView("vocal-track", "playlists");
  });

  afterEach(() => {
    act(() => root.unmount());
    host.remove();
    useStore.setState({
      snapshot: originalState.snapshot,
      transport: originalState.transport,
      selection: new Set<string>(),
      selectedTrackId: originalState.selectedTrackId,
      ensurePeaks: originalState.ensurePeaks,
      exec: originalState.exec,
      lastError: originalState.lastError,
    });
    vi.restoreAllMocks();
  });

  it("keeps expanded header and timeline rows aligned while loading take waveforms", async () => {
    await act(async () => root.render(React.createElement(Harness)));

    const header = host.querySelector<HTMLElement>('[data-testid="pt-track-header"]');
    const lane = host.querySelector<HTMLElement>('[data-testid="pt-lane"]');
    expect(header?.style.height).toBe("144px");
    expect(lane?.style.height).toBe("144px");
    expect(header?.querySelectorAll("[data-testid=pt-playlist-header-row]")).toHaveLength(2);

    await vi.waitFor(() => expect(host.querySelectorAll("[data-testid=pt-playlist-bar]")).toHaveLength(2));
    expect(host.querySelector("[data-testid=pt-playlists]")?.getAttribute("role")).toBe("group");
    expect(host.textContent).toContain("Lead Take 1");
    expect(host.textContent).toContain("Lead Take 2");
    expect(host.querySelectorAll("[data-testid=pt-playlists] [data-testid=take-wave]")).toHaveLength(2);
  });

  it("switches a whole take through store.exec and never mutates the snapshot", async () => {
    await act(async () => root.render(React.createElement(Harness)));
    await vi.waitFor(() => expect(host.querySelectorAll("[data-testid=pt-playlist-bar]")).toHaveLength(2));
    exec.mockClear();
    const second = host.querySelector<HTMLButtonElement>('[data-testid="pt-playlist-bar"][data-take-index="1"]');
    if (!second) throw new Error("second playlist is missing");

    await act(async () => second.click());

    expect(exec).toHaveBeenCalledWith("set_current_take", { clipId: "vocal-clip", takeIndex: 1 });
    expect(SNAPSHOT.tracks[0]?.clips[0]?.currentTakeIndex).toBe(0);
  });

  it("surfaces a take-selection failure without changing the current playlist", async () => {
    exec.mockImplementation(async (command: string): Promise<CommandResult> => command === "list_takes"
      ? { ok: true, command, data: { takes: TAKES, currentTakeIndex: 0 } }
      : { ok: false, command, error: "playlist is locked by another editor" });
    await act(async () => root.render(React.createElement(Harness)));
    await vi.waitFor(() => expect(host.querySelectorAll("[data-testid=pt-playlist-bar]")).toHaveLength(2));
    const second = host.querySelector<HTMLButtonElement>('[data-testid="pt-playlist-bar"][data-take-index="1"]');
    if (!second) throw new Error("second playlist is missing");

    await act(async () => second.click());

    expect(useStore.getState().lastError).toBe("playlist is locked by another editor");
    expect(second.getAttribute("aria-pressed")).toBe("false");
  });

  it("ignores a stale take response after the project epoch changes", async () => {
    let resolveOld: ((result: CommandResult) => void) | undefined;
    let call = 0;
    exec.mockImplementation((command: string): Promise<CommandResult> => {
      if (command !== "list_takes") return Promise.resolve({ ok: true, command });
      call += 1;
      if (call === 1) return new Promise((resolve) => { resolveOld = resolve; });
      return Promise.resolve({
        ok: true,
        command,
        data: { takes: [{ ...TAKES[0], description: "Current Project Take" }], currentTakeIndex: 0 },
      });
    });
    await act(async () => root.render(React.createElement(Harness)));

    await act(async () => {
      useStore.setState({ projectEpoch: 121 });
      await Promise.resolve();
    });
    await vi.waitFor(() => expect(host.textContent).toContain("Current Project Take"));
    await act(async () => resolveOld?.({
      ok: true,
      command: "list_takes",
      data: { takes: [{ ...TAKES[0], description: "Stale Project Take" }], currentTakeIndex: 0 },
    }));

    expect(host.textContent).toContain("Current Project Take");
    expect(host.textContent).not.toContain("Stale Project Take");
  });
});
