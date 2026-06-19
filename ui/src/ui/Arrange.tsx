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
import { pickFiles, nativeMenuPresent } from "../bridge";
import { useStore, type Peaks } from "../store";
import { tempoMapFrom, gridLines, meterAt, beatSeconds, snapStep } from "../time";
import { DRUM_LANES, laneIndexForPitch } from "./drumGrid";
import { commitClipDrag } from "./clipDrag";
import { useDrumWindow } from "./dock/useFloatingWindow";
import { deriveTakeLanes } from "./takeLanes";
import { SAMPLE_DND_MIME, addRecentSample } from "./sampleBrowserUtil";
import { Meter } from "./Meter";
import type { Snapshot, Track, Clip, MidiNote } from "../types";
// Configurable interaction: gestures/keymap resolve through DAW-preset tables instead
// of hardcoded branches; feel values (drag-threshold, edge-grab, snap, etc.) are read
// live. All UI-local — nothing here crosses the bridge.
import { EditorAction as EA, type Mods } from "../interaction/actions";
import { resolveGesture } from "../interaction/gestures";
import { classifyClipRegion } from "../interaction/region";
import { resolveKey, isEditableTarget } from "../interaction/keymap";
import { passedDragThreshold, isDoubleClick, magneticSnap } from "../interaction/feel";
import { liveFeel, liveKeymap, liveGestureTable } from "../interaction/config";

// Modifier state from a pointer/keyboard event, in the resolver's shape.
const modsOf = (e: { shiftKey?: boolean; altKey?: boolean; metaKey?: boolean; ctrlKey?: boolean }): Mods =>
  ({ shift: !!e.shiftKey, alt: !!e.altKey, meta: !!e.metaKey, ctrl: !!e.ctrlKey });

// Actions the native macOS menu owns (File + Edit accelerators). In the packaged app
// these fire via the NSMenu (forwarded back through the mosh_menu bridge → runAction),
// so the in-app keymap handler yields them to avoid a double-fire. Dev has no menu.
const NATIVE_MENU_ACTIONS = new Set<string>([EA.UNDO, EA.REDO, EA.CUT, EA.COPY, EA.PASTE, EA.DELETE, EA.SAVE]);

