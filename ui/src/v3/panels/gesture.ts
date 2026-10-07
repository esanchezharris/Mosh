// A drag is one undo step: every set_plugin_param / set_plugin_state of one pointer gesture
// carries the same `gesture` id, and the engine coalesces them into one transaction.
let counter = 0;
const session = Math.random().toString(36).slice(2, 8);

/** A fresh gesture id ([A-Za-z0-9_.:-], ≤ 64 chars, as the engine requires). */
export function newGestureId(): string {
  counter = (counter + 1) % 1_000_000_000;
  return `ui-${session}-${counter}`;
}
