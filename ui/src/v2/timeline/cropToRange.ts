// CAP-CLP-005 — "crop to range": trim every clip that overlaps a time selection down to
// the part inside it, and drop the clips that fall entirely outside.
//
// Pure. Given the snapshot's clips and a range, it returns the exact `trim_clip` /
// `remove_clip` calls to make — so the rule is unit-testable without a timeline, and the
// component that runs it holds no arithmetic.
//
// WHY THIS EXISTS. `trim_clip` can already express any crop; nothing could ASK for one.
// Dragging a clip's left edge is the closest a producer could get, and it does two things
// at once (moves the boundary AND slides the source under it), so cropping a stack of
// clips to a section meant hand-dragging every edge twice.
//
// The rule (Reaper "Crop items to time selection", Pro Tools Trim > To Selection — the
// 2-of-4 agreement): keep the intersection, and CRUCIALLY compensate `offset` when the
// start moves, so the audio that remains is the audio that was already there. Without the
// offset shift the surviving region plays the wrong part of the file — the kind of bug you
// only hear, which is exactly why it is pinned here rather than left inline.

export interface CropClip {
  id: string;
  start: number;
  length: number;
  offset?: number;
}

export type CropOp =
  | { kind: "trim"; clipId: string; start: number; length: number; offset: number }
  | { kind: "remove"; clipId: string };

/** Below this a surviving sliver is not worth keeping — it matches MIN_LEN in ClipView. */
export const CROP_MIN_LEN = 0.05;

export function cropOps(clips: readonly CropClip[], start: number, end: number): CropOp[] {
  const lo = Math.min(start, end);
  const hi = Math.max(start, end);
  const ops: CropOp[] = [];
  if (hi - lo < CROP_MIN_LEN) return ops;   // a degenerate range crops nothing

  for (const c of clips) {
    const cStart = c.start;
    const cEnd = c.start + c.length;
    // Touching only at a boundary is NOT an overlap: a clip that ends exactly where the
    // range begins keeps every sample it had, and removing it would be a nasty surprise.
    if (cEnd <= lo || cStart >= hi) { ops.push({ kind: "remove", clipId: c.id }); continue; }

    const newStart = Math.max(cStart, lo);
    const newEnd = Math.min(cEnd, hi);
    const newLen = newEnd - newStart;
    if (newLen < CROP_MIN_LEN) { ops.push({ kind: "remove", clipId: c.id }); continue; }

    // Nothing to do — already inside the range. Emitting a no-op trim would still cost an
    // undo step per clip on a big selection.
    if (newStart === cStart && newLen === c.length) continue;

    // The source slides by exactly as much as the start moved, so the surviving audio is
    // the audio that was under those seconds before the crop.
    const offset = Math.max(0, (c.offset ?? 0) + (newStart - cStart));
    ops.push({ kind: "trim", clipId: c.id, start: newStart, length: newLen, offset });
  }
  return ops;
}
