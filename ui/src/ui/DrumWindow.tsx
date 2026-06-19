// The FL-style drum machine as a floating window (Phase 6) — the step sequencer
// surfaced OUTSIDE the piano-roll modal, bound to a drum track's clip. Opened from
// a drum track's badge; edits go through the same note commands. Auto-closes if its
// clip disappears.

import { useStore } from "../store";
import { useDrumWindow } from "./dock/useFloatingWindow";
import { FloatingWindow } from "./dock/FloatingWindow";
import { DrumSequencer } from "./DrumSequencer";

export function DrumWindow() {
  const clipId = useDrumWindow((s) => s.clipId);
  const win = useDrumWindow((s) => s.win);
  const close = useDrumWindow((s) => s.close);
  const move = useDrumWindow((s) => s.move);
  const resize = useDrumWindow((s) => s.resize);
  const snapshot = useStore((s) => s.snapshot);

  const clip = clipId ? snapshot?.tracks.flatMap((t) => t.clips).find((c) => c.id === clipId) ?? null : null;
  if (!clipId || !clip) return null;

  return (
    <FloatingWindow win={win} title={`Drum Machine · ${clip.name}`} onMove={move} onResize={resize} onClose={close}>
      <DrumSequencer clip={clip} />
    </FloatingWindow>
  );
}
