// The status bar (SPEC §9) — ~15pt, full width, at the very bottom. Left: the
// context line (selection readout when something is selected, else the playhead
// position — the wording lives in statusReadout.ts, pure + unit-tested). Right: the
// current-track chip (colour + name).

import { useStore } from "../store";
import { tempoMapFrom } from "../time";
import { statusReadout } from "./statusReadout";
import type { Snapshot } from "../types";

export function StatusBar({ snapshot }: { snapshot: Snapshot | null }) {
  const selection = useStore((s) => s.selection);
  const transport = useStore((s) => s.transport);
  const selectedTrackId = useStore((s) => s.selectedTrackId);
  const map = tempoMapFrom(snapshot?.session);
  const track = snapshot?.tracks.find((t) => t.id === selectedTrackId) ?? null;

  return (
    <footer className="live-statusbar" data-testid="live-statusbar">
      <span className="live-status-readout" data-testid="live-status-readout">
        {statusReadout(snapshot, selection, transport, map)}
      </span>
      {track && (
        <span className="live-status-track" data-testid="live-status-track" title="Current track">
          <span className="live-status-dot" style={{ background: track.color ?? "var(--live-text-dim)" }} aria-hidden="true" />
          {track.name}
        </span>
      )}
    </footer>
  );
}
