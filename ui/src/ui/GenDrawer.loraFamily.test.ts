// The LoRA rack is the KEPT shelf — lab checkpoints must not leak into it.
//
// `list_loras` returns one flat list from one scan, now covering two directories:
// `sa3/` (the producer's kept adapters, family "library") and `sa3/lab/` (training
// checkpoints on trial, family "lab"). Both resolve and render identically — that
// sameness is the whole reason auditioning is trustworthy — so nothing downstream
// separates them except this filter.
//
// Without it a single training run drops six near-identical entries ("run7@200",
// "run7@400", …) into the "+ LoRA…" menu and buries the adapters someone actually
// chose. That is not a crash; it is a menu that quietly gets worse the more you use
// the Lab, which is exactly the kind of regression nobody files a bug for.
//
// The subtle half is the metadata lookup. The filter applies to the MENU and the
// is-there-anything-here check, but not to the name→card lookup — otherwise a lab
// take that IS on the clip (auditioned, or stacked in Stage 3) would lose its
// display name and show a bare filename. The third test pins that.

import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GenDrawer } from "./GenDrawer";
import { useStore } from "../store";
import type { AvailableLora, Clip, RenderLayer, Track } from "../types";

vi.mock("../bridge", async () => {
  const actual = await vi.importActual<typeof import("../bridge")>("../bridge");
  return { ...actual, onEvent: vi.fn(() => () => {}), pickFiles: vi.fn(), pickSaveFile: vi.fn() };
});

const lora = (name: string, family?: "library" | "lab"): AvailableLora => ({
  name, displayName: `${name} card`, trigger: "", hint: "", valid: true, family,
});

const layer = (over: Partial<RenderLayer> = {}): RenderLayer => ({
  id: "rl1", status: "ready", adapter: "stable_audio3", mode: "reimagine", seed: 1,
  userKept: false, hasArtifact: true, ...over,
} as RenderLayer);

const clipWith = (rl: RenderLayer): Clip => ({
  id: "c1", name: "take", type: "wave", start: 0, length: 4, offset: 0,
  hasRenderLayer: true, renderLayer: rl,
} as unknown as Clip);

const trackWith = (clip: Clip): Track => ({
  id: "t1", index: 0, name: "Beat", type: "audio",
  volumeDb: 0, pan: 0, mute: false, solo: false, clips: [clip], plugins: [],
} as unknown as Track);

describe("GenDrawer LoRA rack — library vs lab family", () => {
  let host: HTMLDivElement;
  let root: Root;

  const render = (track: Track) =>
    act(() => root.render(React.createElement(GenDrawer, { track, selectedClipId: "c1" })));
  const menu = () => host.querySelector('[data-testid="lora-add"]') as HTMLSelectElement | null;
  const menuNames = () => Array.from(menu()?.options ?? []).map((o) => o.value).filter(Boolean);

  beforeEach(() => {
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
    useStore.setState({
      exec: vi.fn(async () => ({ ok: true })),
      availableColors: [], sa3Available: true, qaByClip: {},
      loadColors: async () => {}, loadTransformTargets: async () => {}, loadLoras: async () => {},
    } as never);
  });
  afterEach(() => { act(() => root.unmount()); host.remove(); });

  it("offers library adapters and withholds lab checkpoints from the same list", () => {
    // Both halves in one test deliberately. "lab is absent" alone would pass just as
    // happily if the menu were empty, broken, or never rendered — pairing it with a
    // library entry that IS offered forces the assertion to discriminate a real
    // filter from no rack at all.
    useStore.setState({
      availableLoras: [lora("ken", "library"), lora("run7@600", "lab"), lora("run7@1200", "lab")],
    } as never);
    render(trackWith(clipWith(layer())));
    expect(menuNames(), "the kept adapter should be offered").toContain("ken");
    expect(menuNames(), "lab checkpoints leaked into the producer's rack menu").not.toContain("run7@600");
    expect(menuNames()).not.toContain("run7@1200");
  });

  it("treats a family-less row as library, so an older service is unaffected", () => {
    // The field is additive. A service that predates the Lab sends no `family`, and
    // every adapter it lists is by definition a kept one — defaulting the other way
    // would make the whole rack vanish on upgrade-lag.
    useStore.setState({ availableLoras: [lora("legacy")] } as never);
    render(trackWith(clipWith(layer())));
    expect(menuNames(), "a family-less adapter was hidden — old services would show an empty rack").toContain("legacy");
  });

  it("shows no rack at all when only lab checkpoints exist and none are active", () => {
    // The emptiness check must count the FILTERED list. Counting the raw one opens a
    // rack whose menu is then filtered down to nothing — a control that appears to
    // offer something and offers nothing.
    useStore.setState({ availableLoras: [lora("run7@600", "lab")] } as never);
    render(trackWith(clipWith(layer())));
    expect(menu(), "an empty rack opened for a lab-only library").toBeFalsy();
    expect(host.querySelector('[data-testid="lora-row-run7@600"]')).toBeFalsy();
  });

  it("still names a lab checkpoint that is active on the clip", () => {
    // The metadata lookup reads the UNFILTERED list. If it read the filtered one, an
    // auditioned or stacked lab take would render as a bare filename with no card,
    // trigger or notes — degrading exactly the row the Lab exists to produce.
    useStore.setState({ availableLoras: [lora("ken", "library"), lora("run7@600", "lab")] } as never);
    render(trackWith(clipWith(layer({ loras: [{ name: "run7@600", value: 80 }] } as Partial<RenderLayer>))));
    const row = host.querySelector('[data-testid="lora-row-run7@600"]');
    expect(row, "an active lab checkpoint lost its row").toBeTruthy();
    expect(row!.textContent, "active lab take fell back to a bare name — meta lookup was filtered too")
      .toContain("run7@600 card");
    // ...and it is still absent from the ADD menu, since it is already active.
    expect(menuNames()).not.toContain("run7@600");
  });
});
