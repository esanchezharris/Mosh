// The new arrangement view — rebuilt from scratch on the command/snapshot seam.
//
// ONE canonical musical grid: every horizontal position (ruler, grid lines,
// clips, playhead, loop region, marquee) is `sec * pxPerSec`, and the grid lines
// come solely from time.ts `gridLines()`. No CSS background-grid competes (the
// old double-grid bug). Every interactive element carries data-* state so an
// agent (or the macOS automation gate) reads the UI structurally, not by pixels.
//
// Interactions (all mutations via execute_command; view state stays UI-local):
//   • drag a clip body          -> optimistic preview -> move_clip {clipId,start}
//   • drag a trim handle (L/R)  -> optimistic preview -> trim_clip {clipId,start,length,offset}
//   • Split tool + click a clip -> split_clip {clipId,time}
//   • marquee on empty lanes    -> select overlapping clips (UI-local)
//   • Range tool drag on lanes  -> UI-local time-range band (delete_time_range on demand)
//   • ruler click / shift-drag  -> set_transport seek / loop region
//   • keyboard                  -> Delete (remove), Space (play/pause), Cmd/Ctrl+Z (undo/redo)
// Scroll-correctness: clip drag/trim use deltas (scroll-invariant); marquee/ruler
// use rect-relative coords (getBoundingClientRect already folds in scrollLeft).

import { useEffect, useMemo, useRef, useState } from "react";
import { useStore, type Peaks } from "../store";
import { tempoMapFrom, gridLines } from "../time";
import type { Snapshot, Track, Clip } from "../types";

const LANE_H = 76;
const MIN_LEN = 0.05; // shortest clip / trim, seconds

// Pointer capture keeps a drag tracking when the cursor leaves the element.
// Wrapped because some environments (and synthetic events) throw InvalidPointerId;
// a failed capture must not abort the gesture handler.
const capturePointer = (el: Element, id: number) => { try { (el as HTMLElement).setPointerCapture(id); } catch { /* no-op */ } };
const releasePointer = (el: Element, id: number) => { try { (el as HTMLElement).releasePointerCapture(id); } catch { /* no-op */ } };

type Pos = { start: number; length: number; offset: number };

