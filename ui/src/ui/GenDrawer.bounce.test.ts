// The Bounce control, and — more importantly — everywhere it must NOT appear.
//
// bounce_layer_to_clip has existed and been agent-callable all along, but it is a pure
// relabel on every path a producer could actually reach: for a whole-clip wave render
// (appliedInPlace) and for the MIDI/drum beneath-model, cmdAcceptRender takes a no-op branch,
// so bounce writes status="bounced" and changes no audio. It does real work ONLY for a
// section-scoped render, which no UI could create until the timeline range selection could
// send regionStart/regionEnd.
//
// So the test that carries the weight is not "the button works" — it is that the button is
// ABSENT on the whole-clip and MIDI paths. A Bounce button there would be a control whose
// entire effect is to relabel, which is exactly the dishonesty the gap entry described.

import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GenDrawer } from "./GenDrawer";
import { useStore } from "../store";
import type { Clip, RenderLayer, Track } from "../types";

vi.mock("../bridge", async () => {
  const actual = await vi.importActual<typeof import("../bridge")>("../bridge");
  return { ...actual, onEvent: vi.fn(() => () => {}), pickFiles: vi.fn(), pickSaveFile: vi.fn() };
});

// The clip spans 4s → 12s throughout, so a region is a section iff it is inside those bounds.
const CLIP_START = 4, CLIP_LEN = 8, CLIP_END = CLIP_START + CLIP_LEN;

const layer = (over: Partial<RenderLayer>): RenderLayer => ({
  id: "rl1", status: "ready", adapter: "fake", mode: "reimagine", seed: 1,
  userKept: false, hasArtifact: true, regionStart: CLIP_START, regionEnd: CLIP_END, ...over,
} as RenderLayer);

const clipWith = (type: "wave" | "midi", rl: RenderLayer): Clip => ({
  id: "c1", name: "take", type, start: CLIP_START, length: CLIP_LEN, offset: 0,
  hasRenderLayer: true, renderLayer: rl,
} as unknown as Clip);

const trackWith = (clip: Clip): Track => ({
  id: "t1", index: 0, name: "Vox", type: "audio",
  volumeDb: 0, pan: 0, mute: false, solo: false, clips: [clip], plugins: [],
} as unknown as Track);

describe("GenDrawer — bounce_layer_to_clip", () => {
  let host: HTMLDivElement;
  let root: Root;
  let exec: ReturnType<typeof vi.fn>;

  const render = (track: Track) =>
    act(() => root.render(React.createElement(GenDrawer, { track, selectedClipId: "c1" })));
  const bounce = () => host.querySelector('[data-testid="gen-bounce"]') as HTMLButtonElement | null;
  const click = (el: HTMLElement) => act(() => { el.dispatchEvent(new MouseEvent("click", { bubbles: true })); });

  beforeEach(() => {
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
    exec = vi.fn(async () => ({ ok: true }));
    useStore.setState({
      exec, availableColors: [], sa3Available: false, qaByClip: {},
      loadColors: async () => {}, loadTransformTargets: async () => {}, loadLoras: async () => {},
    } as never);
  });
  afterEach(() => { act(() => root.unmount()); host.remove(); });

  it("is absent for a WHOLE-clip wave render, where bounce is only a relabel", () => {
    render(trackWith(clipWith("wave", layer({ appliedInPlace: true }))));
    expect(bounce(), "offered Bounce on a render that already applied in place").toBeFalsy();
  });

  it("is absent for a MIDI/drum beneath-render, where bounce is only a relabel", () => {
    render(trackWith(clipWith("midi", layer({ reimagineActive: true }))));
    expect(bounce(), "offered Bounce on a beneath-render").toBeFalsy();
  });

  it("appears for a SECTION-scoped render — the one shape where it does real work", () => {
    render(trackWith(clipWith("wave", layer({ regionStart: 5, regionEnd: 9 }))));
    const b = bounce();
    expect(b, "the gate never opens — the control is missing, not conditional").toBeTruthy();
    expect(b!.disabled).toBe(false);
    click(b!);
    expect(exec).toHaveBeenCalledWith("bounce_layer_to_clip", { clipId: "c1" });
  });

  it("is disabled until the section has actually been rendered", () => {
    render(trackWith(clipWith("wave", layer({ regionStart: 5, regionEnd: 9, hasArtifact: false, status: "dirty" }))));
    const b = bounce()!;
    expect(b.disabled).toBe(true);
    expect(b.title).toContain("nothing to bounce");
  });

  it("a section render offers no Live / A-B / Reset — none of them apply to it", () => {
    // Those three are all about a render that IS the clip's audio. A section render never
    // becomes the clip's source, so offering them would promise behaviour that cannot happen.
    render(trackWith(clipWith("wave", layer({ regionStart: 5, regionEnd: 9 }))));
    expect(host.querySelector('[data-testid="gen-live"]')).toBeFalsy();
    expect(host.querySelector('[data-testid="gen-bypass"]')).toBeFalsy();
    expect(host.querySelector('[data-testid="gen-reset"]')).toBeFalsy();
    // ...while the whole-clip render still has them, so the absence above is a real branch.
    render(trackWith(clipWith("wave", layer({ appliedInPlace: true }))));
    expect(host.querySelector('[data-testid="gen-live"]')).toBeTruthy();
    expect(host.querySelector('[data-testid="gen-reset"]')).toBeTruthy();
  });
});
