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

import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { pickFiles } from "../bridge";
import { useStore, type Peaks } from "../store";
import { tempoMapFrom, gridLines, meterAt, beatSeconds } from "../time";
import { DRUM_LANES, laneIndexForPitch } from "./drumGrid";
import { deriveTakeLanes } from "./takeLanes";
import { SAMPLE_DND_MIME, addRecentSample } from "./sampleBrowserUtil";
import { Meter } from "./Meter";
import type { Snapshot, Track, Clip, MidiNote } from "../types";

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
  const refresh = useStore((s) => s.refresh);
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

  // Timeline extent depends only on the snapshot's clips, not the per-render
  // filtered `tracks` array (which is a fresh reference every render).
  const totalSec = useMemo(() => {
    let end = 16;
    for (const t of snapshot.tracks) for (const c of t.clips) end = Math.max(end, c.start + c.length);
    return end + 4;
  }, [snapshot.tracks]);

  const width = Math.ceil(totalSec * pxPerSec);
  const grid = useMemo(() => gridLines(map, 0, totalSec), [map, totalSec]);
  // Stable across renders (until the zoom changes) so memoized clip canvases can
  // skip redraws when only an unrelated sibling re-renders.
  const secToPx = useCallback((s: number) => s * pxPerSec, [pxPerSec]);
  const pxToSec = useCallback((px: number) => px / pxPerSec, [pxPerSec]);
  const lanesHeight = Math.max(LANE_H, tracks.length * LANE_H);

  // Drag-to-arrange: a sample dragged from the browser lands as a clip on the
  // dropped track at the dropped position (snapped). import_clip already takes
  // trackId + startSeconds, so this is pure frontend.
  const allowSampleDrop = (e: React.DragEvent) => {
    if (!e.dataTransfer.types.includes(SAMPLE_DND_MIME)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = "copy";
  };
  const onSampleDrop = (trackId: string) => async (e: React.DragEvent<HTMLDivElement>) => {
    const file = e.dataTransfer.getData(SAMPLE_DND_MIME) || e.dataTransfer.getData("text/plain");
    if (!file) return;
    e.preventDefault();
    const x = e.clientX - e.currentTarget.getBoundingClientRect().left;
    const startSeconds = snapTime(Math.max(0, pxToSec(x)));
    await exec("import_clip", { file, trackId, startSeconds });
    addRecentSample(file);
    await refresh();
  };

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
          <LoopTab secToPx={secToPx} />
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
              onDragOver={allowSampleDrop} onDrop={onSampleDrop(t.id)}
              style={{ position: "absolute", top: i * LANE_H, left: 0, right: 0, height: LANE_H }}>
              {t.clips.map((c) => (
                <ClipBlock key={c.id} clip={c} selected={selection.has(c.id)}
                  tool={tool} snapTime={snapTime} secToPx={secToPx} pxToSec={pxToSec}
                  bs={beatSeconds(meterAt(map, c.start))}
                  onSelect={(additive) => select([c.id], additive)} exec={exec} />
              ))}
            </div>
          ))}

          {/* loop region + range band over the lanes (UI-local band reuses styling) */}
          <LoopBand secToPx={secToPx} lanesHeight={lanesHeight} />
          {timeRange && timeRange.end > timeRange.start && (
            <div className="band range" data-testid="range-band"
              style={{ left: secToPx(timeRange.start), width: secToPx(timeRange.end - timeRange.start), height: lanesHeight }} />
          )}

          <Playhead secToPx={secToPx} />

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

const TrackHeader = memo(function TrackHeader({ track }: { track: Track }) {
  const exec = useStore((s) => s.exec);
  // Subscribe to the DERIVED boolean, not the raw selectedTrackId — a header whose
  // selected-state is unchanged won't re-render when selection moves elsewhere.
  const selected = useStore((s) => s.selectedTrackId === track.id);
  const setSelectedTrack = useStore((s) => s.setSelectedTrack);
  // DRM-001 — surface the track type + auto-loaded instrument so the default-instrument
  // policy is discoverable, not magic. A drum track shows 🥁; a melodic instrument
  // track shows ♪ (with the instrument's name on hover).
  const instrument = track.plugins?.find((p) => p.isInstrument);
  const isDrum = track.type === "drum";
  const showBadge = isDrum || !!instrument;
  return (
    <div className={`thead${selected ? " selected" : ""}`} data-testid="track-header" data-track-id={track.id}
      data-track-type={track.type} data-selected={selected} onPointerDown={() => setSelectedTrack(track.id)}>
      <div className="row1">
        {showBadge && (
          <span className={`tbadge${isDrum ? " drum" : ""}`} data-testid="track-type-badge"
            title={isDrum ? `Drum track${instrument ? ` · ${instrument.name}` : ""}` : `Instrument · ${instrument!.name}`}>
            {isDrum ? "🥁" : "♪"}
          </span>
        )}
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
      <Meter trackId={track.id} />
    </div>
  );
});

