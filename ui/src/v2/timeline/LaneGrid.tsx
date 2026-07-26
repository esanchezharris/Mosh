// The lane background grid, for projects whose tempo changes.
//
// A lane's stripes are normally a CSS repeating-linear-gradient at one `--beat-px` interval
// (shell.css). That is cheap and correct — but ONLY while every beat is the same width. A
// repeating gradient cannot express a non-uniform grid, so the moment a project holds a
// tempo change the stripes keep tiling at the old spacing while BarRuler above them, which
// reads the piecewise map, re-spaces correctly. The result is a visible seam between the
// authoritative bar grid and the decorative one, directly underneath the clips.
//
// That bug is as old as the v2 lanes; it was invisible only because nothing in the UI could
// create a tempo change. Shipping the tempo lane is what makes it reachable, so it is fixed
// here rather than filed.
//
// The fix is GATED on the map actually being variable: a constant-tempo project — every
// project today — keeps the gradient and renders zero extra DOM. Only once a tempo change
// exists do we pay for real positioned lines, which is exactly when they are needed.

import type { Snapshot } from "../../types";
import { tempoMapFrom, gridLines } from "../../time";
import { contentSeconds } from "./geom";

/** Does this project need real gridlines rather than a repeating gradient? */
export function hasTempoChanges(session: Snapshot["session"]): boolean {
  return (session.tempoMap?.length ?? 1) > 1;
}

export function LaneGrid({ snapshot, pxPerSec }: { snapshot: Snapshot; pxPerSec: number }) {
  const map = tempoMapFrom(snapshot.session);
  const { bars, beats } = gridLines(map, 0, contentSeconds(snapshot));
  return (
    <div className="v2-lanegrid" aria-hidden data-testid="v2-lane-grid">
      {bars.map((b) => <i key={`bar-${b.sec}`} className="v2-gl bar" style={{ left: b.sec * pxPerSec }} />)}
      {beats.map((s) => <i key={`beat-${s}`} className="v2-gl beat" style={{ left: s * pxPerSec }} />)}
    </div>
  );
}
