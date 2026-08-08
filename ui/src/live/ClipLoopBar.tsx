// The wave clip view's loop bar (CLP-LOOP) — the clip's source span with its loop
// region as a draggable brace, Live's clip-view loop brace. Commands: set_clip_loop
// (the only loop seam; engine + mock agree: "looping" IS loop length > 0). MIDI
// clips join through the same seam's MIDI branch (content-relative beats converted
// at the session tempo) — Live's brace, one surface for both clip types.

import { useRef, useState } from "react";
import { useStore } from "../store";
import { MoshTip } from "../chrome/Tooltip";
import { beatSeconds, meterAt, tempoMapFrom } from "../time";
import type { Clip } from "../types";

export function ClipLoopBar({ clip }: { clip: Clip }) {
  const exec = useStore((s) => s.exec);
  const snapshot = useStore((s) => s.snapshot);
  const isMidi = clip.type === "midi";
  // MIDI loop fields are content-relative BEATS; the bar's display math is seconds
  // at the session tempo (mock and engine both convert at the clip's own tempo).
  const beatSec = snapshot ? beatSeconds(meterAt(tempoMapFrom(snapshot.session), clip.start)) : 0.5;
  const span = isMidi
    ? Math.max(0.01, clip.length)
    : Math.max(0.01, clip.sourceLength ?? clip.length);
  const loopLen = isMidi ? (clip.midiLoopLengthBeats ?? 0) * beatSec : (clip.loopLength ?? 0);
  const loopStart = isMidi ? (clip.midiLoopStartBeats ?? 0) * beatSec : (clip.loopStart ?? 0);
  const enabled = isMidi ? (clip.midiLoopLengthBeats ?? 0) > 1e-9 : !!clip.loopEnabled && loopLen > 1e-6;

  // Drag previews locally; the command fires once, on release (same discipline as
  // the dock splitter — no command flood at frame rate).
  const [preview, setPreview] = useState<number | null>(null);
  const drag = useRef<{ pointerId: number; startX: number; origStart: number; trackW: number } | null>(null);
  const shownStart = preview ?? loopStart;

  const onBraceDown = (e: React.PointerEvent<HTMLDivElement>) => {
    const track = (e.currentTarget.parentElement as HTMLElement).getBoundingClientRect();
    drag.current = { pointerId: e.pointerId, startX: e.clientX, origStart: shownStart, trackW: track.width };
    try { e.currentTarget.setPointerCapture(e.pointerId); } catch { /* no-op */ }
    e.stopPropagation();
  };
  const onBraceMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    if (!d || d.pointerId !== e.pointerId) return;
    const dSec = ((e.clientX - d.startX) / Math.max(1, d.trackW)) * span;
    setPreview(Math.max(0, Math.min(span - loopLen, d.origStart + dSec)));
  };
  const onBraceUp = (e: React.PointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    if (!d || d.pointerId !== e.pointerId) return;
    drag.current = null;
    try { e.currentTarget.releasePointerCapture(e.pointerId); } catch { /* no-op */ }
    if (preview != null && Math.abs(preview - loopStart) > 1e-6)
      void exec("set_clip_loop", { clipId: clip.id, enabled: true, start: preview, length: loopLen });
    setPreview(null);
  };

  return (
    <div className="live-loopbar-row">
      <MoshTip side="top" label={enabled
        ? "Clip loop ON — the clip repeats this region of its source. Drag the brace to move it."
        : "Clip loop OFF — the clip plays straight through. Enable to loop a region of the source."}>
        <button
          className="live-cb-btn"
          data-testid="live-loopbar-toggle"
          aria-pressed={enabled}
          data-on={enabled}
          onClick={() => void exec("set_clip_loop", enabled
            ? { clipId: clip.id, enabled: false }
            : { clipId: clip.id, enabled: true })}
        >⟳</button>
      </MoshTip>
      <div className="live-loopbar" data-testid="live-loopbar" aria-label="Clip loop region">
        {enabled && (
          <div
            className="live-loopbar-brace"
            data-testid="live-loopbar-brace"
            role="slider"
            aria-label="Loop start"
            aria-valuenow={shownStart}
            aria-valuemin={0}
            aria-valuemax={Math.max(0, span - loopLen)}
            tabIndex={0}
            style={{ left: `${(shownStart / span) * 100}%`, width: `${(loopLen / span) * 100}%` }}
            onPointerDown={onBraceDown}
            onPointerMove={onBraceMove}
            onPointerUp={onBraceUp}
            onPointerCancel={onBraceUp}
            onKeyDown={(e) => {
              const step = span / 100;
              const delta = e.key === "ArrowLeft" ? -step : e.key === "ArrowRight" ? step : 0;
              if (delta === 0) return;
              e.preventDefault();
              const next = Math.max(0, Math.min(span - loopLen, shownStart + delta));
              void exec("set_clip_loop", { clipId: clip.id, enabled: true, start: next, length: loopLen });
            }}
          />
        )}
      </div>
      <span className="live-loopbar-readout" data-testid="live-loopbar-readout">
        {enabled ? `${shownStart.toFixed(2)}s + ${loopLen.toFixed(2)}s of ${span.toFixed(2)}s` : "loop off"}
      </span>
    </div>
  );
}

/** The beat→second readout for a MIDI loop region (control-bar/status use). */
export function midiLoopSummary(clip: Clip, beatSec: number): string {
  const len = (clip.midiLoopLengthBeats ?? 0) * beatSec;
  if (len <= 0) return "loop off";
  return `${((clip.midiLoopStartBeats ?? 0) * beatSec).toFixed(2)}s + ${len.toFixed(2)}s`;
}
