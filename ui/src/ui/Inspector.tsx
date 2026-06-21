// Inspector right-rail (sub-phase 1 placeholder). Full volume/pan/sends + selected-item
// params land in sub-phase 2–3; for the skeleton this just establishes the rail surface.
import type { Snapshot } from "../types";
import { useStore } from "../store";

export function Inspector({ snapshot }: { snapshot: Snapshot }) {
  const selectedTrackId = useStore((s) => s.selectedTrackId);
  const track = snapshot.tracks.find((t) => t.id === selectedTrackId);
  return (
    <div className="inspector" data-testid="inspector">
      <div className="inspector-head">Inspector</div>
      <div className="inspector-body">
        {track ? track.name : "Select a track to see its controls."}
      </div>
    </div>
  );
}
