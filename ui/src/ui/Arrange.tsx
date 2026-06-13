// The new arrangement view. Rebuilt from scratch on the command/snapshot seam,
// with ONE canonical musical grid: every horizontal position — ruler, grid lines,
// clips, playhead — is `sec * pxPerSec`, and the grid lines come solely from
// time.ts `gridLines()`. No CSS background-grid competes with it (the old
// double-grid bug). Every interactive element carries data-* state so an agent
// (or the macOS automation gate) can read the UI structurally, not by pixels.

import { useEffect, useMemo, useRef } from "react";
import { useStore, type Peaks } from "../store";
import { tempoMapFrom, gridLines } from "../time";
import type { Snapshot, Track, Clip } from "../types";

const LANE_H = 76;

export function Arrange({ snapshot }: { snapshot: Snapshot }) {
  const pxPerSec = useStore((s) => s.pxPerSec);
  const selection = useStore((s) => s.selection);
  const select = useStore((s) => s.select);
  const clearSelection = useStore((s) => s.clearSelection);
  const exec = useStore((s) => s.exec);
  const tool = useStore((s) => s.tool);
  const snapTime = useStore((s) => s.snapTime);

  const headersRef = useRef<HTMLDivElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  const tracks = snapshot.tracks;
  const map = useMemo(() => tempoMapFrom(snapshot.session), [snapshot.session]);

  // Content span: cover all clips plus a few bars of headroom, min 16s.
  const totalSec = useMemo(() => {
    let end = 16;
    for (const t of tracks) for (const c of t.clips) end = Math.max(end, c.start + c.length);
    return end + 4;
  }, [tracks]);

  const width = Math.ceil(totalSec * pxPerSec);
  const grid = useMemo(() => gridLines(map, 0, totalSec), [map, totalSec]);
  const secToPx = (s: number) => s * pxPerSec;
  const pxToSec = (px: number) => px / pxPerSec;

  // Sync header column's vertical scroll with the lane scroll surface.
  const onScroll = () => {
    if (headersRef.current && scrollRef.current)
      headersRef.current.scrollTop = scrollRef.current.scrollTop;
  };

  const transport = snapshot.transport;
  const playheadPx = secToPx(transport.position);

  const seekFromEvent = (e: React.MouseEvent) => {
    const inner = e.currentTarget as HTMLElement;
    const rect = inner.getBoundingClientRect();
    const sec = Math.max(0, pxToSec(e.clientX - rect.left + (scrollRef.current?.scrollLeft ?? 0)));
    void exec("set_transport", { position: snapTime(sec) });
  };

  return (
    <div className="timeline" data-testid="arrangement" data-grid="single" data-px-per-sec={pxPerSec}>
      {/* left: track headers (vertical-scroll synced with lanes) */}
      <div className="headers" ref={headersRef}>
        <div className="ruler-corner"><span className="display">TRACKS</span></div>
        {tracks.map((t) => (
          <TrackHeader key={t.id} track={t} />
        ))}
      </div>

      {/* right: ruler + lanes on one shared horizontal scroll */}
      <div className="lanes-scroll" ref={scrollRef} onScroll={onScroll}>
        <div
          className="ruler"
          style={{ width }}
          data-testid="ruler"
          onMouseDown={seekFromEvent}
        >
          {grid.bars.map((b) => (
            <div key={`bn-${b.label}`} className="bar-num tc" style={{ left: secToPx(b.sec) }} data-bar={b.label}>
              {b.label}
            </div>
          ))}
          {grid.marks.map((m, i) => (
            <div key={`mk-${i}`} className="mark tc" style={{ left: secToPx(m.sec) }}>{m.label}</div>
          ))}
        </div>

        <div
          className="lanes-inner"
          style={{ width, height: tracks.length * LANE_H }}
          onMouseDown={(e) => { if (e.target === e.currentTarget) clearSelection(); }}
        >
          {/* THE single grid — bar + beat lines, nothing else paints a grid */}
          <div className="grid" data-testid="grid" data-bar-count={grid.bars.length}>
            {grid.beats.map((sec, i) => (
              <div key={`be-${i}`} className="line beat" style={{ left: secToPx(sec) }} />
            ))}
            {grid.bars.map((b) => (
              <div key={`ba-${b.label}`} className="line bar" style={{ left: secToPx(b.sec) }} data-bar={b.label} />
            ))}
          </div>

          {tracks.map((t, i) => (
            <div
              key={t.id}
              className="lane"
              data-testid="lane"
              data-track-id={t.id}
              style={{ position: "absolute", top: i * LANE_H, left: 0, right: 0, height: LANE_H }}
            >
              {t.clips.map((c) => (
                <ClipBlock
                  key={c.id}
                  clip={c}
                  selected={selection.has(c.id)}
                  left={secToPx(c.start)}
                  widthPx={Math.max(2, secToPx(c.length))}
                  onSelect={(additive) => select([c.id], additive)}
                  onSplit={(sec) => exec("split_clip", { clipId: c.id, time: snapTime(sec) })}
                  tool={tool}
                  pxToSec={pxToSec}
                />
              ))}
            </div>
          ))}

          <div className="playhead" data-testid="playhead" data-pos={transport.position.toFixed(3)} style={{ left: playheadPx }} />
        </div>
      </div>
    </div>
  );
}

