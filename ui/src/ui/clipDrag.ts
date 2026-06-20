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

export function commitClipDrag(
  kind: "move" | "trim-l" | "trim-r",
  preview: DragPos | null,
  origStart: number,
  clipId: string,
  exec: Exec,
  setPreview: (p: DragPos | null) => void,
): void {
  if (kind === "move") {
    if (preview && Math.abs(preview.start - origStart) > 1e-4) {
      void exec("move_clip", { clipId, start: preview.start }).then((r) => {
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
    }).then((r) => {
      if (rejected(r)) setPreview(null); // command rejected → revert the trim preview
    });
  }
}