type ExecFn = (command: string, args?: Record<string, unknown>) => Promise<unknown>;
type DragKind = "move" | "trim-l" | "trim-r";

// Right-click clip menu — currently just audio→MIDI (Basic Pitch). Cursor-positioned
// via a portal (so it isn't clipped by the lane's overflow), dismissed on outside
// pointerdown or Escape. Stops propagation so a click inside doesn't also close it.
function ClipMenu({ clipId, x, y, exec, onClose }:
  { clipId: string; x: number; y: number; exec: ExecFn; onClose: () => void }) {
  useEffect(() => {
    const onDoc = () => onClose();
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    // Defer registration so the opening contextmenu gesture doesn't immediately close it.
    const t = window.setTimeout(() => {
      window.addEventListener("pointerdown", onDoc);
      window.addEventListener("keydown", onKey);
    }, 0);
    return () => {
      window.clearTimeout(t);
      window.removeEventListener("pointerdown", onDoc);
      window.removeEventListener("keydown", onKey);
    };
  }, [onClose]);
  const run = (mode: "mono" | "poly") => { void exec("transcribe_clip", { clipId, mode }); onClose(); };
  return createPortal(
    <div className="clip-menu" role="menu" data-testid="clip-menu"
      style={{ left: x, top: y }} onPointerDown={(e) => e.stopPropagation()}>
      <div className="cm-head">Convert to MIDI</div>
      <button className="cm-item" role="menuitem" data-testid="cm-mono" onClick={() => run("mono")}>
        Melody <span className="cm-sub">mono</span>
      </button>
      <button className="cm-item" role="menuitem" data-testid="cm-poly" onClick={() => run("poly")}>
        Polyphonic <span className="cm-sub">chords</span>
      </button>
    </div>,
    document.body,
  );
}