export function Arrange({ snapshot }: { snapshot: Snapshot }) {
  const pxPerSec = useStore((s) => s.pxPerSec);
  const selection = useStore((s) => s.selection);
  const select = useStore((s) => s.select);
  const clearSelection = useStore((s) => s.clearSelection);
  const exec = useStore((s) => s.exec);
  const tool = useStore((s) => s.tool);
  const snapTime = useStore((s) => s.snapTime);
  const timeRange = useStore((s) => s.timeRange);
  const setTimeRange = useStore((s) => s.setTimeRange);

  const headersRef = useRef<HTMLDivElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const lanesRef = useRef<HTMLDivElement>(null);

  // UI-local marquee rectangle (content coords) + drag anchors for range/loop.
  const [marquee, setMarquee] = useState<{ x0: number; y0: number; x1: number; y1: number } | null>(null);
  const rangeAnchor = useRef<number | null>(null);
  const loopAnchor = useRef<number | null>(null);

  const tracks = snapshot.tracks.filter((t) => !t.isGroup);
  const map = useMemo(() => tempoMapFrom(snapshot.session), [snapshot.session]);

  const totalSec = useMemo(() => {
    let end = 16;
    for (const t of tracks) for (const c of t.clips) end = Math.max(end, c.start + c.length);
    return end + 4;
  }, [tracks]);

  const width = Math.ceil(totalSec * pxPerSec);
  const grid = useMemo(() => gridLines(map, 0, totalSec), [map, totalSec]);
  const secToPx = (s: number) => s * pxPerSec;
  const pxToSec = (px: number) => px / pxPerSec;
  const lanesHeight = Math.max(LANE_H, tracks.length * LANE_H);

  const transport = snapshot.transport;

  // px within a full-width child element (scroll-correct: the element's rect.left
  // already shifts by -scrollLeft, so clientX - rect.left is the content offset).
  const contentX = (clientX: number, el: HTMLElement) => clientX - el.getBoundingClientRect().left;

  const onScroll = () => {
    if (headersRef.current && scrollRef.current)
      headersRef.current.scrollTop = scrollRef.current.scrollTop;
  };

  // ── ruler: seek (plain) / loop region (shift-drag) ─────────────────────────
  const onRulerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    const sec = Math.max(0, pxToSec(contentX(e.clientX, e.currentTarget)));
    if (e.shiftKey) {
      loopAnchor.current = sec;
      capturePointer(e.currentTarget, e.pointerId);
    } else {
      void exec("set_transport", { position: snapTime(sec) });
    }
  };
  const onRulerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    if (loopAnchor.current == null || e.buttons === 0) return; // buttons===0 → stray hover after a lost/cancelled capture
    const sec = Math.max(0, pxToSec(contentX(e.clientX, e.currentTarget)));
    const a = Math.min(loopAnchor.current, sec), b = Math.max(loopAnchor.current, sec);
    void exec("set_transport", { loop: true, loopStart: a, loopEnd: b });
  };
  const onRulerUp = () => { loopAnchor.current = null; };

  // ── lanes background: marquee select / range band ──────────────────────────
  // Clip pointerdowns stopPropagation, so this only fires on empty lane space.
  const onLanesDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if ((e.target as HTMLElement).closest(".clip")) return;
    const el = lanesRef.current!;
    const x = contentX(e.clientX, el), y = e.clientY - el.getBoundingClientRect().top;
    if (tool === "range") {
      const sec = snapTime(Math.max(0, pxToSec(x)));
      rangeAnchor.current = sec;
      setTimeRange({ start: sec, end: sec });
    } else {
      clearSelection();
      setMarquee({ x0: x, y0: y, x1: x, y1: y });
    }
    capturePointer(el, e.pointerId);
  };
  const onLanesMove = (e: React.PointerEvent<HTMLDivElement>) => {
    if (e.buttons === 0) return; // ignore stray hover moves after a lost/cancelled capture
    const el = lanesRef.current!;
    const x = contentX(e.clientX, el), y = e.clientY - el.getBoundingClientRect().top;
    if (rangeAnchor.current != null) {
      const sec = snapTime(Math.max(0, pxToSec(x)));
      setTimeRange({ start: Math.min(rangeAnchor.current, sec), end: Math.max(rangeAnchor.current, sec) });
    } else if (marquee) {
      setMarquee({ ...marquee, x1: x, y1: y });
    }
  };
  const onLanesUp = () => {
    if (rangeAnchor.current != null) {
      rangeAnchor.current = null;
      const r = useStore.getState().timeRange;
      if (r && r.end - r.start < 1e-6) setTimeRange(null);
      return;
    }
    if (!marquee) return;
    const xMin = Math.min(marquee.x0, marquee.x1), xMax = Math.max(marquee.x0, marquee.x1);
    const yMin = Math.min(marquee.y0, marquee.y1), yMax = Math.max(marquee.y0, marquee.y1);
    const hit: string[] = [];
    tracks.forEach((tr, row) => {
      const top = row * LANE_H;
      if (top + LANE_H < yMin || top > yMax) return;
      for (const c of tr.clips) {
        const cl = secToPx(c.start), cr = secToPx(c.start + c.length);
        if (cr >= xMin && cl <= xMax) hit.push(c.id);
      }
    });
    select(hit, false);
    setMarquee(null);
  };
  // Abort (not commit) an in-flight lanes gesture on pointercancel/lost-capture,
  // so a cancelled marquee/range drag can't stick to the cursor.
  const onLanesCancel = () => {
    rangeAnchor.current = null;
    setMarquee(null);
    const r = useStore.getState().timeRange;
    if (r && r.end - r.start < 1e-6) setTimeRange(null);
  };

  // ── keyboard: Delete / Space / undo-redo (ignored while typing) ────────────
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement;
      if (el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.tagName === "SELECT" || el.isContentEditable)) return;
      const mod = e.metaKey || e.ctrlKey;
      if (mod && e.key.toLowerCase() === "z") {
        e.preventDefault();
        void exec(e.shiftKey ? "redo" : "undo");
      } else if (e.key === "Delete" || e.key === "Backspace") {
        const sel = useStore.getState().selection;
        if (sel.size === 0) return;
        e.preventDefault();
        for (const id of sel) void exec("remove_clip", { clipId: id });
        clearSelection();
      } else if (e.code === "Space") {
        e.preventDefault();
        void exec("set_transport", { action: "toggle" });
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [exec, clearSelection]);

  return (
    <div className="timeline" data-testid="arrangement" data-grid="single" data-tool={tool} data-px-per-sec={pxPerSec}>
      {/* left: track headers (vertical scroll synced with lanes) */}
      <div className="headers" ref={headersRef}>
        <div className="ruler-corner"><span className="display">TRACKS</span></div>
        {tracks.map((t) => <TrackHeader key={t.id} track={t} />)}
      </div>

      {/* right: ruler + lanes on one shared horizontal scroll */}
      <div className="lanes-scroll" ref={scrollRef} onScroll={onScroll}>
        <div
          className="ruler"
          style={{ width }}
          data-testid="ruler"
          onPointerDown={onRulerDown}
          onPointerMove={onRulerMove}
          onPointerUp={onRulerUp}
          onPointerCancel={onRulerUp}
          onLostPointerCapture={onRulerUp}
        >
          {grid.bars.map((b) => (
            <div key={`bn-${b.label}`} className="bar-num tc" style={{ left: secToPx(b.sec) }} data-bar={b.label}>{b.label}</div>
          ))}
          {grid.marks.map((m, i) => (
            <div key={`mk-${i}`} className="mark tc" style={{ left: secToPx(m.sec) }}>{m.label}</div>
          ))}
          {transport.looping && transport.loopEnd > transport.loopStart && (
            <div className="loop-tab" data-testid="loop-region"
              style={{ left: secToPx(transport.loopStart), width: secToPx(transport.loopEnd - transport.loopStart) }} />
          )}
        </div>

        <div
          className="lanes-inner"
          ref={lanesRef}
          style={{ width, height: lanesHeight }}
          onPointerDown={onLanesDown}
          onPointerMove={onLanesMove}
          onPointerUp={onLanesUp}
          onPointerCancel={onLanesCancel}
          onLostPointerCapture={onLanesCancel}
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

          {tracks.length === 0 && <div className="empty-hint">No tracks yet — add a track or a test tone.</div>}

          {tracks.map((t, i) => (
            <div key={t.id} className="lane" data-testid="lane" data-track-id={t.id}
              style={{ position: "absolute", top: i * LANE_H, left: 0, right: 0, height: LANE_H }}>
              {t.clips.map((c) => (
                <ClipBlock key={c.id} clip={c} selected={selection.has(c.id)}
                  tool={tool} snapTime={snapTime} secToPx={secToPx} pxToSec={pxToSec}
                  onSelect={(additive) => select([c.id], additive)} exec={exec} />
              ))}
            </div>
          ))}

          {/* loop region + range band over the lanes (UI-local band reuses styling) */}
          {transport.looping && transport.loopEnd > transport.loopStart && (
            <div className="band loop" style={{ left: secToPx(transport.loopStart), width: secToPx(transport.loopEnd - transport.loopStart), height: lanesHeight }} />
          )}
          {timeRange && timeRange.end > timeRange.start && (
            <div className="band range" data-testid="range-band"
              style={{ left: secToPx(timeRange.start), width: secToPx(timeRange.end - timeRange.start), height: lanesHeight }} />
          )}

          <div className="playhead" data-testid="playhead" data-pos={transport.position.toFixed(3)} style={{ left: secToPx(transport.position) }} />

          {marquee && (
            <div className="marquee" data-testid="marquee" style={{
              left: Math.min(marquee.x0, marquee.x1), top: Math.min(marquee.y0, marquee.y1),
              width: Math.abs(marquee.x1 - marquee.x0), height: Math.abs(marquee.y1 - marquee.y0),
            }} />
          )}
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
    <div className={`thead${selected ? " selected" : ""}`} data-testid="track-header" data-track-id={track.id}
      data-selected={selected} onPointerDown={() => setSelectedTrack(track.id)}>
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

type ExecFn = (command: string, args?: Record<string, unknown>) => Promise<unknown>;
type DragKind = "move" | "trim-l" | "trim-r";

function ClipBlock({
  clip, selected, tool, snapTime, secToPx, pxToSec, onSelect, exec,
}: {
  clip: Clip; selected: boolean; tool: string;
  snapTime: (t: number) => number; secToPx: (s: number) => number; pxToSec: (px: number) => number;
  onSelect: (additive: boolean) => void; exec: ExecFn;
}) {
  const ensurePeaks = useStore((s) => s.ensurePeaks);
  const peaks = useStore((s) => s.peaks[clip.id]);
  const openPianoRoll = useStore((s) => s.openPianoRoll);
  useEffect(() => { if (clip.type === "wave") ensurePeaks(clip.id); }, [clip.id, clip.type, ensurePeaks]);

  // Optimistic preview during a drag; cleared when committed props arrive.
  const [preview, setPreview] = useState<Pos | null>(null);
  const drag = useRef<{ kind: DragKind; startX: number; orig: Pos } | null>(null);
  useEffect(() => { setPreview(null); }, [clip.start, clip.length, clip.offset]);

  const pos: Pos = preview ?? { start: clip.start, length: clip.length, offset: clip.offset };
  const left = secToPx(pos.start);
  const widthPx = Math.max(2, secToPx(pos.length));

  const beginDrag = (kind: DragKind) => (e: React.PointerEvent) => {
    e.stopPropagation();
    if (tool === "split" && kind === "move") {
      const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
      void exec("split_clip", { clipId: clip.id, time: snapTime(clip.start + pxToSec(e.clientX - rect.left)) });
      return;
    }
    onSelect(e.shiftKey || e.metaKey);
    capturePointer(e.target as HTMLElement, e.pointerId);
    drag.current = { kind, startX: e.clientX, orig: { start: clip.start, length: clip.length, offset: clip.offset } };
  };
  const onMove = (e: React.PointerEvent) => {
    const d = drag.current; if (!d) return;
    const delta = pxToSec(e.clientX - d.startX), o = d.orig;
    if (d.kind === "move") {
      setPreview({ ...o, start: Math.max(0, snapTime(o.start + delta)) });
    } else if (d.kind === "trim-r") {
      const end = snapTime(o.start + o.length + delta);
      setPreview({ ...o, length: Math.max(MIN_LEN, end - o.start) });
    } else { // trim-l: move start, shrink length, push offset
      const start = Math.max(0, Math.min(o.start + o.length - MIN_LEN, snapTime(o.start + delta)));
      const used = start - o.start;
      setPreview({ start, length: o.length - used, offset: Math.max(0, o.offset + used) });
    }
  };
  const onUp = (e: React.PointerEvent) => {
    const d = drag.current; drag.current = null;
    if (!d || !preview) return; // pure click (no movement) → selection already applied
    releasePointer(e.target as HTMLElement, e.pointerId);
    if (d.kind === "move") {
      if (Math.abs(preview.start - d.orig.start) > 1e-4) void exec("move_clip", { clipId: clip.id, start: preview.start });
      else setPreview(null);
    } else {
      void exec("trim_clip", { clipId: clip.id, start: preview.start, length: preview.length, offset: preview.offset });
    }
  };

  return (
    <div
      className={`clip ${clip.type}${selected ? " selected" : ""}${tool === "split" ? " splitcur" : ""}`}
      data-testid="clip" data-clip-id={clip.id} data-clip-start={pos.start} data-clip-length={pos.length}
      data-state={selected ? "selected" : "idle"} data-dragging={drag.current ? "true" : "false"}
      style={{ left, width: widthPx }}
      onPointerDown={beginDrag("move")} onPointerMove={onMove} onPointerUp={onUp}
      onDoubleClick={() => { if (clip.type === "midi") openPianoRoll(clip.id); }}
    >
      <div className="label">{clip.name}</div>
      {clip.type === "wave" && <ClipWave peaks={peaks} width={widthPx} />}
      {tool === "move" && (
        <>
          <div className="trim l" title="Trim start" onPointerDown={beginDrag("trim-l")} onPointerMove={onMove} onPointerUp={onUp} />
          <div className="trim r" title="Trim end" onPointerDown={beginDrag("trim-r")} onPointerMove={onMove} onPointerUp={onUp} />
        </>
      )}
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
