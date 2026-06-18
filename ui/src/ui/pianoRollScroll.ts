// Pure scroll-target math for the piano-roll editor's vertical auto-framing.
// Kept out of PianoRoll.tsx so the (clamping-prone) arithmetic is unit-testable
// without a layout engine — jsdom reports 0 for scrollTop/clientHeight/scrollHeight.

export type ScrollGeom = {
  high: number; // top-most pitch (rendered at y=0)
  rowH: number; // px per pitch row
  clientHeight: number; // visible height of the scroll viewport
  scrollHeight: number; // full scrollable content height
};

// scrollTop that vertically centres a clip's notes (on their mean pitch's row),
// clamped to the scrollable range. Returns null when there are no notes to frame.
export function centerScrollTopForNotes(
  notes: ReadonlyArray<{ pitch: number }>,
  geom: ScrollGeom,
): number | null {
  if (notes.length === 0) return null;
  const mean = notes.reduce((sum, n) => sum + n.pitch, 0) / notes.length;
  const rowTop = (geom.high - mean) * geom.rowH;
  const target = rowTop - geom.clientHeight / 2 + geom.rowH / 2;
  const maxTop = Math.max(0, geom.scrollHeight - geom.clientHeight);
  return Math.max(0, Math.min(maxTop, target));
}
