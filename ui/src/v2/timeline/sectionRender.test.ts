// The rules for turning a time-range selection into a section-scoped render.
//
// Every "returns null" case here is a case where the button is HIDDEN rather than shown and
// then failing: create_render_layer refuses a second layer on a clip, and a span covering a
// whole clip would be applied in place by the engine anyway — so offering it would either
// error or quietly not be a section at all. Each null is paired with a positive case in the
// same file, so none of them can pass by the control simply never existing.

import { describe, expect, it } from "vitest";
import { sectionTargetFor, isSectionScoped } from "./sectionRender";
import type { Clip, Track } from "../../types";

const clip = (over: Partial<Clip> = {}): Clip => ({
  id: "c1", name: "take", type: "wave", start: 4, length: 8, offset: 0, hasRenderLayer: false,
  ...over,
} as unknown as Clip);

const track = (clips: Clip[], id = "t1"): Track => ({
  id, index: 0, name: "Vox", type: "audio",
  volumeDb: 0, pan: 0, mute: false, solo: false, clips, plugins: [],
} as unknown as Track);

describe("sectionTargetFor", () => {
  it("clamps the span to the clip it lands on", () => {
    // The span starts before the clip; the render must not claim time the clip does not own.
    const t = sectionTargetFor([track([clip()])], "t1", { start: 0, end: 6 });
    expect(t).toEqual({ clipId: "c1", regionStart: 4, regionEnd: 6 });
  });

  it("accepts a span strictly inside the clip", () => {
    const t = sectionTargetFor([track([clip()])], "t1", { start: 5, end: 9 });
    expect(t).toEqual({ clipId: "c1", regionStart: 5, regionEnd: 9 });
  });

  it("normalises a backwards span", () => {
    // Dragging right-to-left is a normal way to select; it must mean the same range.
    expect(sectionTargetFor([track([clip()])], "t1", { start: 9, end: 5 }))
      .toEqual({ clipId: "c1", regionStart: 5, regionEnd: 9 });
  });

  it("declines a span that covers the WHOLE clip — that is not a section", () => {
    // The engine would apply this in place, so calling it a section would be a lie about
    // what the render is going to do.
    expect(sectionTargetFor([track([clip()])], "t1", { start: 4, end: 12 })).toBeNull();
    expect(sectionTargetFor([track([clip()])], "t1", { start: 0, end: 99 })).toBeNull();
    // ...but a span one second short of the end IS a section.
    expect(sectionTargetFor([track([clip()])], "t1", { start: 4, end: 11 }))
      .toEqual({ clipId: "c1", regionStart: 4, regionEnd: 11 });
  });

  it("declines when the clip already carries a layer", () => {
    expect(sectionTargetFor([track([clip({ hasRenderLayer: true })])], "t1", { start: 5, end: 9 })).toBeNull();
    expect(sectionTargetFor([track([clip({ hasRenderLayer: false })])], "t1", { start: 5, end: 9 })).toBeTruthy();
  });

  it("declines when the span misses every clip on the selected track", () => {
    expect(sectionTargetFor([track([clip()])], "t1", { start: 20, end: 24 })).toBeNull();
  });

  it("only considers the SELECTED track, even though the span crosses all lanes", () => {
    // A range selection is cross-lane by design (that is what makes ripple delete meaningful),
    // so without this the control would have to guess which clip was meant.
    const tracks = [track([clip()], "t1"), track([clip({ id: "c2" })], "t2")];
    expect(sectionTargetFor(tracks, "t2", { start: 5, end: 9 })?.clipId).toBe("c2");
    expect(sectionTargetFor(tracks, null, { start: 5, end: 9 })).toBeNull();
    expect(sectionTargetFor(tracks, "nope", { start: 5, end: 9 })).toBeNull();
  });

  it("declines a zero-width span", () => {
    expect(sectionTargetFor([track([clip()])], "t1", { start: 6, end: 6 })).toBeNull();
    expect(sectionTargetFor([track([clip()])], "t1", null)).toBeNull();
  });
});

describe("isSectionScoped", () => {
  const withLayer = (regionStart: number, regionEnd: number) =>
    clip({ hasRenderLayer: true, renderLayer: { id: "rl1", regionStart, regionEnd } } as Partial<Clip>);

  it("a whole-clip layer reports the clip's own span and is NOT section-scoped", () => {
    // This is the case that makes a presence check wrong: the field is always there.
    expect(isSectionScoped(withLayer(4, 12))).toBe(false);
  });

  it("a layer trimmed at either end IS section-scoped", () => {
    expect(isSectionScoped(withLayer(5, 12))).toBe(true);
    expect(isSectionScoped(withLayer(4, 11))).toBe(true);
    expect(isSectionScoped(withLayer(5, 11))).toBe(true);
  });

  it("a clip with no layer, or a layer with no region, is not section-scoped", () => {
    expect(isSectionScoped(clip())).toBe(false);
    expect(isSectionScoped(clip({ hasRenderLayer: true, renderLayer: { id: "rl1" } } as Partial<Clip>))).toBe(false);
  });
});
