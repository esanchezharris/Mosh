import { useEffect, useRef, type RefObject } from "react";
import { pushEscapeHandler } from "../hooks/escapeStack";
import { useStore } from "../store";
import type { Snapshot, Track } from "../types";
import { GenDrawer } from "../ui/GenDrawer";

type GenerativeTarget = {
  readonly track: Track;
  readonly selectedClipId?: string;
};

export function resolveProToolsGenerativeTarget(snapshot: Snapshot, state: {
  readonly selectedClipIds: ReadonlySet<string>;
  readonly editingClipId: string | null;
  readonly selectedTrackId: string | null;
}): GenerativeTarget | null {
  const visible = snapshot.tracks.flatMap((track) => track.clips
    .filter((clip) => !clip.hidden)
    .map((clip) => ({ clip, track })));
  const selected = visible.find(({ clip }) => state.selectedClipIds.has(clip.id));
  if (selected) return { track: selected.track, selectedClipId: selected.clip.id };
  const editing = visible.find(({ clip }) => clip.id === state.editingClipId);
  if (editing) return { track: editing.track, selectedClipId: editing.clip.id };
  const selectedTrack = snapshot.tracks.find((track) => track.id === state.selectedTrackId);
  if (selectedTrack) {
    return {
      track: selectedTrack,
      selectedClipId: selectedTrack.clips.find((clip) => !clip.hidden)?.id,
    };
  }
  const first = visible[0];
  return first ? { track: first.track, selectedClipId: first.clip.id } : null;
}

export function ProToolsGenerativeDrawer({ snapshot, open, onClose, returnFocusRef }: {
  readonly snapshot: Snapshot;
  readonly open: boolean;
  readonly onClose: () => void;
  readonly returnFocusRef: RefObject<HTMLButtonElement>;
}) {
  const drawerRef = useRef<HTMLElement>(null);
  const selectedClipIds = useStore((state) => state.selection);
  const editingClipId = useStore((state) => state.editingClipId);
  const selectedTrackId = useStore((state) => state.selectedTrackId);
  const target = resolveProToolsGenerativeTarget(snapshot, {
    selectedClipIds,
    editingClipId,
    selectedTrackId,
  });

  useEffect(() => open ? pushEscapeHandler(onClose) : undefined, [onClose, open]);
  useEffect(() => {
    if (!open) return undefined;
    const returnFocus = returnFocusRef.current;
    const body = drawerRef.current?.querySelector<HTMLElement>(".pt-generative-body");
    const firstBodyAction = body?.querySelector<HTMLElement>(
      "input:not([disabled]), select:not([disabled]), button:not([disabled]), [tabindex]:not([tabindex='-1'])",
    );
    const closeAction = drawerRef.current?.querySelector<HTMLElement>("[data-testid=pt-generative-close]");
    (firstBodyAction ?? closeAction)?.focus();
    return () => returnFocus?.focus();
  }, [open, returnFocusRef]);

  if (!open) return null;
  return (
    <aside ref={drawerRef} id="pt-generative-drawer" className="pt-generative-drawer"
      data-testid="pt-generative-drawer" role="complementary" aria-label="Generative Re-imagine">
      <header className="pt-generative-head">
        <div><strong>Re-imagine</strong><span>Selected clip · SA3 or preview</span></div>
        <button type="button" data-testid="pt-generative-close" onClick={onClose}>Close</button>
      </header>
      <div className="pt-generative-body">
        {target
          ? <GenDrawer key={target.selectedClipId ?? target.track.id}
              track={target.track} selectedClipId={target.selectedClipId} />
          : <div className="pt-generative-empty" role="status">
            Add and select a clip to compile, transform, or re-imagine it.
          </div>}
      </div>
    </aside>
  );
}
