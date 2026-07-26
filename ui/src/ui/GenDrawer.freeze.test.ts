// Freeze / thaw on a render layer (freeze_layer + unfreeze_layer).
//
// Freeze shipped inert for a long time: it wrote status="frozen" and nothing anywhere read it,
// so a "frozen" layer went right on re-rendering itself on the next edit. The engine fix makes
// it write ids::reactive=false — the flag reactiveTouch actually gates on — and adds
// unfreeze_layer, which did not exist at all (a freeze was permanent for the life of a project).
//
// The load-bearing test here is "keeps the badge after a param edit". `status` and `reactive`
// BOTH carry the freeze at first, so a widget reading `status === "frozen"` looks perfect until
// the first knob turn overwrites status with "dirty" — at which point the badge silently claims
// the layer thawed itself, while the engine still refuses to re-render. Reading the wrong field
// is the easy mistake, it cannot be spotted by eye, and that test is what forbids it.
//
// Whether the freeze actually saves the render is not knowable from here (or from --selftest:
// reactiveTouch bails on !hasAudio() before it reads the flag). That is verify.py's
// check_freeze_stops_rerender, which counts rendered files with a live service.

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

describe("GenDrawer — freeze / thaw", () => {
  let host: HTMLDivElement;
  let root: Root;
  let exec: ReturnType<typeof vi.fn>;

  const render = (track: Track) =>
    act(() => root.render(React.createElement(GenDrawer, { track, selectedClipId: "c1" })));
  const freeze = () => host.querySelector('[data-testid="gen-freeze"]') as HTMLButtonElement | null;
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

  it("offers no freeze until a render is actually live", () => {
    // Both halves in one test: asserting only the absence would pass just as happily on a
    // build where the button was never added, making it a guard that cannot fail.
    render(trackWith(clipWith("wave", layer({ appliedInPlace: false }))));
    expect(freeze(), "offered freeze on a layer with no live render — nothing to stop").toBeFalsy();

    render(trackWith(clipWith("wave", layer({ appliedInPlace: true }))));
    expect(freeze(), "gate never opens — the control is missing, not conditional").toBeTruthy();
  });

  it("starts unpressed: absent `reactive` means reactive, not frozen", () => {
    // Layers created before the freeze fix carry no `reactive` property at all. Defaulting
    // those to frozen would silently stop re-rendering for every project already on disk.
    render(trackWith(clipWith("wave", layer({ appliedInPlace: true }))));
    const b = freeze()!;
    expect(b.getAttribute("aria-pressed")).toBe("false");
    expect(b.textContent).toContain("Freeze");
  });

  it("sends freeze_layer, then unfreeze_layer from the frozen state", () => {
    render(trackWith(clipWith("wave", layer({ appliedInPlace: true }))));
    click(freeze()!);
    expect(exec).toHaveBeenCalledWith("freeze_layer", { clipId: "c1" });

    render(trackWith(clipWith("wave", layer({ appliedInPlace: true, reactive: false, status: "frozen" }))));
    const b = freeze()!;
    expect(b.getAttribute("aria-pressed")).toBe("true");
    expect(b.textContent).toContain("Frozen");
    click(b);
    expect(exec).toHaveBeenCalledWith("unfreeze_layer", { clipId: "c1" });
  });

  it("keeps the frozen badge after a param edit moves status to dirty", () => {
    // THE regression guard. A param edit on a frozen layer sets status="dirty" while the layer
    // stays frozen — both are true at once. A badge derived from `status` would read as thawed
    // here and send freeze_layer on the next click, which the engine would accept, leaving the
    // button permanently one state behind the truth.
    render(trackWith(clipWith("wave", layer({ appliedInPlace: true, reactive: false, status: "dirty" }))));
    const b = freeze()!;
    expect(b.getAttribute("aria-pressed"), "read the freeze off `status` instead of `reactive`").toBe("true");
    click(b);
    expect(exec).toHaveBeenCalledWith("unfreeze_layer", { clipId: "c1" });
  });

  it("does NOT flip on click alone — the engine owns the freeze", () => {
    render(trackWith(clipWith("wave", layer({ appliedInPlace: true }))));
    click(freeze()!);
    expect(freeze()!.getAttribute("aria-pressed"), "held a local frozen flag").toBe("false");
  });

  it("MIDI/drum gets the same control, gated on the hidden render being live", () => {
    render(trackWith(clipWith("midi", layer({ reimagineActive: false }))));
    expect(freeze(), "offered freeze with no render beneath the MIDI").toBeFalsy();

    render(trackWith(clipWith("midi", layer({ reimagineActive: true, reactive: false }))));
    const b = freeze()!;
    expect(b).toBeTruthy();
    expect(b.getAttribute("aria-pressed")).toBe("true");
    click(b);
    expect(exec).toHaveBeenCalledWith("unfreeze_layer", { clipId: "c1" });
  });
});
