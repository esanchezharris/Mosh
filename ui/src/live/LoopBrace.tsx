// The arrangement loop brace — REAL now, not a readout (Live 12's ruler loop
// brace): drag the body to move the whole span, drag either end to resize, and
// Live's brace keys (←/→ move by grid, ⌘←/⌘→ halve/double the length — KEYMAP.md
// has no brace row, its modifier-decode gaps are documented there). Every commit
// is one set_transport; the brace never touches the time selection (Live's rule:
// the brace and the time selection are separate surfaces — a ruler shift-drag
// keeps painting the range).

import { useRef, useState } from "react";
import { useStore } from "../store";
import { meterAt, snapStep, tempoMapFrom } from "../time";
import { contentSeconds } from "../v2/timeline/geom";
import type { Snapshot } from "../types";
import { moveLoop, resizeLoopEdge, loopKeyEdit, type LoopSpan } from "./loopBraceGeometry";

const MIN_LEN = 0.05;   // seconds — a loop you can still see and grab

export function LoopBrace({ snapshot }: { snapshot: Snapshot }) {
  const exec = useStore((s) => s.exec);
  const looping = useStore((s) => s.transport.looping);
  const loopStart = useStore((s) => s.transport.loopStart);
  const loopEnd = useStore((s) => s.transport.loopEnd);
  const pxPerSec = useStore((s) => s.pxPerSec);
  const snapDivision = useStore((s) => s.snapDivision);

  // Drag previews locally; set_transport fires once, on release (the splitter's
  // discipline — no command flood at frame rate).
  const [preview, setPreview] = useState<LoopSpan | null>(null);
  const drag = useRef<{ pointerId: number; kind: "move" | "start" | "end"; startX: number; orig: LoopSpan } | null>(null);

  const contentLen = contentSeconds(snapshot);
  const gridSec = snapStep(meterAt(tempoMapFrom(snapshot.session), 0), snapDivision);
  const span: LoopSpan = preview ?? { start: loopStart, end: loopEnd };
  if (!looping || loopEnd - loopStart <= 1e-6) return null;

  const commit = (next: LoopSpan) => {
    if (Math.abs(next.start - loopStart) < 1e-6 && Math.abs(next.end - loopEnd) < 1e-6) return;
    // `loop: true` rides along: the mock (like the engine's loop-write path) only
    // applies loopStart/loopEnd when the loop flag is explicitly set, and the brace
    // only ever exists on an ACTIVE loop anyway.
    void exec("set_transport", { loop: true, loopStart: next.start, loopEnd: next.end });
  };

  const onDown = (kind: "move" | "start" | "end") => (e: React.PointerEvent<HTMLDivElement>) => {
    e.stopPropagation();
    drag.current = { pointerId: e.pointerId, kind, startX: e.clientX, orig: { start: loopStart, end: loopEnd } };
    try { (e.currentTarget.closest('[data-testid="live-loop-brace"]') as HTMLElement).setPointerCapture(e.pointerId); } catch { /* no-op */ }
  };
  const onMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    if (!d || d.pointerId !== e.pointerId) return;
    const dSec = (e.clientX - d.startX) / pxPerSec;
    setPreview(d.kind === "move"
      ? moveLoop(d.orig, dSec, contentLen)
      : resizeLoopEdge(d.orig, d.kind, d.kind === "start" ? d.orig.start + dSec : d.orig.end + dSec, MIN_LEN, contentLen));
  };
  const onUp = (e: React.PointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    if (!d || d.pointerId !== e.pointerId) return;
    drag.current = null;
    try { e.currentTarget.releasePointerCapture(e.pointerId); } catch { /* no-op */ }
    if (preview) commit(preview);
    setPreview(null);
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    const next = loopKeyEdit(span, e.key, e.metaKey || e.ctrlKey, gridSec, contentLen, MIN_LEN);
    if (!next) return;
    // The app keymap binds plain arrows to clip nudge — the brace owns its own.
    e.preventDefault();
    e.stopPropagation();
    commit(next);
  };

  return (
    <div
      className="live-loop-brace"
      data-testid="live-loop-brace"
      role="group"
      aria-label="Loop brace — drag to move, drag an end to resize, ←/→ move by grid, ⌘←/⌘→ halve/double"
      tabIndex={0}
      style={{ left: span.start * pxPerSec, width: (span.end - span.start) * pxPerSec }}
      title="Loop brace — drag to move · drag an end to resize · ←/→ move by grid · ⌘←/⌘→ halve/double"
      onPointerMove={onMove}
      onPointerUp={onUp}
      onPointerCancel={onUp}
      onKeyDown={onKeyDown}
    >
      <div className="live-loop-edge l" data-testid="live-loop-edge-l" onPointerDown={onDown("start")} />
      <div className="live-loop-body" data-testid="live-loop-body" onPointerDown={onDown("move")} />
      <div className="live-loop-edge r" data-testid="live-loop-edge-r" onPointerDown={onDown("end")} />
    </div>
  );
}
