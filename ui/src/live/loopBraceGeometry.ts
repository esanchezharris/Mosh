// Loop-brace geometry (ui/src/live/LoopBrace.tsx). Pure so the move/resize/key
// decisions are unit-testable without a DOM. All times in seconds.

export type LoopSpan = { start: number; end: number };

const spanLen = (s: LoopSpan) => s.end - s.start;

/** Move the whole brace by `deltaSec`, clamped into [0, contentLen] (length preserved). */
export function moveLoop(span: LoopSpan, deltaSec: number, contentLen: number): LoopSpan {
  const len = spanLen(span);
  const start = Math.min(Math.max(0, span.start + deltaSec), Math.max(0, contentLen - len));
  return { start, end: start + len };
}

/** Resize one edge to `value` (seconds). The end edge can't cross start+minLen;
 *  the start edge can't cross end-minLen, and never goes below 0. */
export function resizeLoopEdge(
  span: LoopSpan, edge: "start" | "end", value: number, minLen: number, contentLen: number,
): LoopSpan {
  if (edge === "start") {
    const start = Math.min(Math.max(0, value), span.end - minLen);
    return { start, end: span.end };
  }
  const end = Math.min(Math.max(span.start + minLen, value), contentLen);
  return { start: span.start, end };
}

/** Keyboard edits, Live's brace keys: ←/→ move the whole brace by the grid step;
 *  Mod+← halves the length (start-anchored, floored at minLen), Mod+→ doubles it
 *  (start-anchored, clamped to the content). Returns null when the key isn't ours. */
export function loopKeyEdit(
  span: LoopSpan, key: string, mod: boolean, gridSec: number, contentLen: number, minLen: number,
): LoopSpan | null {
  if (key === "ArrowLeft" && !mod) return moveLoop(span, -gridSec, contentLen);
  if (key === "ArrowRight" && !mod) return moveLoop(span, gridSec, contentLen);
  if (key === "ArrowLeft" && mod) {
    const len = Math.max(minLen, spanLen(span) / 2);
    return { start: span.start, end: span.start + len };
  }
  if (key === "ArrowRight" && mod) {
    const len = Math.min(Math.max(0, contentLen - span.start), spanLen(span) * 2);
    return { start: span.start, end: span.start + len };
  }
  return null;
}
