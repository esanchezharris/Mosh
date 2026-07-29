// Bottom dock for the selected track (classic shell only): the plugin/neural RACK
// (Stage 3/4) on the left and the generative DRAWER (Stage 5) on the right. Rack and
// GenDrawer live in their own modules (Rack.tsx / GenDrawer.tsx) — both shells import
// them from there; this wrapper is the classic shell's arrangement of them.

import { useStore } from "../store";
import { useSettings } from "../settings/store";
import type { Snapshot } from "../types";
import { Moshi } from "./Moshi";
import { Rack } from "./Rack";
import { GenDrawer } from "./GenDrawer";

export function Dock({ snapshot }: { snapshot: Snapshot }) {
  const selectedTrackId = useStore((s) => s.selectedTrackId);
  const track = snapshot.tracks.find((t) => t.id === selectedTrackId) ?? null;
  // In the redesign, Moshi is a participant in the Session rail, not in the dock.
  const redesign = useSettings((s) => Boolean(s.get("redesignShell")));
  return (
    <div className="dock" data-testid="dock">
      <Rack track={track} />
      {track && <GenDrawer track={track} />}
      {!redesign && <Moshi />}
    </div>
  );
}
