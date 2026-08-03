// The Drum Rack pad grid through the real component. The native side is proven in
// --selftest; this pins the wiring a headless harness cannot see — that a pad PLAYS when
// clicked, that a dropped sample lands on the pad under the cursor, and that pads address
// the sampler by note rather than by index.

import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DrumPads } from "./DrumPads";
import { useStore } from "../../store";
import { useSettings } from "../../settings/store";
import { SAMPLE_DND_MIME } from "../sampleBrowserUtil";
import type { CommandResult, Track } from "../../types";

vi.mock("../../bridge", async () => {
  const actual = await vi.importActual<typeof import("../../bridge")>("../../bridge");
  return { ...actual, onEvent: vi.fn(() => () => {}), pickFiles: vi.fn(async () => ({ ok: true, files: ["/picked.wav"] })) };
});

const pad = (pitch: number, name: string, extra: Partial<Record<string, unknown>> = {}) => ({
  index: 0, pitch, minNote: pitch, maxNote: pitch, name,
  file: `/kit/${name}.wav`, gainDb: 0, pan: 0, openEnded: true, ...extra,
});

const TRACK = {
  id: "t1", index: 0, name: "Drums", type: "drum", volumeDb: 0, pan: 0, mute: false, solo: false,
  clips: [],
  drumPads: [pad(36, "Kick"), pad(38, "Snare"), pad(42, "ClosedHat"), pad(46, "OpenHat", { chokeGroup: 1 })],
  drumMutedPitches: [38],
  drumSoloPitches: [],
} as unknown as Track;

describe("drum rack pad grid", () => {
  let host: HTMLDivElement;
  let root: Root;
  let exec: ReturnType<typeof vi.fn>;

  const mount = (track: Track = TRACK, clipId?: string) => {
    useStore.setState({ exec });
    act(() => root.render(React.createElement(DrumPads, { track, clipId })));
  };
  const padEl = (note: number) => host.querySelector(`[data-testid="dp-pad"][data-note="${note}"]`)!;
  const calls = (name: string) => exec.mock.calls.filter((c) => c[0] === name).map((c) => c[1]);
  const flush = async () => { await act(async () => { await new Promise((r) => setTimeout(r, 0)); }); };

  beforeEach(() => {
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
    exec = vi.fn(async (command: string): Promise<CommandResult> => ({ ok: true, command, data: { kits: [] } } as unknown as CommandResult));
    useSettings.getState().set("notePreview", true);
  });

  afterEach(() => {
    act(() => root.unmount());
    host.remove();
    vi.restoreAllMocks();
  });

  it("shows 16 pads and lands the GM kit in the default bank", () => {
    mount();
    expect(host.querySelectorAll('[data-testid="dp-pad"]').length).toBe(16);
    // The bundled kit sits at 36..49, so the default bank must actually contain it —
    // opening on an empty bank would make the rack look broken on a fresh drum track.
    expect(padEl(36).textContent).toContain("Kick");
    expect(padEl(38).textContent).toContain("Snare");
  });

  it("clicking a FILLED pad plays it rather than opening a picker", async () => {
    mount();
    act(() => { padEl(36).dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, pointerId: 1 })); });
    await flush();
    expect(calls("audition_note")[0]).toMatchObject({ trackId: "t1", pitch: 36, action: "blip" });
    expect(calls("assign_sample")).toEqual([]);
  });

  it("clicking an EMPTY pad opens a picker and assigns what comes back", async () => {
    mount();
    act(() => { padEl(37).dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, pointerId: 2 })); });
    await flush();
    expect(calls("assign_sample")[0]).toMatchObject({ trackId: "t1", note: 37, file: "/picked.wav" });
  });

  it("a sample dragged from the browser lands on the pad under the cursor", async () => {
    mount();
    const dt = { getData: (m: string) => (m === SAMPLE_DND_MIME ? "/samples/clap.wav" : ""), files: [] };
    const ev = new Event("drop", { bubbles: true }) as Event & { dataTransfer?: unknown };
    ev.dataTransfer = dt;
    act(() => { padEl(42).dispatchEvent(ev); });
    await flush();
    // note 42, not 36 — the drop target decides, not the selection.
    expect(calls("assign_sample")[0]).toMatchObject({ trackId: "t1", note: 42, file: "/samples/clap.wav" });
  });

  it("mute is per pad, addressed by note", async () => {
    mount();
    const m = padEl(36).querySelector('[data-testid="dp-mute"]')!;
    act(() => { m.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, pointerId: 3 })); });
    await flush();
    expect(calls("set_drum_lane")[0]).toMatchObject({ trackId: "t1", note: 36, mute: true });
    // …and an already-muted pad offers to UNmute rather than muting again.
    const m38 = padEl(38).querySelector('[data-testid="dp-mute"]')!;
    exec.mockClear();
    act(() => { m38.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, pointerId: 4 })); });
    await flush();
    expect(calls("set_drum_lane")[0]).toMatchObject({ note: 38, mute: false });
  });

  it("shows a muted pad as muted, and it stays readable", () => {
    mount();
    expect(padEl(38).className).toContain("muted");
    expect(padEl(38).textContent).toContain("Snare");   // you must see what you silenced
  });

  it("the bank selector walks the whole 128-note range", () => {
    mount();
    const up = host.querySelector('[data-testid="dp-bank-up"]') as HTMLButtonElement;
    act(() => { up.click(); });
    expect(host.querySelector('[data-testid="dp-pad"]')!.getAttribute("data-note")).not.toBe("48");
    expect(host.querySelectorAll('[data-testid="dp-pad"]').length).toBe(16);
  });

  it("offers Apply choke only when a pad actually has a choke group AND there is a clip", async () => {
    mount(TRACK, "c1");
    expect(host.querySelector('[data-testid="dp-apply-choke"]')).toBeTruthy();

    // No clip ⇒ nothing to bake into.
    act(() => root.render(React.createElement(DrumPads, { track: TRACK })));
    expect(host.querySelector('[data-testid="dp-apply-choke"]')).toBeNull();

    // No choke groups ⇒ the button would do nothing, so it is not offered.
    const noChoke = { ...TRACK, drumPads: [pad(36, "Kick")] } as unknown as Track;
    act(() => root.render(React.createElement(DrumPads, { track: noChoke, clipId: "c1" })));
    expect(host.querySelector('[data-testid="dp-apply-choke"]')).toBeNull();
  });
});
