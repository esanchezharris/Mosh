import { describe, expect, it } from "vitest";
import { cropOps, CROP_MIN_LEN, type CropClip } from "./cropToRange";

const clip = (id: string, start: number, length: number, offset = 0): CropClip =>
  ({ id, start, length, offset });

describe("cropToRange", () => {
  it("trims a straddling clip to the intersection AND shifts offset by the same amount", () => {
    // The offset shift is the whole point: without it the surviving region plays the
    // wrong part of the source, which you can only hear, never see.
    const ops = cropOps([clip("a", 0, 10, 2)], 4, 8);
    expect(ops).toEqual([{ kind: "trim", clipId: "a", start: 4, length: 4, offset: 6 }]);
  });

  it("only moves offset when the START moves — a right-side-only crop keeps it", () => {
    const ops = cropOps([clip("a", 5, 10, 3)], 0, 9);
    expect(ops).toEqual([{ kind: "trim", clipId: "a", start: 5, length: 4, offset: 3 }]);
  });

  it("removes clips entirely outside the range", () => {
    const ops = cropOps([clip("before", 0, 2), clip("after", 20, 5)], 5, 10);
    expect(ops).toEqual([{ kind: "remove", clipId: "before" }, { kind: "remove", clipId: "after" }]);
  });

  it("a clip that merely TOUCHES a boundary is removed, not kept as a zero-length sliver", () => {
    // Ends exactly where the range starts: it has no audio inside, so it goes.
    expect(cropOps([clip("t", 0, 5)], 5, 10)).toEqual([{ kind: "remove", clipId: "t" }]);
  });

  it("leaves a clip already inside the range completely alone (no wasted undo step)", () => {
    expect(cropOps([clip("inside", 6, 2)], 5, 10)).toEqual([]);
  });

  it("removes a survivor thinner than the minimum rather than leaving an unusable sliver", () => {
    const ops = cropOps([clip("sliver", 0, 5 + CROP_MIN_LEN / 2)], 5, 10);
    expect(ops).toEqual([{ kind: "remove", clipId: "sliver" }]);
  });

  it("is direction-independent", () => {
    expect(cropOps([clip("a", 0, 10)], 8, 4)).toEqual(cropOps([clip("a", 0, 10)], 4, 8));
  });

  it("a degenerate range crops NOTHING — it must never delete the project", () => {
    // The dangerous failure: a zero-width range treating every clip as "outside" and
    // emitting a remove for all of them.
    expect(cropOps([clip("a", 0, 10), clip("b", 20, 5)], 7, 7)).toEqual([]);
    expect(cropOps([clip("a", 0, 10)], 7, 7 + CROP_MIN_LEN / 2)).toEqual([]);
  });

  it("never emits a negative offset", () => {
    const ops = cropOps([clip("a", 0, 10, 0)], 0, 5);
    for (const o of ops) if (o.kind === "trim") expect(o.offset).toBeGreaterThanOrEqual(0);
  });
});
