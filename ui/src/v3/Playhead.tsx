import { useStore } from "../store";
import { playheadLeftPx } from "./timeline";

/** The arrangement's playhead: one accent line down every row, driven by the 30 Hz transport
 *  position on the shared zoom. It lives inside the `.rows` stack so it scrolls with the lanes
 *  and spans them all; z-index sits under the sticky headers so it only paints over lane content. */
export function Playhead() {
  const position = useStore((s) => s.transport.position);
  const pxPerSec = useStore((s) => s.pxPerSec);
  return <div className="playhead" data-testid="v3-playhead" aria-hidden="true" style={{ left: playheadLeftPx(position, pxPerSec) }} />;
}

/** The playhead's marker in the ruler — same position, lane-relative (the ruler starts at the lane). */
export function RulerMarker() {
  const position = useStore((s) => s.transport.position);
  const pxPerSec = useStore((s) => s.pxPerSec);
  return <div className="ph-marker" data-testid="v3-ruler-marker" aria-hidden="true" style={{ left: Math.max(0, position) * pxPerSec }} />;
}
