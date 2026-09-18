import { useEffect, useRef, useState, type RefObject } from "react";
import { pushEscapeHandler } from "../hooks/escapeStack";
import { useStore } from "../store";
import type { Snapshot, Track } from "../types";
import { GenDrawer } from "../ui/GenDrawer";

type GenerativeTarget = {
  readonly track: Track;
  readonly selectedClipId: string;
};

export function resolveProToolsGenerativeTarget(snapshot: Snapshot, state: {
  readonly selectedClipIds: ReadonlySet<string>;
}): GenerativeTarget | null {
  if (state.selectedClipIds.size !== 1) return null;
  for (const track of snapshot.tracks) {
    const clip = track.clips.find((candidate) => state.selectedClipIds.has(candidate.id)
      && candidate.type === "wave" && !candidate.hidden);
    if (clip) return { track, selectedClipId: clip.id };
  }
  return null;
}

export function ProToolsGenerativeDrawer({ snapshot, open, onClose, returnFocusRef }: {
  readonly snapshot: Snapshot;
  readonly open: boolean;
  readonly onClose: () => void;
  readonly returnFocusRef: RefObject<HTMLButtonElement>;
}) {
  const drawerRef = useRef<HTMLElement>(null);
  const selectedClipIds = useStore((state) => state.selection);
  const projectEpoch = useStore((state) => state.projectEpoch);
  const [openedTarget, setOpenedTarget] = useState<{ readonly clipId: string | null; readonly epoch: number } | null>(null);
  if (open && !openedTarget) {
    const selected = resolveProToolsGenerativeTarget(snapshot, {
      selectedClipIds,
    });
    setOpenedTarget({ clipId: selected?.selectedClipId ?? null, epoch: projectEpoch });
  } else if (!open && openedTarget) {
    setOpenedTarget(null);
  }
  const pinnedId = openedTarget?.epoch === projectEpoch ? openedTarget.clipId : null;
  const target = pinnedId ? resolveProToolsGenerativeTarget(snapshot, {
    selectedClipIds: new Set([pinnedId]),
  }) : null;

  useEffect(() => open ? pushEscapeHandler(onClose) : undefined, [onClose, open]);
  useEffect(() => {
    if (!open) return undefined;
    const returnFocus = returnFocusRef.current;
    const body = drawerRef.current?.querySelector<HTMLElement>(".pt-generative-body");
    const firstBodyAction = body?.querySelector<HTMLElement>("input:not([disabled]), select:not([disabled])")
      ?? body?.querySelector<HTMLElement>("button:not([disabled]), [tabindex]:not([tabindex='-1'])");
    const closeAction = drawerRef.current?.querySelector<HTMLElement>("[data-testid=pt-generative-close]");
    (firstBodyAction ?? closeAction)?.focus();
    return () => returnFocus?.focus();
  }, [open, returnFocusRef]);

  if (!open) return null;
  return (
    <aside ref={drawerRef} id="pt-generative-drawer" className="pt-generative-drawer"
      data-testid="pt-generative-drawer" role="complementary" aria-label="Generative Re-imagine">
      <header className="pt-generative-head">
        <div><strong>Re-imagine</strong><span>Selected audio clip · Local SA3</span></div>
        <button type="button" data-testid="pt-generative-close" onClick={onClose}>Close</button>
      </header>
      <div className="pt-generative-body">
        {target
          ? <GenDrawer key={target.selectedClipId ?? target.track.id}
              track={target.track} selectedClipId={target.selectedClipId} direct />
          : <div className="pt-generative-empty" role="status">
            Select one audio clip, then reopen Re-imagine.
          </div>}
      </div>
    </aside>
  );
}
