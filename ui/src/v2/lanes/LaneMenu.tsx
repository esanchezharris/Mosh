// The empty-lane menu: what you can put on a track that has nothing here yet.
//
// Dismissal/portal behaviour mirrors ClipView's ClipMenu verbatim (portal to body,
// pointerdown-or-Escape closes, one tick's delay so the opening event does not
// immediately close it) so both menus feel identical.

import { useEffect } from "react";
import { createPortal } from "react-dom";
import { useStore } from "../../store";
import { useShell } from "../shellState";
import type { Track } from "../../types";

export function LaneMenu({ x, y, track, start, barLen, onClose }: {
  // `start` is the bar-snapped seconds under the pointer, computed by the caller with the
  // same snappedSecAt the double-click path uses — so "Add MIDI clip" lands where you
  // right-clicked, not at bar 1.
  x: number; y: number; track: Track; start: number; barLen: number; onClose: () => void;
}) {
  const exec = useStore((s) => s.exec);
  const openBrowserTab = useShell((s) => s.openBrowserTab);
  useEffect(() => {
    const close = () => onClose();
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    const t = window.setTimeout(() => { window.addEventListener("pointerdown", close); window.addEventListener("keydown", onKey); }, 0);
    return () => { window.clearTimeout(t); window.removeEventListener("pointerdown", close); window.removeEventListener("keydown", onKey); };
  }, [onClose]);
  const run = (fn: () => void) => { fn(); onClose(); };
  // The track is already selected by the lane handler before this menu opens — both the
  // plugin picker and the sample browser load onto the SELECTED track.
  return createPortal(
    <div className="v2-lanemenu" role="menu" data-testid="v2-lane-menu" style={{ left: x, top: y }} onPointerDown={(e) => e.stopPropagation()}>
      <button role="menuitem" data-testid="lane-add-instrument"
        onClick={() => run(() => openBrowserTab("plugins", "inst"))}>
        {track.isInstrument ? "Swap instrument…" : "Add instrument…"}
      </button>
      <button role="menuitem" data-testid="lane-import-audio"
        onClick={() => run(() => openBrowserTab("sounds"))}>Import audio…</button>
      {/* Always enabled, including on a bare track: it is an explicit request, and the
          backend's DRM-001 policy loads a default instrument in the same transaction so
          the clip lands audible rather than silent. */}
      <button role="menuitem" data-testid="lane-add-midi-clip"
        onClick={() => run(() => void exec("add_midi_clip", { trackId: track.id, start, length: barLen }))}>
        Add MIDI clip
      </button>
    </div>,
    document.body,
  );
}