function TrackHeader({ track }: { track: Track }) {
  const exec = useStore((s) => s.exec);
  const selectedTrackId = useStore((s) => s.selectedTrackId);
  const setSelectedTrack = useStore((s) => s.setSelectedTrack);
  const selected = selectedTrackId === track.id;
  return (
    <div
      className={`thead${selected ? " selected" : ""}`}
      data-testid="track-header"
      data-track-id={track.id}
      data-selected={selected}
      onMouseDown={() => setSelectedTrack(track.id)}
    >
      <div className="row1">
        <span className="tname" title={track.name}>{track.name}</span>
        <button className="msx x" title="Remove track" aria-label={`Remove ${track.name}`}
          onClick={(e) => { e.stopPropagation(); void exec("remove_track", { trackId: track.id }); }}>×</button>
      </div>
      <div className="mix">
        <button className={`msx m${track.mute ? " on" : ""}`} data-state={track.mute ? "on" : "off"}
          aria-pressed={!!track.mute} title="Mute"
          onClick={(e) => { e.stopPropagation(); void exec("set_track_mute", { trackId: track.id, mute: !track.mute }); }}>M</button>
        <button className={`msx s${track.solo ? " on" : ""}`} data-state={track.solo ? "on" : "off"}
          aria-pressed={!!track.solo} title="Solo"
          onClick={(e) => { e.stopPropagation(); void exec("set_track_solo", { trackId: track.id, solo: !track.solo }); }}>S</button>
        <input type="range" min={-60} max={6} step={0.5} value={track.volumeDb ?? 0}
          title={`Volume ${(track.volumeDb ?? 0).toFixed(1)} dB`}
          onChange={(e) => void exec("set_track_volume", { trackId: track.id, db: Number(e.target.value) })} />
      </div>
    </div>
  );
}

function ClipBlock({
  clip, selected, left, widthPx, onSelect, onSplit, tool, pxToSec,
}: {
  clip: Clip; selected: boolean; left: number; widthPx: number;
  onSelect: (additive: boolean) => void; onSplit: (sec: number) => void;
  tool: string; pxToSec: (px: number) => number;
}) {
  const ensurePeaks = useStore((s) => s.ensurePeaks);
  const peaks = useStore((s) => s.peaks[clip.id]);
  useEffect(() => { if (clip.type === "wave") ensurePeaks(clip.id); }, [clip.id, clip.type, ensurePeaks]);

  const onMouseDown = (e: React.MouseEvent) => {
    e.stopPropagation();
    if (tool === "split") {
      const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
      onSplit(clip.start + pxToSec(e.clientX - rect.left));
      return;
    }
    onSelect(e.shiftKey || e.metaKey);
  };

  return (
    <div
      className={`clip ${clip.type}${selected ? " selected" : ""}`}
      data-testid="clip"
      data-clip-id={clip.id}
      data-clip-start={clip.start}
      data-clip-length={clip.length}
      data-state={selected ? "selected" : "idle"}
      style={{ left, width: widthPx }}
      onMouseDown={onMouseDown}
    >
      <div className="label">{clip.name}</div>
      {clip.type === "wave" && <ClipWave peaks={peaks} width={widthPx} />}
      <div className="trim l" title="Trim start" />
      <div className="trim r" title="Trim end" />
    </div>
  );
}

function ClipWave({ peaks, width }: { peaks?: Peaks; width: number }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const cv = ref.current; if (!cv || !peaks) return;
    const dpr = window.devicePixelRatio || 1;
    const h = cv.clientHeight, w = cv.clientWidth;
    cv.width = Math.max(1, Math.floor(w * dpr)); cv.height = Math.max(1, Math.floor(h * dpr));
    const ctx = cv.getContext("2d"); if (!ctx) return;
    ctx.scale(dpr, dpr); ctx.clearRect(0, 0, w, h);
    ctx.fillStyle = "rgba(204,255,35,0.5)";
    const mid = h / 2, n = peaks.length;
    for (let x = 0; x < w; x++) {
      const p = peaks[Math.min(n - 1, Math.floor((x / w) * n))];
      if (!p) continue;
      const top = mid + p[0] * mid * 0.92, bot = mid + p[1] * mid * 0.92;
      ctx.fillRect(x, top, 1, Math.max(1, bot - top));
    }
  }, [peaks, width]);
  return <canvas ref={ref} />;
}
