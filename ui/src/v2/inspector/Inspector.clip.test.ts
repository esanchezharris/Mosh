// G4A/G4b — the clip Inspector's Clip tab (gain / mute / rename / fades).
//
// A selected clip gets a "Clip" tab: rename (name text field, commits on blur),
// mute (all clip types), gain, and fade-in/fade-out (wave clips only —
// set_clip_gain/set_clip_fade are audio-clip-only backend-side). Pure
// command-surface assertions (store.exec) — no engine concepts leak. Heavy
// sibling panels (FX/Gen/Lyrics) are stubbed so the render stays focused on the
// Clip surface.

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

  it("shows fade-in/fade-out for a wave clip but not for a MIDI clip", () => {
    render(makeSnapshot(waveClip()));
    expect(host.querySelector('[data-testid="v2-clip-fadein"]')).not.toBeNull();
    expect(host.querySelector('[data-testid="v2-clip-fadeout"]')).not.toBeNull();

    act(() => useShell.setState({ selectedClipId: "m1", inspectorTab: "clip" }));
    render(makeSnapshot(midiClip()));
    expect(host.querySelector('[data-testid="v2-clip-fadein"]')).toBeNull();
    expect(host.querySelector('[data-testid="v2-clip-fadeout"]')).toBeNull();
  });

  it("dragging the fade-in slider execs set_clip_fade with fadeInSec", () => {
    render(makeSnapshot(waveClip({ fadeInSec: 0 })));
    const slider = host.querySelector<HTMLInputElement>('[data-testid="v2-clip-fadein"]');
    expect(slider).not.toBeNull();
    expect(slider!.value).toBe("0");
    act(() => setInputValue(slider!, "1.5"));
    const call = execCalls.find((c) => c.command === "set_clip_fade");
    expect(call).toBeTruthy();
    expect(call!.args).toMatchObject({ clipId: "c1", fadeInSec: 1.5 });
  });

  it("dragging the fade-out slider execs set_clip_fade with fadeOutSec", () => {
    render(makeSnapshot(waveClip({ fadeOutSec: 0 })));
    const slider = host.querySelector<HTMLInputElement>('[data-testid="v2-clip-fadeout"]');
    expect(slider).not.toBeNull();
    expect(slider!.value).toBe("0");
    act(() => setInputValue(slider!, "0.75"));
    const call = execCalls.find((c) => c.command === "set_clip_fade");
    expect(call).toBeTruthy();
    expect(call!.args).toMatchObject({ clipId: "c1", fadeOutSec: 0.75 });
  });

  it("shows fade curve pickers for a wave clip but not for a MIDI clip", () => {
    render(makeSnapshot(waveClip()));
    expect(host.querySelector('[data-testid="v2-clip-fadein-curve"]')).not.toBeNull();
    expect(host.querySelector('[data-testid="v2-clip-fadeout-curve"]')).not.toBeNull();

    act(() => useShell.setState({ selectedClipId: "m1", inspectorTab: "clip" }));
    render(makeSnapshot(midiClip()));
    expect(host.querySelector('[data-testid="v2-clip-fadein-curve"]')).toBeNull();
    expect(host.querySelector('[data-testid="v2-clip-fadeout-curve"]')).toBeNull();
  });

  it("changing the fade-in curve execs set_clip_fade with curveIn", () => {
    render(makeSnapshot(waveClip({ fadeInType: 1 })));
    const select = host.querySelector<HTMLSelectElement>('[data-testid="v2-clip-fadein-curve"]');
    expect(select).not.toBeNull();
    expect(select!.value).toBe("linear");
    act(() => {
      select!.value = "convex";
      select!.dispatchEvent(new Event("change", { bubbles: true }));
    });
    const call = execCalls.find((c) => c.command === "set_clip_fade");
    expect(call).toBeTruthy();
    expect(call!.args).toMatchObject({ clipId: "c1", curveIn: "convex" });
  });

  it("changing the fade-out curve execs set_clip_fade with curveOut", () => {
    render(makeSnapshot(waveClip({ fadeOutType: 3 })));
    const select = host.querySelector<HTMLSelectElement>('[data-testid="v2-clip-fadeout-curve"]');
    expect(select).not.toBeNull();
    expect(select!.value).toBe("concave");
    act(() => {
      select!.value = "sCurve";
      select!.dispatchEvent(new Event("change", { bubbles: true }));
    });
    const call = execCalls.find((c) => c.command === "set_clip_fade");
    expect(call).toBeTruthy();
    expect(call!.args).toMatchObject({ clipId: "c1", curveOut: "sCurve" });
  });

  it("clamps the displayed fade value to the clip's own length", () => {
    render(makeSnapshot(waveClip({ length: 2, fadeInSec: 5 })));
    const slider = host.querySelector<HTMLInputElement>('[data-testid="v2-clip-fadein"]');
    // The slider's max is the clip length, so an out-of-range stored value clamps
    // when displayed (the engine clamps identically server-side on the next set).
    expect(Number(slider!.value)).toBeLessThanOrEqual(2);
  });

  // clip-ops wave — reverse / auto-crossfade / normalize.
  it("shows reverse/crossfade/normalize for a wave clip but not for a MIDI clip", () => {
    render(makeSnapshot(waveClip()));
    expect(host.querySelector('[data-testid="v2-clip-reverse"]')).not.toBeNull();
    expect(host.querySelector('[data-testid="v2-clip-crossfade"]')).not.toBeNull();
    expect(host.querySelector('[data-testid="v2-clip-normalize"]')).not.toBeNull();

    act(() => useShell.setState({ selectedClipId: "m1", inspectorTab: "clip" }));
    render(makeSnapshot(midiClip()));
    expect(host.querySelector('[data-testid="v2-clip-reverse"]')).toBeNull();
    expect(host.querySelector('[data-testid="v2-clip-crossfade"]')).toBeNull();
    expect(host.querySelector('[data-testid="v2-clip-normalize"]')).toBeNull();
  });

  it("clicking Reverse execs set_clip_reverse with the flipped value", () => {
    render(makeSnapshot(waveClip({ reversed: false })));
    const btn = host.querySelector<HTMLButtonElement>('[data-testid="v2-clip-reverse"]');
    expect(btn!.getAttribute("aria-pressed")).toBe("false");
    act(() => btn!.dispatchEvent(new MouseEvent("click", { bubbles: true })));
    const call = execCalls.find((c) => c.command === "set_clip_reverse");
    expect(call).toBeTruthy();
    expect(call!.args).toMatchObject({ clipId: "c1", reversed: true });
  });

  it("reflects an already-reversed clip (aria-pressed) and un-reverses on click", () => {
    render(makeSnapshot(waveClip({ reversed: true })));
    const btn = host.querySelector<HTMLButtonElement>('[data-testid="v2-clip-reverse"]');
    expect(btn!.getAttribute("aria-pressed")).toBe("true");
    act(() => btn!.dispatchEvent(new MouseEvent("click", { bubbles: true })));
    const call = execCalls.find((c) => c.command === "set_clip_reverse");
    expect(call!.args).toMatchObject({ clipId: "c1", reversed: false });
  });

  it("clicking Auto-crossfade execs set_clip_crossfade with the flipped value", () => {
    render(makeSnapshot(waveClip({ autoCrossfade: false })));
    const btn = host.querySelector<HTMLButtonElement>('[data-testid="v2-clip-crossfade"]');
    expect(btn!.getAttribute("aria-pressed")).toBe("false");
    act(() => btn!.dispatchEvent(new MouseEvent("click", { bubbles: true })));
    const call = execCalls.find((c) => c.command === "set_clip_crossfade");
    expect(call).toBeTruthy();
    expect(call!.args).toMatchObject({ clipId: "c1", enabled: true });
  });

  it("reflects an already-crossfaded clip (aria-pressed) and disables on click", () => {
    render(makeSnapshot(waveClip({ autoCrossfade: true })));
    const btn = host.querySelector<HTMLButtonElement>('[data-testid="v2-clip-crossfade"]');
    expect(btn!.getAttribute("aria-pressed")).toBe("true");
    act(() => btn!.dispatchEvent(new MouseEvent("click", { bubbles: true })));
    const call = execCalls.find((c) => c.command === "set_clip_crossfade");
    expect(call!.args).toMatchObject({ clipId: "c1", enabled: false });
  });

  it("clicking Normalize execs normalize_clip with the default target (0 dB)", () => {
    render(makeSnapshot(waveClip()));
    const btn = host.querySelector<HTMLButtonElement>('[data-testid="v2-clip-normalize"]');
    expect(btn).not.toBeNull();
    act(() => btn!.dispatchEvent(new MouseEvent("click", { bubbles: true })));
    const call = execCalls.find((c) => c.command === "normalize_clip");
    expect(call).toBeTruthy();
    expect(call!.args).toMatchObject({ clipId: "c1", targetDb: 0 });
  });

  it("changing the target dB field then clicking Normalize execs normalize_clip with that target", () => {
    render(makeSnapshot(waveClip()));
    const input = host.querySelector<HTMLInputElement>('[data-testid="v2-clip-normalize-target"]');
    expect(input).not.toBeNull();
    act(() => setInputValue(input!, "-6"));
    const btn = host.querySelector<HTMLButtonElement>('[data-testid="v2-clip-normalize"]');
    act(() => btn!.dispatchEvent(new MouseEvent("click", { bubbles: true })));
    const call = execCalls.find((c) => c.command === "normalize_clip");
    expect(call).toBeTruthy();
    expect(call!.args).toMatchObject({ clipId: "c1", targetDb: -6 });
  });
});
