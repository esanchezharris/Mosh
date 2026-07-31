// The song navigator — a whole-song overview strip that sits above the (zoomed) timeline.
// It's NOT the section editor: it's a quick way to JUMP anywhere in the song and to see
// where your collaborators are working. The full song maps to the strip width (independent
// of the timeline's zoom/scroll); click or drag anywhere to seek + bring that spot into
// view. Bar numbers give you your bearings; the lime line is your playhead; colored ticks
// are peers (from multiplayer presence — position/playing/recording).

import { memo, type CSSProperties } from "react";
import { useStore } from "../../store";
import type { Snapshot } from "../../types";
import { contentSeconds, meterOf } from "./geom";
import { barSeconds } from "../../time";
import { usePointerScrub } from "./usePointerScrub";

export function SongNav({ snapshot, onScrub }: { snapshot: Snapshot; onScrub: (sec: number) => void }) {
  const total = Math.max(1, contentSeconds(snapshot));
  const barLen = barSeconds(meterOf(snapshot));
  const totalBars = Math.max(1, Math.ceil(total / barLen));

  // pick a "nice" bar step so ~8 numbered ticks span the song (never crowd the strip)
  const raw = totalBars / 8;
  const step = [1, 2, 4, 8, 16, 32, 64, 128, 256].find((n) => n >= raw) ?? 256;
  const ticks: number[] = [];
  for (let b = 0; b < totalBars; b += step) ticks.push(b);

  const scrub = usePointerScrub(onScrub);
  const positionAt = (element: HTMLDivElement, clientX: number) => {
    const rect = element.getBoundingClientRect();
    const frac = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
    return frac * total;
  };
  const onPointerDown = (e: React.PointerEvent) => {
    const element = e.currentTarget as HTMLDivElement;
    scrub.begin(element, e.pointerId, positionAt(element, e.clientX));
  };
  const onPointerMove = (e: React.PointerEvent) => {
    const element = e.currentTarget as HTMLDivElement;
    scrub.move(e.pointerId, positionAt(element, e.clientX));
  };
  const onPointerUp = (e: React.PointerEvent) => {
    const element = e.currentTarget as HTMLDivElement;
    scrub.end(element, e.pointerId, positionAt(element, e.clientX));
  };
  const onPointerCancel = (e: React.PointerEvent) => {
    scrub.cancel(e.currentTarget as HTMLDivElement, e.pointerId);
  };

  return (
    <div
      className="v2-songnav"
      data-testid="v2-songnav"
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerCancel}
      onLostPointerCapture={onPointerCancel}
      role="slider"
      aria-label="Song position — click or drag to scrub"
      aria-valuemin={1}
      aria-valuemax={totalBars}
      title="Click or drag to scrub across the song"
    >
      {ticks.map((b) => (
        <div key={b} className="v2-songnav-tick" style={{ left: `${((b * barLen) / total) * 100}%` }}>
          <span className="v2-songnav-bar">{b + 1}</span>
        </div>
      ))}
      <SongNavPeers total={total} />
      <SongNavHead total={total} />
    </div>
  );
}

// Your playhead — its own subscriber so the 30 Hz transport feed doesn't re-render the ticks.
const SongNavHead = memo(function SongNavHead({ total }: { total: number }) {
  const pos = useStore((s) => s.transport.position);
  return <div className="v2-songnav-head" style={{ left: `${Math.min(100, (pos / total) * 100)}%` }} aria-hidden />;
});

// Collaborators — where each online peer is parked (recent presence only), colored to match.
function SongNavPeers({ total }: { total: number }) {
  const peerPresence = useStore((s) => s.peerPresence);
  const peers = useStore((s) => s.peers);
  const now = Date.now();
  const visible = Object.entries(peerPresence).filter(([id, p]) => peers[id]?.online && now - p.updatedAtMs < 8000);
  if (visible.length === 0) return null;
  return (
    <>
      {visible.map(([id, p]) => (
        <div
          key={id}
          className={`v2-songnav-peer${p.playing ? " playing" : ""}${p.recording ? " recording" : ""}`}
          data-testid="v2-songnav-peer"
          title={peers[id]?.name ?? id}
          style={{ left: `${Math.min(100, (p.position / total) * 100)}%`, "--peer-color": peers[id]?.color ?? "#ff69a8" } as CSSProperties}
        >
          <span className="v2-songnav-peer-dot" />
        </div>
      ))}
    </>
  );
}
