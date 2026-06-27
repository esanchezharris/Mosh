// The playhead — a single line driven by the 30Hz transport position. Absolutely
// positioned inside the scrolled timeline grid (so it tracks horizontal scroll),
// offset past the sticky header column. z-index sits below the sticky chrome
// (headers/ruler/ribbon) so it only paints over the lane content.

import { useStore } from "../../store";
import { HEAD_W } from "./geom";

export function Playhead() {
  const pos = useStore((s) => s.transport.position);
  const pxPerSec = useStore((s) => s.pxPerSec);
  return <div className="v2-playhead-line" style={{ left: HEAD_W + pos * pxPerSec }} data-testid="v2-playhead" />;
}