function ClipBlock({
  clip, selected, tool, snapTime, secToPx, pxToSec, bs, onSelect, exec,
}: {
  clip: Clip; selected: boolean; tool: string;
  snapTime: (t: number) => number; secToPx: (s: number) => number; pxToSec: (px: number) => number;
  bs: number; // seconds per beat at this clip's start (for inline MIDI/drum previews)
  onSelect: (additive: boolean) => void; exec: ExecFn;
}) {
  const ensurePeaks = useStore((s) => s.ensurePeaks);
  const peaks = useStore((s) => s.peaks[clip.id]);
  const openPianoRoll = useStore((s) => s.openPianoRoll);
  const transcribing = useStore((s) => !!s.transcribing[clip.id]);
  // Right-click → Convert to MIDI menu (wave clips only). Cursor-positioned.
  const [menuPos, setMenuPos] = useState<{ x: number; y: number } | null>(null);
  useEffect(() => { if (clip.type === "wave") ensurePeaks(clip.id); }, [clip.id, clip.type, ensurePeaks]);

  // Optimistic preview during a drag; cleared when committed props arrive.
  const [preview, setPreview] = useState<Pos | null>(null);
  const drag = useRef<{ kind: DragKind; startX: number; orig: Pos } | null>(null);
  useEffect(() => { setPreview(null); }, [clip.start, clip.length, clip.offset]);

  const pos: Pos = preview ?? { start: clip.start, length: clip.length, offset: clip.offset };
  const left = secToPx(pos.start);
  const widthPx = Math.max(2, secToPx(pos.length));

  // Native take tree → stacked lanes within this clip's footprint. Clicking a lane
  // selects it (set_current_take); the current lane owns a keep-take affordance
  // (flatten to it). Empty unless the clip actually has ≥2 takes.
  const takeLanes = deriveTakeLanes(clip);

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
      data-source-missing={clip.sourceMissing ? "true" : "false"}
      data-transcribing={transcribing ? "true" : "false"}
      style={{ left, width: widthPx }}
      onPointerDown={beginDrag("move")} onPointerMove={onMove} onPointerUp={onUp}
      onDoubleClick={() => { if (clip.type === "midi") openPianoRoll(clip.id); }}
      onContextMenu={(e) => { if (clip.type === "wave") { e.preventDefault(); setMenuPos({ x: e.clientX, y: e.clientY }); } }}
    >
      {menuPos && (
        <ClipMenu clipId={clip.id} x={menuPos.x} y={menuPos.y} exec={exec} onClose={() => setMenuPos(null)} />
      )}
      {transcribing && <div className="clip-badge" data-testid="clip-transcribing">transcribing…</div>}
      <div className="label">
        {clip.name}
        {clip.sourceMissing && (
          <button className="clip-relink" data-testid="clip-relink" title="Source audio missing — click to relink" aria-label="Relink missing audio"
            onPointerDown={(e) => e.stopPropagation()}
            onClick={async (e) => {
              e.stopPropagation();
              const r = await pickFiles({ title: `Relink audio for ${clip.name}` });
              if (r.ok && r.files[0]) void exec("relink_clip", { clipId: clip.id, file: r.files[0] });
            }}>⚠ relink</button>
        )}
        {takeLanes.length > 0 && <span className="take-count"> · {takeLanes.length} takes</span>}
      </div>
      {takeLanes.length > 0 ? (
        <div className="take-lanes" data-testid="take-lanes" data-num-takes={takeLanes.length}>
          {takeLanes.map((ln) => (
            <div key={ln.index}
              className={`take-lane${ln.isCurrent ? " current" : ""}`}
              data-testid="take-lane" data-take-index={ln.index} data-current={ln.isCurrent ? "true" : "false"}
              title={ln.title ?? ln.label}
              onPointerDown={(e) => {
                e.stopPropagation(); // a lane click selects a take, never starts a clip drag
                if (!ln.isCurrent) void exec("set_current_take", { clipId: clip.id, takeIndex: ln.index });
              }}
            >
              <span className="take-label">{ln.label}</span>
              {ln.isCurrent && (
                <button className="take-keep" title="Keep this take (flatten the rest)" aria-label="Keep this take"
                  onPointerDown={(e) => e.stopPropagation()}
                  onClick={(e) => { e.stopPropagation(); void exec("keep_take", { clipId: clip.id }); }}>✓</button>
              )}
            </div>
          ))}
        </div>
      ) : clip.type === "wave" ? (
        <ClipWave peaks={peaks} width={widthPx} />
      ) : clip.type === "midi" ? (
        isDrumClip(clip.notes)
          ? <ClipDrumGrid notes={clip.notes} width={widthPx} bs={bs} secToPx={secToPx} />
          : <ClipMidi notes={clip.notes} width={widthPx} bs={bs} secToPx={secToPx} />
      ) : null}
      {tool === "move" && (
        <>
          <div className="trim l" title="Trim start" onPointerDown={beginDrag("trim-l")} onPointerMove={onMove} onPointerUp={onUp} />
          <div className="trim r" title="Trim end" onPointerDown={beginDrag("trim-r")} onPointerMove={onMove} onPointerUp={onUp} />
        </>
      )}
    </div>
  );
}

const ClipWave = memo(function ClipWave({ peaks, width }: { peaks?: Peaks; width: number }) {
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
});

// A MIDI clip reads as "drums" when most of its notes land on GM percussion keys
// (the same lanes the drum sequencer uses); melodic clips get the piano preview.
function isDrumClip(notes?: MidiNote[]): boolean {
  const ns = notes ?? [];
  if (ns.length === 0) return false;
  const onLane = ns.filter((n) => laneIndexForPitch(n.pitch) >= 0).length;
  return onLane >= ns.length * 0.7;
}

