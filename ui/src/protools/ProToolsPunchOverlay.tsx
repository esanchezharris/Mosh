import { useStore } from "../store";
import type { Snapshot } from "../types";
import {
  proToolsPreRollRange,
  resolveProToolsPunchRange,
} from "./punchRecording";

export function ProToolsPunchOverlay({ snapshot }: { readonly snapshot: Snapshot }) {
  const pxPerSec = useStore((state) => state.pxPerSec);
  const transport = useStore((state) => state.transport);
  const punchEnabled = snapshot.session.project?.recordOptions?.punchInOut ?? false;
  const punchRange = punchEnabled ? resolveProToolsPunchRange(null, transport) : null;
  const captureStart = punchRange?.start ?? transport.position;
  const preRoll = proToolsPreRollRange(snapshot, captureStart);
  const preRollBars = snapshot.session.countInBars ?? snapshot.session.project?.countInBars ?? 0;

  if (!punchRange && !preRoll) return null;
  return (
    <div className="pt-record-range-overlays" aria-hidden="true">
      {preRoll && (
        <div className="pt-preroll-overlay" data-testid="pt-preroll-overlay"
          style={{ left: preRoll.start * pxPerSec, width: (preRoll.end - preRoll.start) * pxPerSec }}>
          <span>PRE {preRollBars} {preRollBars === 1 ? "BAR" : "BARS"}</span>
        </div>
      )}
      {punchRange && (
        <div className="pt-punch-overlay" data-testid="pt-punch-overlay"
          style={{ left: punchRange.start * pxPerSec, width: (punchRange.end - punchRange.start) * pxPerSec }}>
          <span className="pt-punch-in-flag">PUNCH IN</span>
          <span className="pt-punch-out-flag">OUT</span>
        </div>
      )}
    </div>
  );
}