// Height of a clip's header strip (the label bar) — the y-band that classifies as
// clip.header. Only matters where a preset distinguishes header vs body (Ableton).
const CLIP_HEADER_PX = 18;

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

  // Feel-aware snap: honors the grid toggle + the Snap-strength feel slider. 1 →
  // always snap to the nearest grid line; 0 → free; in between → magnetic within a
  // fraction of the grid cell. Read live so a slider change applies to the next gesture.
  const snapWithFeel = useCallback((raw: number) => {
    const st = useStore.getState();
    const f = liveFeel();
    if (!st.snap || f.snapStrength <= 0) return raw;
    const snapped = snapTime(raw);
    const cell = snapStep(meterAt(map, raw), st.snapDivision);
    return magneticSnap(raw, snapped, cell, f.snapStrength);
  }, [snapTime, map]);

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
    const table = liveGestureTable();
    const mods = modsOf(e);
    const drag = resolveGesture(table, { region: "ruler", gesture: "drag", mods });
    const click = resolveGesture(table, { region: "ruler", gesture: "click", mods });
    if (drag === EA.LOOP_REGION) {
      loopAnchor.current = sec;
      capturePointer(e.currentTarget, e.pointerId);
    } else if (click === EA.SEEK) {
      void exec("set_transport", { position: snapWithFeel(sec) });
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
    const drag = resolveGesture(liveGestureTable(), { region: "empty", gesture: "drag", mods: modsOf(e), tool });
    if (drag === EA.TIME_SELECT) {
      const sec = snapWithFeel(Math.max(0, pxToSec(x)));
      rangeAnchor.current = sec;
      setTimeRange({ start: sec, end: sec });
    } else {
      // MARQUEE (and the click→DESELECT that precedes it on empty space)
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
      const sec = snapWithFeel(Math.max(0, pxToSec(x)));
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

  // ── keyboard: the SINGLE global key handler, keymap-driven. resolveKey looks up an
  // action from the active keymap (preset + rebinds, read live); each action maps to
  // its effect. Replaces the old inline branches + the once-separate useKeyboardShortcuts
  // (now only the native-menu bridge).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (isEditableTarget(e.target)) return; // never hijack typing
      const action = resolveKey(liveKeymap(), e);
      if (!action) return;
      // In the packaged app the native NSMenu owns the File/Edit accelerators and
      // fires each once (forwarded back via the mosh_menu bridge → runAction). Yield
      // those chords here so they don't ALSO fire in-app (double undo/delete). In
      // Vite dev (no native menu) we own everything.
      if (nativeMenuPresent() && NATIVE_MENU_ACTIONS.has(action)) return;
      const s = useStore.getState();
      const prevent = () => e.preventDefault();
      const eachSelected = (fn: (id: string) => void) => { for (const id of s.selection) fn(id); };
      switch (action) {
        case EA.UNDO: prevent(); void s.exec("undo"); break;
        case EA.REDO: prevent(); void s.exec("redo"); break;
        case EA.PLAY_PAUSE: prevent(); void s.exec("set_transport", { action: "toggle" }); break;
        case EA.RECORD: prevent(); void s.exec("set_transport", { action: "record" }); break;
        case EA.SAVE: prevent(); void s.exec("save"); break;
        case EA.DELETE:
          // While a clip-editor modal is open (piano roll / automation), Delete belongs
          // to that editor (delete selected notes/points), not the arrangement — bail
          // so we never silently remove the clip being edited (Phase 1 fix).
          if (s.editingClipId || s.automationTrackId) break;
          if (s.selection.size === 0) break;
          prevent();
          eachSelected((id) => void s.exec("remove_clip", { clipId: id }));
          s.clearSelection();
          break;
        // only swallow copy/cut/paste when there's something to act on, so an empty
        // selection lets the browser copy/paste normal page text
        case EA.COPY: if (s.selection.size) { prevent(); s.copySelection(); } break;
        case EA.CUT: if (s.selection.size) { prevent(); void s.cutSelection(); } break;
        case EA.PASTE: if (s.clipboard) { prevent(); void s.pasteClipboard(); } break;
        case EA.DUPLICATE: prevent(); eachSelected((id) => void s.exec("duplicate_clip", { clipId: id })); break;
        case EA.GROUP: {
          prevent();
          const sel = new Set(s.selection);
          const trackIds = s.snapshot?.tracks.filter((t) => !t.isGroup && t.clips.some((c) => sel.has(c.id))).map((t) => t.id) ?? [];
          if (trackIds.length) void s.exec("create_group_track", { trackIds });
          break;
        }
        case EA.TO_START: prevent(); void s.exec("set_transport", { action: "to_start" }); break;
        case EA.TO_END: prevent(); void s.exec("set_transport", { action: "to_end" }); break;
        case EA.TOOL_MOVE: s.setTool("move"); break;
        case EA.TOOL_SPLIT: s.setTool("split"); break;
        case EA.TOOL_RANGE: s.setTool("range"); break;
        case EA.SPLIT: {
          // split-at-playhead (Ableton/FL keymaps): split each selected clip the
          // playhead currently passes through.
          prevent();
          const pos = s.transport.position;
          for (const t of s.snapshot?.tracks ?? [])
            for (const c of t.clips)
              if (s.selection.has(c.id) && c.start < pos && pos < c.start + c.length)
                void s.exec("split_clip", { clipId: c.id, time: pos });
          break;
        }
        default: break;
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // ── wheel: Mod+wheel zooms (zoomSensitivity), Shift+wheel scrolls horizontally
  // (scrollSensitivity). Attached natively (non-passive) so preventDefault works; reads
  // feel live. Plain wheel stays native vertical scroll.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      const f = liveFeel();
      if (e.ctrlKey || e.metaKey) {
        e.preventDefault();
        const st = useStore.getState();
        st.setPxPerSec(st.pxPerSec * Math.exp(-e.deltaY * 0.0015 * f.zoomSensitivity));
      } else if (e.shiftKey) {
        e.preventDefault();
        el.scrollLeft += e.deltaY * f.scrollSensitivity;
      }
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, []);

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
                  tool={tool} snapTime={snapWithFeel} secToPx={secToPx} pxToSec={pxToSec}
                  bs={beatSeconds(meterAt(map, c.start))}
                  onSelect={(additive) => select([c.id], additive)}
                  setTimeRange={setTimeRange} exec={exec} />
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
  // A drum track's badge opens the FL-style step sequencer in its floating window,
  // bound to the track's MIDI clip (creating an empty one if the track has none).
  const openSeq = async (e: React.MouseEvent) => {
    e.stopPropagation();
    let clipId = track.clips.find((c) => c.type === "midi")?.id;
    if (!clipId) {
      const r = (await exec("add_midi_clip", { trackId: track.id })) as { data?: { clipId?: string } };
      clipId = r?.data?.clipId;
    }
    if (clipId) useDrumWindow.getState().open(String(clipId));
  };
  return (
    <div className={`thead${selected ? " selected" : ""}`} data-testid="track-header" data-track-id={track.id}
      data-track-type={track.type} data-selected={selected} onPointerDown={() => setSelectedTrack(track.id)}>
      <div className="row1">
        {showBadge && (
          isDrum ? (
            <button className="tbadge drum" data-testid="open-drum-seq" title="Open the drum sequencer"
              onPointerDown={(e) => e.stopPropagation()} onClick={openSeq}>🥁</button>
          ) : (
            <span className="tbadge" data-testid="track-type-badge" title={`Instrument · ${instrument!.name}`}>♪</span>
          )
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
type DragKind = "move" | "trim-l" | "trim-r" | "time";

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
  clip, selected, tool, snapTime, secToPx, pxToSec, bs, onSelect, setTimeRange, exec,
}: {
  clip: Clip; selected: boolean; tool: "move" | "split" | "range";
  snapTime: (t: number) => number; secToPx: (s: number) => number; pxToSec: (px: number) => number;
  bs: number; // seconds per beat at this clip's start (for inline MIDI/drum previews)
  onSelect: (additive: boolean) => void;
  setTimeRange: (r: { start: number; end: number } | null) => void;
  exec: ExecFn;
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
  const drag = useRef<
    { kind: DragKind; startX: number; startY: number; engaged: boolean; orig: Pos; anchorSec: number } | null
  >(null);
  const lastUp = useRef<number | null>(null); // for manual (feel-driven) double-click
  useEffect(() => { setPreview(null); }, [clip.start, clip.length, clip.offset]);

  const pos: Pos = preview ?? { start: clip.start, length: clip.length, offset: clip.offset };
  const left = secToPx(pos.start);
  const widthPx = Math.max(2, secToPx(pos.length));

  // Native take tree → stacked lanes within this clip's footprint. Clicking a lane
  // selects it (set_current_take); the current lane owns a keep-take affordance
  // (flatten to it). Empty unless the clip actually has ≥2 takes.
  const takeLanes = deriveTakeLanes(clip);

  // Whether the active table trims on this clip's edge (drives the resize-cursor
  // affordance). Mosh: only the move tool; Ableton/FL: always.
  const edgeTrims = resolveGesture(liveGestureTable(), { region: "clip.edge", gesture: "drag", mods: {}, tool }) === EA.TRIM;
  const edgeGrabWidth = liveFeel().edgeGrabPx;

  // Classify which sub-region the pointer hit, then resolve the action from the
  // active table — no hardcoded tool branches.
  const regionAt = (e: React.MouseEvent): { region: string; localX: number; edgePx: number } => {
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const localX = e.clientX - rect.left, localY = e.clientY - rect.top;
    const edgePx = liveFeel().edgeGrabPx;
    const region = classifyClipRegion({ x: localX, y: localY, width: rect.width, height: rect.height, edgeGrabPx: edgePx, headerPx: CLIP_HEADER_PX });
    return { region, localX, edgePx };
  };

  const onClipDown = (e: React.PointerEvent) => {
    e.stopPropagation();
    const { region, localX, edgePx } = regionAt(e);
    const table = liveGestureTable();
    const mods = modsOf(e);
    const clickAction = resolveGesture(table, { region, gesture: "click", mods, tool });
    const dragAction = resolveGesture(table, { region, gesture: "drag", mods, tool });

    // split-at-click (Mosh split tool) is terminal — fire and bail.
    if (clickAction === EA.SPLIT) {
      void exec("split_clip", { clipId: clip.id, time: snapTime(clip.start + pxToSec(localX)) });
      return;
    }
    // selection fires on press (click selects, a subsequent drag moves/trims/selects time)
    if (clickAction === EA.SELECT) onSelect(false);
    else if (clickAction === EA.ADDITIVE_SELECT) onSelect(true);

    let kind: DragKind | null = null;
    if (dragAction === EA.MOVE) kind = "move";
    else if (dragAction === EA.TRIM) kind = localX <= edgePx ? "trim-l" : "trim-r";
    else if (dragAction === EA.TIME_SELECT) kind = "time";
    if (!kind) return;

    capturePointer(e.target as HTMLElement, e.pointerId);
    drag.current = {
      kind, startX: e.clientX, startY: e.clientY, engaged: false,
      orig: { start: clip.start, length: clip.length, offset: clip.offset },
      anchorSec: clip.start + pxToSec(localX),
    };
  };

  const onClipMove = (e: React.PointerEvent) => {
    const d = drag.current; if (!d) return;
    const dx = e.clientX - d.startX, dy = e.clientY - d.startY;
    if (!d.engaged) {
      if (!passedDragThreshold(dx, dy, liveFeel().dragThreshold)) return; // still a click
      d.engaged = true;
    }
    const delta = pxToSec(dx), o = d.orig;
    if (d.kind === "move") {
      setPreview({ ...o, start: Math.max(0, snapTime(o.start + delta)) });
    } else if (d.kind === "trim-r") {
      const end = snapTime(o.start + o.length + delta);
      setPreview({ ...o, length: Math.max(MIN_LEN, end - o.start) });
    } else if (d.kind === "trim-l") {
      const start = Math.max(0, Math.min(o.start + o.length - MIN_LEN, snapTime(o.start + delta)));
      const used = start - o.start;
      setPreview({ start, length: o.length - used, offset: Math.max(0, o.offset + used) });
    } else { // time selection across the clip body (Ableton)
      const cur = snapTime(Math.max(0, d.anchorSec + delta));
      setTimeRange({ start: Math.min(d.anchorSec, cur), end: Math.max(d.anchorSec, cur) });
    }
  };

  const onClipUp = (e: React.PointerEvent) => {
    const d = drag.current; drag.current = null;
    releasePointer(e.target as HTMLElement, e.pointerId);
    if (d && d.engaged) {
      lastUp.current = null; // a drag breaks any pending double-click sequence
      if (d.kind === "move" || d.kind === "trim-l" || d.kind === "trim-r") {
        // Commit move/trim, reverting the optimistic preview if the command is
        // rejected (else it stays stuck — there is no snapshot change to clear it).
        commitClipDrag(d.kind, preview, d.orig.start, clip.id, exec, setPreview);
      } else { // time
        const r = useStore.getState().timeRange;
        if (r && r.end - r.start < 1e-6) setTimeRange(null);
      }
      return;
    }
    // pure click (no drag engaged) → manual double-click detection (feel.doubleClickMs)
    const now = performance.now();
    if (isDoubleClick(lastUp.current, now, liveFeel().doubleClickMs)) {
      lastUp.current = null;
      const { region } = regionAt(e);
      const action = resolveGesture(liveGestureTable(), { region, gesture: "dblclick", mods: modsOf(e), tool });
      if (action === EA.OPEN && clip.type === "midi") openPianoRoll(clip.id);
    } else {
      lastUp.current = now;
    }
  };

  const onClipContext = (e: React.MouseEvent) => {
    const { region } = regionAt(e);
    const action = resolveGesture(liveGestureTable(), { region, gesture: "contextmenu", mods: modsOf(e), tool });
    if (action !== EA.CONTEXT_MENU) return;
    e.preventDefault(); // suppress the native browser menu on ANY clip (not just wave)
    if (clip.type === "wave") setMenuPos({ x: e.clientX, y: e.clientY });
  };

  return (
    <div
      className={`clip ${clip.type}${selected ? " selected" : ""}${tool === "split" ? " splitcur" : ""}`}
      data-testid="clip" data-clip-id={clip.id} data-clip-start={pos.start} data-clip-length={pos.length}
      data-state={selected ? "selected" : "idle"} data-dragging={drag.current ? "true" : "false"}
      data-source-missing={clip.sourceMissing ? "true" : "false"}
      data-transcribing={transcribing ? "true" : "false"}
      style={{ left, width: widthPx }}
      onPointerDown={onClipDown} onPointerMove={onClipMove} onPointerUp={onClipUp}
      onContextMenu={onClipContext}
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
      {edgeTrims && (
        <>
          {/* visual resize-cursor zones only — the clip's single handler classifies the
              edge by position (width tracks the feel edge-grab) and pointerdown bubbles up */}
          <div className="trim l" title="Trim start" style={{ width: edgeGrabWidth }} />
          <div className="trim r" title="Trim end" style={{ width: edgeGrabWidth }} />
        </>
      )}
    </div>
  );
}

// Shared canvas setup: size the backing store to devicePixelRatio, scale the context,
// and clear. Returns null until the canvas + 2D context are ready.
function prepCanvas(cv: HTMLCanvasElement | null): { ctx: CanvasRenderingContext2D; w: number; h: number } | null {
  if (!cv) return null;
  const dpr = window.devicePixelRatio || 1;
  const h = cv.clientHeight, w = cv.clientWidth;
  cv.width = Math.max(1, Math.floor(w * dpr)); cv.height = Math.max(1, Math.floor(h * dpr));
  const ctx = cv.getContext("2d"); if (!ctx) return null;
  ctx.scale(dpr, dpr); ctx.clearRect(0, 0, w, h);
  return { ctx, w, h };
}

const ClipWave = memo(function ClipWave({ peaks, width }: { peaks?: Peaks; width: number }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    if (!peaks) return;
    const prep = prepCanvas(ref.current); if (!prep) return;
    const { ctx, w, h } = prep;
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
    const prep = prepCanvas(ref.current); if (!prep) return;
    const { ctx, h } = prep;
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
    const prep = prepCanvas(ref.current); if (!prep) return;
    const { ctx, w, h } = prep;
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
