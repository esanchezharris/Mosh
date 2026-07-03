// The playhead — a single line driven by the 30Hz transport position. Absolutely
// positioned inside the scrolled timeline grid (so it tracks horizontal scroll),
// offset past the sticky header column. z-index sits below the sticky chrome
// (headers/ruler/ribbon) so it only paints over the lane content.

import { useRef } from "react";
import { useStore } from "../../store";
import { headW } from "./geom";

export function Playhead() {
  const pos = useStore((s) => s.transport.position);
  const pxPerSec = useStore((s) => s.pxPerSec);
  const ref = useRef<HTMLDivElement>(null);
  // Offset past the sticky header column using the LIVE --v2-head-w (never a JS mirror).
  // First paint uses the token-matching fallback; the 30Hz position stream re-reads the
  // mounted node thereafter, so a token/theme change is picked up on the next frame.
  const head = headW(ref.current);
  return <div ref={ref} className="v2-playhead-line" style={{ left: head + pos * pxPerSec }} data-testid="v2-playhead" />;
}
