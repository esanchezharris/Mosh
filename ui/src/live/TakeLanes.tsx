// The live shell's TAKE LANES (Live 12 ground truth): a track whose wave clips
// carry takes (numTakes > 1) shows sub-lanes BELOW the main lane — one row per
// take index, each take painted inside its clip's time extent (same pxPerSec /
// scroll coordinate space as the lanes; the row is a sibling of the track's lane
// in the same .live-lanes stack, so scroll sync comes free). The current take is
// the one playing in the main lane; clicking a take bar makes it current
// (set_current_take, undoable); the current bar carries a small Keep button
// (keep_take — Live's flatten idiom, undoable).
//
// Per-take waveforms (take-lanes wave): list_takes carries an additive `peaks`
// field per take ([min,max] buckets — the main-lane shape), so a take bar with
// peaks draws the take's waveform ink, dimmer than the main lane (the current
// bar keeps its accent). A take WITHOUT peaks (missing/unreadable source)
// renders the labeled bar exactly as before — the honest fallback is the
// absence of ink, never a blank bar. Region comping (assembling one comp from
// take REGIONS) is a later wave — it needs a comp-region edit model.
//
// Data discipline: list_takes is fetched lazily per clip, only for clips with
// numTakes > 1, and refetched when the snapshot's numTakes/currentTakeIndex
// changes (set_current_take / keep_take invalidate the snapshot — the effect's
// signature dep keys the refetch exactly).

import { useEffect, useRef, useState } from "react";
import { useStore } from "../store";
import type { ClipTake, Track } from "../types";
import type { TakeLanesLayout } from "./takeLanesLayout";
import { peaksToColumns } from "./takeWave";

export const TAKE_ROW_H = 18;

type TakesInfo = { takes: ClipTake[]; currentTakeIndex: number };

// One take's waveform ink: the engine's [min,max] buckets resampled to one
// amplitude pair per canvas column (peaksToColumns — pure, unit-pinned). Tokens
// resolve through getComputedStyle at paint time (canvas can't read var()).
function TakeWave({ peaks, widthPx, current }: { peaks: [number, number][]; widthPx: number; current: boolean }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    const cols = peaksToColumns(peaks, widthPx);
    canvas.width = Math.max(1, cols.length);
    canvas.height = TAKE_ROW_H - 4;
    canvas.style.width = `${canvas.width}px`;
    const ctx = canvas.getContext("2d");
    if (ctx == null || cols.length === 0) return;
    const styles = getComputedStyle(canvas);
    ctx.strokeStyle = current
      ? styles.getPropertyValue("--live-accent").trim() || "#e8a33d"
      : styles.getPropertyValue("--live-text-dim").trim() || "#8a8a8a";
    ctx.globalAlpha = current ? 0.9 : 0.55;   // dimmer than the main lane, Live's look
    ctx.lineWidth = 1;
    const mid = canvas.height / 2;
    const halfH = mid - 0.5;
    cols.forEach(([mn, mx], x) => {
      ctx.beginPath();
      ctx.moveTo(x + 0.5, mid - mx * halfH);
      ctx.lineTo(x + 0.5, mid - mn * halfH);
      ctx.stroke();
    });
  }, [peaks, widthPx, current]);
  return <canvas ref={ref} className="live-takewave" data-testid="live-takewave" aria-hidden="true" />;
}

export function TakeLanes({ track, layout }: { track: Track; layout: TakeLanesLayout }) {
  const pxPerSec = useStore((s) => s.pxPerSec);
  const [infoByClip, setInfoByClip] = useState<Record<string, TakesInfo>>({});

  // The clips this layout paints, and the signature that changes when any of
  // their take trees do (snapshot-driven; cheap to compute every render).
  const clipsWithTakes = track.clips.filter((c) => (c.numTakes ?? 0) > 1);
  const sig = clipsWithTakes.map((c) => `${c.id}:${c.numTakes}:${c.currentTakeIndex ?? 0}`).join("|");

  useEffect(() => {
    let cancelled = false;
    const exec = useStore.getState().exec;
    void (async () => {
      const entries: [string, TakesInfo][] = [];
      for (const c of clipsWithTakes) {
        const res = await exec("list_takes", { clipId: c.id });
        const d = res.ok ? (res as { data?: { takes?: ClipTake[]; currentTakeIndex?: number } }).data : undefined;
        if (d?.takes)
          entries.push([c.id, { takes: d.takes, currentTakeIndex: d.currentTakeIndex ?? c.currentTakeIndex ?? 0 }]);
      }
      if (!cancelled) setInfoByClip(Object.fromEntries(entries));
    })();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `sig` captures the clips
  }, [sig]);

  return (
    <div className="live-takelanes" data-testid="live-takelanes" data-track-id={track.id}>
      {layout.bars.map((row, rowIndex) => (
        <div className="live-takerow" data-testid="live-takerow" key={rowIndex} style={{ height: TAKE_ROW_H }}>
          {row.map((bar) => {
            const info = infoByClip[bar.clipId];
            const take = info?.takes.find((t) => t.index === bar.takeIndex);
            const current = (info?.currentTakeIndex ?? 0) === bar.takeIndex;
            const clip = clipsWithTakes.find((c) => c.id === bar.clipId);
            const label = take?.description ?? `Take ${bar.takeIndex + 1}`;
            return (
              <div
                key={`${bar.clipId}:${bar.takeIndex}`}
                className={`live-takebar${current ? " cur" : ""}`}
                data-testid="live-takebar"
                data-clip-id={bar.clipId}
                data-take-index={bar.takeIndex}
                data-current={current}
                role="button"
                tabIndex={0}
                aria-pressed={current}
                aria-label={`${label} on ${track.name}`}
                title={current ? `${label} — playing` : `Make ${label} the current take`}
                style={{
                  left: bar.leftSec * pxPerSec,
                  width: Math.max(28, bar.widthSec * pxPerSec),
                }}
                onPointerDown={(e) => e.stopPropagation()}   // ClipView's discipline: the lane's empty-ground handlers must not claim this press
                onClick={() => void useStore.getState().exec("set_current_take", { clipId: bar.clipId, takeIndex: bar.takeIndex })}
                onKeyDown={(e) => {
                  if (e.key !== "Enter" && e.key !== " ") return;
                  e.preventDefault();
                  void useStore.getState().exec("set_current_take", { clipId: bar.clipId, takeIndex: bar.takeIndex });
                }}
              >
                {take?.peaks != null && take.peaks.length > 0 && (
                  <TakeWave peaks={take.peaks} widthPx={Math.max(28, bar.widthSec * pxPerSec) - 8} current={current} />
                )}
                <span className="live-takebar-label">{bar.takeIndex + 1} · {label} · {clip ? `${clip.length.toFixed(1)}s` : ""}</span>
                {current && (
                  <button
                    className="live-take-keep"
                    data-testid="live-take-keep"
                    title="Keep this take and delete the others (keep_take — flatten, undoable)"
                    onClick={(e) => { e.stopPropagation(); void useStore.getState().exec("keep_take", { clipId: bar.clipId }); }}
                  >Keep</button>
                )}
              </div>
            );
          })}
        </div>
      ))}
    </div>
  );
}
