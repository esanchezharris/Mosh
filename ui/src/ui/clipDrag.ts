// Commit an optimistic clip drag (move / trim) to the backend, reverting the
// local preview if the command is REJECTED.
//
// On success the preview is intentionally left in place: the ensuing
// snapshot_invalidated → refresh updates the clip's props, which clears the
// preview via the [clip.start, clip.length, clip.offset] effect. On FAILURE
// there is no snapshot change, so without an explicit revert the preview would
// stay stuck showing a move/trim the backend rejected (a visual desync between
// the UI and the real edit). This helper closes that gap and is unit-testable.

export interface DragPos {
  start: number;
  length: number;
  offset: number;
}

// Matches the store's ExecFn (resolves to a CommandResult, typed loosely here).
type Exec = (command: string, args?: Record<string, unknown>) => Promise<unknown>;

const rejected = (r: unknown): boolean => !(r as { ok?: boolean } | null)?.ok;

// CAP-CLP-017 — RIPPLE mode is a shell-level toggle (store.ripple), so it reaches the
// backend as one extra argument on the command a gesture already issues: move_clip and
// trim_clip both take {ripple:true} and carry every later clip on the same track. It is
// threaded as an explicit parameter rather than read from the store here so this helper
// stays a pure function (its unit tests call it with no store at all), and it is OMITTED
// entirely when off — the native default is false, and not sending the key keeps a
// ripple-off drag byte-identical to the command this shipped with.
export function commitClipDrag(
  kind: "move" | "trim-l" | "trim-r" | "stretch",
  preview: DragPos | null,
  origStart: number,
  clipId: string,
  exec: Exec,
  setPreview: (p: DragPos | null) => void,
  ripple = false,
): void {
  const rippleArg = ripple ? { ripple: true } : {};
  if (kind === "stretch") {
    // Time-stretch (warp) to the dragged length instead of trimming the source.
    if (preview && preview.length > 0) {
      void exec("stretch_clip", { clipId, length: preview.length }).then((r) => {
        if (rejected(r)) setPreview(null); // rejected → revert the stretch preview
      });
    } else {
      setPreview(null);
    }
    return;
  }
  if (kind === "move") {
    if (preview && Math.abs(preview.start - origStart) > 1e-4) {
      void exec("move_clip", { clipId, start: preview.start, ...rippleArg }).then((r) => {
        if (rejected(r)) setPreview(null); // command rejected → snap back immediately
      });
    } else {
      setPreview(null); // negligible move → drop the preview, no command
    }
    return;
  }

  // trim-l / trim-r
  if (preview) {
    void exec("trim_clip", {
      clipId,
      start: preview.start,
      length: preview.length,
      offset: preview.offset,
      ...rippleArg,
    }).then((r) => {
      if (rejected(r)) setPreview(null); // command rejected → revert the trim preview
    });
  }
}
