// The A/B toggle on a render layer (bypass_layer).
//
// bypass_layer moves real audio: it repoints a wave clip's own source back to
// originalSourceRef, and for the MIDI/drum beneath-model it un-mutes the source MIDI while
// muting the hidden render, so exactly one of the two is audible. (freeze_layer used to be
// listed here as a sibling that "writes a status label nothing reads" — true when this was
// written, no longer: it now disarms the reactive loop. See GenDrawer.freeze.test.ts.
// bounce_layer_to_clip is still a relabel on the whole-clip paths.)
//
// What matters here is that the button is a VIEW of server state, not a local boolean. The
// engine decides what is audible; if this widget held its own `bypassed` flag it would drift
// out of agreement with the audio on any undo, any snapshot refresh, or any agent-issued
// bypass — and it would look right the whole time. The "does not flip on click alone" test
// below is the one that pins that, and it is the reason the pressed state is derived.

import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GenDrawer } from "./Dock";
import { useStore } from "../store";
import type { Clip, RenderLayer, Track } from "../types";

vi.mock("../bridge", async () => {
  const actual = await vi.importActual<typeof import("../bridge")>("../bridge");
  return { ...actual, onEvent: vi.fn(() => () => {}), pickFiles: vi.fn(), pickSaveFile: vi.fn() };
});

const layer = (over: Partial<RenderLayer>): RenderLayer => ({
  id: "rl1", status: "ready", adapter: "fake", mode: "reimagine", seed: 1,
  userKept: false, hasArtifact: true, ...over,
} as RenderLayer);

const clipWith = (type: "wave" | "midi", rl: RenderLayer): Clip => ({
  id: "c1", name: "take", type, start: 0, length: 4, offset: 0,
  hasRenderLayer: true, renderLayer: rl,
} as unknown as Clip);

const trackWith = (clip: Clip): Track => ({
  id: "t1", index: 0, name: "Vox", type: "audio",
  volumeDb: 0, pan: 0, mute: false, solo: false, clips: [clip], plugins: [],
} as unknown as Track);

describe("GenDrawer — bypass_layer A/B toggle", () => {
  let host: HTMLDivElement;
  let root: Root;
  let exec: ReturnType<typeof vi.fn>;

  const render = (track: Track) =>
    act(() => root.render(React.createElement(GenDrawer, { track, selectedClipId: "c1" })));
  const bypass = () => host.querySelector('[data-testid="gen-bypass"]') as HTMLButtonElement | null;
  const click = (el: HTMLElement) => act(() => { el.dispatchEvent(new MouseEvent("click", { bubbles: true })); });

  beforeEach(() => {
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
    exec = vi.fn(async () => ({ ok: true }));
    // The drawer fetches colour/target/LoRA vocab on mount. Those are service-spawning in the
    // real app; stub them so this test never depends on a backend being reachable.
    useStore.setState({
      exec, availableColors: [], sa3Available: false, qaByClip: {},
      loadColors: async () => {}, loadTransformTargets: async () => {}, loadLoras: async () => {},
    } as never);
  });
  afterEach(() => { act(() => root.unmount()); host.remove(); });

  it("offers no A/B until the render IS the clip's audio", () => {
    // A layer that was created but never applied has nothing to compare against — offering
    // A/B there would be a control whose only outcome is a silent no-op in the engine.
    //
    // Both states are asserted in ONE test on purpose. The absence half alone passes just as
    // happily when the button was never built, which would make it a guard that cannot fail;
    // pairing it with the presence half forces it to discriminate a real gate from no gate.
    render(trackWith(clipWith("wave", layer({ appliedInPlace: false }))));
    expect(bypass(), "offered A/B on a layer that was never applied").toBeFalsy();

    render(trackWith(clipWith("wave", layer({ appliedInPlace: true }))));
    expect(bypass(), "gate never opens — the control is missing, not conditional").toBeTruthy();
  });

  it("appears once a wave render is applied in place, unpressed and labelled A/B", () => {
    render(trackWith(clipWith("wave", layer({ appliedInPlace: true }))));
    const b = bypass()!;
    expect(b).toBeTruthy();
    expect(b.getAttribute("aria-pressed")).toBe("false");
    expect(b.textContent).toContain("A/B");
  });

  it("sends bypass_layer with the NEGATION of the current server state", () => {
    render(trackWith(clipWith("wave", layer({ appliedInPlace: true }))));
    click(bypass()!);
    expect(exec).toHaveBeenCalledTimes(1);
    expect(exec).toHaveBeenCalledWith("bypass_layer", { clipId: "c1", bypassed: true });
  });

  it("reads pressed state from the layer's status, and un-bypasses from there", () => {
    render(trackWith(clipWith("wave", layer({ appliedInPlace: true, status: "bypassed" }))));
    const b = bypass()!;
    expect(b.getAttribute("aria-pressed")).toBe("true");
    // The label names what you are HEARING, which is the question you have while A/Bing.
    expect(b.textContent).toContain("original");
    click(b);
    expect(exec).toHaveBeenCalledWith("bypass_layer", { clipId: "c1", bypassed: false });
  });

  it("does NOT flip on click alone — the engine decides what is audible", () => {
    // The guard that matters. A local `useState` would make this pass visually while the
    // button disagreed with the actual audio after an undo or an agent-issued bypass.
    render(trackWith(clipWith("wave", layer({ appliedInPlace: true }))));
    click(bypass()!);
    expect(bypass()!.getAttribute("aria-pressed"), "held a local bypassed flag").toBe("false");
    expect(bypass()!.textContent).toContain("A/B");
  });

  it("MIDI/drum gets the same toggle, gated on the hidden render being live", () => {
    render(trackWith(clipWith("midi", layer({ reimagineActive: false }))));
    expect(bypass(), "offered A/B with no render beneath the MIDI").toBeFalsy();

    render(trackWith(clipWith("midi", layer({ reimagineActive: true, status: "bypassed" }))));
    const b = bypass()!;
    expect(b).toBeTruthy();
    // Says MIDI, not "original" — on this branch bypass returns you to the live instrument.
    expect(b.textContent).toContain("MIDI");
    click(b);
    expect(exec).toHaveBeenCalledWith("bypass_layer", { clipId: "c1", bypassed: false });
  });
});
