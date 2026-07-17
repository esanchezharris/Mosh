// G4A — the clip Inspector's Clip tab (gain / mute / rename).
//
// A selected clip gets a "Clip" tab: rename (name text field, commits on blur),
// mute (all clip types), and gain (wave clips only — set_clip_gain is
// audio-clip-only backend-side). Pure command-surface assertions (store.exec) —
// no engine concepts leak. Fades are a separate, deferred ticket (G4b) and are
// NOT part of this tab. Heavy sibling panels (FX/Gen/Lyrics) are stubbed so the
// render stays focused on the Clip surface.

import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Inspector } from "./Inspector";
import { useStore } from "../../store";
import { useShell } from "../shellState";
import type { CommandResult, Clip, Snapshot, Track } from "../../types";

vi.mock("../../ui/Dock", () => ({ Rack: () => null, GenDrawer: () => null }));
vi.mock("./LyricPanel", () => ({ LyricPanel: () => null }));
vi.mock("../../ui/dock/useFloatingWindow", () => ({
  useDrumWindow: { getState: () => ({ open: () => {} }) },
}));

// React wraps HTMLInputElement.prototype's value setter to track whether a subsequent
// native "input" event represents a real change. A plain `input.value = x` assignment
// updates that tracker too, so a same-tick dispatched "input" event reads as a no-op
// and onChange never fires. Route through the ORIGINAL (unwrapped) native setter so
// React sees the DOM value diverge from what it last tracked — exactly like a real
// keystroke/drag. (Also: "blur" does not bubble in the DOM — React listens on the
// bubbling "focusout" event for delegated onBlur, so tests must dispatch that instead.)
const nativeInputValueSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")!.set!;
function setInputValue(input: HTMLInputElement, value: string, eventType: "input" | "change" = "input"): void {
  nativeInputValueSetter.call(input, value);
  input.dispatchEvent(new Event(eventType, { bubbles: true }));
}

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

describe("v2 Inspector Clip tab", () => {
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
    useShell.setState({ selectedClipId: "c1", inspectorTab: "clip" });
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

  it("shows a Clip tab whenever a clip is selected, wave or MIDI", () => {
    render(makeSnapshot(waveClip()));
    expect(host.querySelector('[data-testid="v2-insp-tab-clip"]')).not.toBeNull();

    act(() => useShell.setState({ selectedClipId: "m1", inspectorTab: "clip" }));
    render(makeSnapshot(midiClip()));
    expect(host.querySelector('[data-testid="v2-insp-tab-clip"]')).not.toBeNull();
  });

  it("hides the Clip tab entirely when no clip is selected", () => {
    act(() => useShell.setState({ selectedClipId: null, inspectorTab: "mix" }));
    render(makeSnapshot(waveClip()));
    expect(host.querySelector('[data-testid="v2-insp-tab-clip"]')).toBeNull();
  });

  it("shows gain for a wave clip but not for a MIDI clip", () => {
    render(makeSnapshot(waveClip()));
    expect(host.querySelector('[data-testid="v2-clip-gain"]')).not.toBeNull();

    act(() => useShell.setState({ selectedClipId: "m1", inspectorTab: "clip" }));
    render(makeSnapshot(midiClip()));
    expect(host.querySelector('[data-testid="v2-clip-gain"]')).toBeNull();
    // Mute + rename apply to every clip type.
    expect(host.querySelector('[data-testid="v2-clip-mute"]')).not.toBeNull();
    expect(host.querySelector('[data-testid="v2-clip-name"]')).not.toBeNull();
  });

  it("blurring the renamed name field execs rename_clip with the new name", () => {
    render(makeSnapshot(waveClip({ name: "chords" })));
    const input = host.querySelector<HTMLInputElement>('[data-testid="v2-clip-name"]');
    expect(input).not.toBeNull();
    expect(input!.value).toBe("chords");
    act(() => {
      setInputValue(input!, "verse chords");
      // "blur" doesn't bubble; React's delegated onBlur listens on "focusout".
      input!.dispatchEvent(new Event("focusout", { bubbles: true }));
    });
    const call = execCalls.find((c) => c.command === "rename_clip");
    expect(call).toBeTruthy();
    expect(call!.args).toMatchObject({ clipId: "c1", name: "verse chords" });
  });

  it("does not exec rename_clip when the name is unchanged on blur", () => {
    render(makeSnapshot(waveClip({ name: "chords" })));
    const input = host.querySelector<HTMLInputElement>('[data-testid="v2-clip-name"]');
    act(() => input!.dispatchEvent(new Event("focusout", { bubbles: true })));
    expect(execCalls.find((c) => c.command === "rename_clip")).toBeUndefined();
  });

  it("clicking Mute clip execs set_clip_mute with the flipped mute", () => {
    render(makeSnapshot(waveClip({ mute: false })));
    const btn = host.querySelector<HTMLButtonElement>('[data-testid="v2-clip-mute"]');
    expect(btn!.getAttribute("aria-pressed")).toBe("false");
    act(() => btn!.dispatchEvent(new MouseEvent("click", { bubbles: true })));
    const call = execCalls.find((c) => c.command === "set_clip_mute");
    expect(call).toBeTruthy();
    expect(call!.args).toMatchObject({ clipId: "c1", mute: true });
  });

  it("reflects an already-muted clip (aria-pressed) and unmutes on click", () => {
    render(makeSnapshot(waveClip({ mute: true })));
    const btn = host.querySelector<HTMLButtonElement>('[data-testid="v2-clip-mute"]');
    expect(btn!.getAttribute("aria-pressed")).toBe("true");
    act(() => btn!.dispatchEvent(new MouseEvent("click", { bubbles: true })));
    const call = execCalls.find((c) => c.command === "set_clip_mute");
    expect(call!.args).toMatchObject({ clipId: "c1", mute: false });
  });

  it("dragging the gain slider execs set_clip_gain with the new dB value", () => {
    render(makeSnapshot(waveClip({ gainDb: 0 })));
    const slider = host.querySelector<HTMLInputElement>('[data-testid="v2-clip-gain"]');
    expect(slider).not.toBeNull();
    expect(slider!.value).toBe("0");
    act(() => setInputValue(slider!, "6"));
    const call = execCalls.find((c) => c.command === "set_clip_gain");
    expect(call).toBeTruthy();
    expect(call!.args).toMatchObject({ clipId: "c1", gainDb: 6 });
  });

  it("does not render a fadeIn/fadeOut control — fades are a separate ticket", () => {
    render(makeSnapshot(waveClip()));
    expect(host.querySelector('[data-testid="v2-clip-fadein"]')).toBeNull();
    expect(host.querySelector('[data-testid="v2-clip-fadeout"]')).toBeNull();
  });
});
