// The tempo lane — where a song changes speed.
//
// A thin row inside the timeline grid, between the section ribbon and the bar ruler, over
// the same seconds x-axis as the clips. Two gestures, both mapping to commands that already
// existed with no UI:
//   • click empty space → an inline BPM field at the bar-snapped position → insert_tempo_change
//   • ✕ on a marker     → remove_tempo_change
//
// WHY THIS DOES NOT IMPORT geom.ts. `geom.ts` derives everything from session.tempo — ONE
// number, the tempo at time zero. That is correct only while the tempo never changes, which
// is exactly the assumption this feature exists to break. Positions here come from time.ts's
// piecewise map (tempoMapFrom / snapTimeMap / meterAt), the same machinery BarRuler and clip
// snapping already use. Copying the ribbon's beatToSec/secToBeat calls would have looked
// right and placed every marker after the first tempo change in the wrong place.
//
// SCOPE, deliberately: create and remove only, and every point we create is a STEP change
// (we never send `curve`, whose default of 1.0 means "hold, then jump"). There is no
// backend command to edit a point in place — changing one is remove+insert, two undo steps —
// so a drag-to-move or click-to-retype gesture would ship a non-atomic edit. Ramps
// (set_tempo_curve) are separately deferred for the same reason.

import { useEffect, useRef, useState } from "react";
import { useStore } from "../../store";
import type { Snapshot } from "../../types";
import { tempoMapFrom, snapTimeMap, meterAt } from "../../time";

export type TempoPoint = { time: number; bpm: number; curve?: number };

/** The tempo map as the UI should read it: always at least the base point, so a project
 *  that predates SES-001 (no tempoMap in its snapshot) still renders its one tempo. */
export function tempoPoints(session: Snapshot["session"]): TempoPoint[] {
  const map = session.tempoMap;
  if (map && map.length > 0) return map;
  return [{ time: 0, bpm: session.tempo ?? 120, curve: 1 }];
}

/** Resolve a point's index in the CURRENT map. remove_tempo_change takes an array index,
 *  not an id, so an index captured at render time goes stale the moment any other point is
 *  inserted or removed — and the stale index points at someone else's tempo change. */
export function indexOfPointAt(points: readonly TempoPoint[], time: number): number {
  return points.findIndex((p) => p.time === time);
}

export function TempoRibbon({ snapshot, width }: { snapshot: Snapshot; width: number }) {
  const exec = useStore((s) => s.exec);
  const pxPerSec = useStore((s) => s.pxPerSec);
  const points = tempoPoints(snapshot.session);
  const map = tempoMapFrom(snapshot.session);

  const [draft, setDraft] = useState<{ time: number; bpm: string } | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  useEffect(() => { if (draft && inputRef.current) { inputRef.current.focus(); inputRef.current.select(); } }, [draft]);

  const openAt = (clientX: number, rect: DOMRect) => {
    const raw = Math.max(0, (clientX - rect.left) / pxPerSec);
    const time = snapTimeMap(map, raw, "bar");
    if (indexOfPointAt(points, time) >= 0) return;   // a point already lives on this bar
    // Seed with the tempo currently governing that spot, so committing without typing is a
    // no-op change rather than a jump to some arbitrary default.
    setDraft({ time, bpm: String(Math.round(meterAt(map, time).tempo)) });
  };

  const commit = async () => {
    if (!draft) return;
    const bpm = Number(draft.bpm);
    setDraft(null);
    // The backend's own range. Rejecting here keeps a typo from becoming an error toast.
    if (!Number.isFinite(bpm) || bpm < 20 || bpm > 999) return;
    await exec("insert_tempo_change", { time: draft.time, bpm });
  };

  const remove = async (time: number) => {
    const i = indexOfPointAt(tempoPoints(useStore.getState().snapshot?.session ?? snapshot.session), time);
    if (i <= 0) return;   // index 0 is the engine's base tempo — removeTempo() no-ops on it
    await exec("remove_tempo_change", { index: i });
  };

  return (
    <div
      className="v2-tempolane" style={{ width }} data-testid="v2-tempo-lane"
      // CLICK, not pointerdown. A real mouse press is pointerdown → mousedown → mouseup: if
      // the field opens on pointerdown, the mousedown that follows lands on the lane and
      // blurs the input we just focused, whose onBlur commits and closes it. The field
      // flashed and vanished. Opening on click puts the focus after the blur.
      onClick={(e) => {
        if (e.target !== e.currentTarget) return;   // let markers and the input handle their own
        openAt(e.clientX, e.currentTarget.getBoundingClientRect());
      }}
      title="Click to add a tempo change"
    >
      {points.map((p, i) => (
        <div
          key={`${p.time}-${i}`} className={`v2-tempo-pt${i === 0 ? " base" : ""}`}
          style={{ left: p.time * pxPerSec }}
          data-testid="v2-tempo-point" data-time={p.time} data-bpm={p.bpm}
          title={i === 0 ? `${p.bpm} BPM from the start — change it in the transport bar` : `${p.bpm} BPM from here`}
        >
          <span className="v2-tempo-bpm">{Math.round(p.bpm)}</span>
          {i > 0 && (
            <button
              className="v2-tempo-rm" data-testid="v2-tempo-remove"
              title="Remove this tempo change" aria-label={`Remove tempo change at ${Math.round(p.bpm)} BPM`}
              onPointerDown={(e) => e.stopPropagation()}
              onClick={(e) => { e.stopPropagation(); void remove(p.time); }}
            >×</button>
          )}
        </div>
      ))}
      {draft && (
        <input
          ref={inputRef} className="v2-tempo-input" data-testid="v2-tempo-input"
          type="number" min={20} max={999} value={draft.bpm}
          style={{ left: draft.time * pxPerSec }}
          aria-label="Tempo in BPM"
          onPointerDown={(e) => e.stopPropagation()}
          onChange={(e) => setDraft({ ...draft, bpm: e.target.value })}
          onKeyDown={(e) => {
            if (e.key === "Enter") { e.preventDefault(); void commit(); }
            else if (e.key === "Escape") { e.preventDefault(); setDraft(null); }
          }}
          onBlur={() => void commit()}
        />
      )}
    </div>
  );
}