// Inline MIDI preview — pitch-mapped note blocks. Notes carry clip-local beats;
// beatSeconds(meter) → seconds, then the shared secToPx scale lands them on the
// same grid the ruler/playhead use. Double-click the clip still opens the PianoRoll.
const ClipMidi = memo(function ClipMidi({ notes, width, bs, secToPx }:
  { notes?: MidiNote[]; width: number; bs: number; secToPx: (s: number) => number }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const cv = ref.current; if (!cv) return;
    const dpr = window.devicePixelRatio || 1;
    const h = cv.clientHeight, w = cv.clientWidth;
    cv.width = Math.max(1, Math.floor(w * dpr)); cv.height = Math.max(1, Math.floor(h * dpr));
    const ctx = cv.getContext("2d"); if (!ctx) return;
    ctx.scale(dpr, dpr); ctx.clearRect(0, 0, w, h);
    const ns = notes ?? []; if (ns.length === 0) return;

    // Vertical range from the clip's own pitches (padded); fixed window if degenerate.
    let lo = Infinity, hi = -Infinity;
    for (const n of ns) { if (n.pitch < lo) lo = n.pitch; if (n.pitch > hi) hi = n.pitch; }
    if (hi - lo < 4) { const c = Math.round((lo + hi) / 2 || 60); lo = c - 6; hi = c + 6; }
    else { lo -= 1; hi += 1; }
    const span = Math.max(1, hi - lo);
    const rowH = Math.max(2, Math.min(7, (h - 2) / span));

    ctx.fillStyle = "rgba(180,108,255,1)";   // violet — matches the .clip.midi identity
    for (const n of ns) {
      const x = secToPx(n.start * bs);
      const wpx = Math.max(2, secToPx(n.length * bs) - 1);
      const y = (1 - (n.pitch - lo) / span) * (h - rowH);   // high pitch toward top
      ctx.globalAlpha = 0.45 + 0.55 * (Math.min(127, Math.max(1, n.velocity)) / 127);
      ctx.fillRect(x, y, wpx, rowH);
    }
    ctx.globalAlpha = 1;
  }, [notes, width, bs, secToPx]);
  return <canvas ref={ref} />;
});

// Inline drum preview — fixed GM lanes (kick/snare/hat/…), FL-style steps. x stays
// grid-aligned via secToPx(beats); y is the GM lane, not the pitch.
const ClipDrumGrid = memo(function ClipDrumGrid({ notes, width, bs, secToPx }:
  { notes?: MidiNote[]; width: number; bs: number; secToPx: (s: number) => number }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const cv = ref.current; if (!cv) return;
    const dpr = window.devicePixelRatio || 1;
    const h = cv.clientHeight, w = cv.clientWidth;
    cv.width = Math.max(1, Math.floor(w * dpr)); cv.height = Math.max(1, Math.floor(h * dpr));
    const ctx = cv.getContext("2d"); if (!ctx) return;
    ctx.scale(dpr, dpr); ctx.clearRect(0, 0, w, h);
    const ns = notes ?? []; if (ns.length === 0) return;

    const lanes = DRUM_LANES.length;
    const laneH = h / lanes;
    ctx.fillStyle = "rgba(180,108,255,0.14)";                // faint lane separators
    for (let l = 1; l < lanes; l++) ctx.fillRect(0, Math.round(l * laneH), w, 1);

    for (const n of ns) {
      const x = secToPx(n.start * bs);
      const cell = Math.max(3, Math.min(secToPx(n.length * bs), laneH - 2));
      const y = Math.max(0, laneIndexForPitch(n.pitch)) * laneH + 1;
      ctx.globalAlpha = 0.5 + 0.5 * (Math.min(127, Math.max(1, n.velocity)) / 127);
      ctx.fillStyle = "rgba(180,108,255,1)";
      ctx.fillRect(x, y, cell, Math.max(2, laneH - 3));
    }
    ctx.globalAlpha = 1;
  }, [notes, width, bs, secToPx]);
  return <canvas ref={ref} />;
});

// ── Live-transport leaves: each subscribes to the 30Hz `transport` field directly,
// so a moving playhead / loop edit re-renders only these tiny nodes, never the whole
// arrangement tree (clips, grid and headers stay put during playback). ───────────
function Playhead({ secToPx }: { secToPx: (s: number) => number }) {
  const position = useStore((s) => s.transport.position);
  return <div className="playhead" data-testid="playhead" data-pos={position.toFixed(3)} style={{ left: secToPx(position) }} />;
}

function LoopTab({ secToPx }: { secToPx: (s: number) => number }) {
  const looping = useStore((s) => s.transport.looping);
  const loopStart = useStore((s) => s.transport.loopStart);
  const loopEnd = useStore((s) => s.transport.loopEnd);
  if (!looping || loopEnd <= loopStart) return null;
  return <div className="loop-tab" data-testid="loop-region"
    style={{ left: secToPx(loopStart), width: secToPx(loopEnd - loopStart) }} />;
}

function LoopBand({ secToPx, lanesHeight }: { secToPx: (s: number) => number; lanesHeight: number }) {
  const looping = useStore((s) => s.transport.looping);
  const loopStart = useStore((s) => s.transport.loopStart);
  const loopEnd = useStore((s) => s.transport.loopEnd);
  if (!looping || loopEnd <= loopStart) return null;
  return <div className="band loop"
    style={{ left: secToPx(loopStart), width: secToPx(loopEnd - loopStart), height: lanesHeight }} />;
}
