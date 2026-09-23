import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { pickFiles, pickSaveFile } from "../bridge";
import { runAction } from "../menuActions";
import { useStore } from "../store";
import { isDrumClip } from "../ui/clipRenderers";
import { commitClipDrag, type DragPos } from "../ui/clipDrag";
import { classifyClipRegion } from "../interaction/region";
import { resolveGesture } from "../interaction/gestures";
import { liveFeel, liveGestureTable } from "../interaction/config";
import { passedDragThreshold } from "../interaction/feel";
import { EditorAction as EA, type Mods } from "../interaction/actions";
import { pushEscapeHandler } from "../hooks/escapeStack";
import { beatPx, clipBeats, clipBox, gridBeatCount, gridDensity, gridMarks, laneContentPx, secondsAtLaneX, type GridMark } from "./timeline";
import { Playhead, RulerMarker } from "./Playhead";
import { SectionStrip } from "./SectionStrip";
import { lockOwnerOfTrack } from "../multiplayer/sync";
import type { Clip, Snapshot, Track } from "../types";
import { useV3 } from "./shellState";
import { SilhouetteWave } from "./waves/SilhouetteWave";
import { DrumsClip, MelodyClip } from "./midi/MidiClips";
import { dropChords, dropDrumBeat } from "./beats";
import { useAgentTaskLive } from "./agentTask";
import { IconSnap, IconZoomIn, IconZoomOut } from "./icons";
import { SNAP_DIVISIONS, type SnapDiv } from "../time";

const modsOf = (e: { shiftKey?: boolean; altKey?: boolean; metaKey?: boolean; ctrlKey?: boolean }): Mods =>
  ({ shift: !!e.shiftKey, alt: !!e.altKey, meta: !!(e.metaKey || e.ctrlKey) });
const capturePointer = (el: Element, id: number) => { try { (el as HTMLElement).setPointerCapture(id); } catch { /* no-op */ } };
const releasePointer = (el: Element, id: number) => { try { (el as HTMLElement).releasePointerCapture(id); } catch { /* no-op */ } };
const MIN_LEN = 0.05;
type DragKind = "move" | "trim-l" | "trim-r";

function Ruler({ marks, widthPx, pxPerSec, beatLabels }: { marks: GridMark[]; widthPx: number; pxPerSec: number; beatLabels: boolean }) {
  const exec = useStore((s) => s.exec);
  const snapTime = useStore((s) => s.snapTime);
  // Click-to-seek, as v2's lane ruler: the pointer's x on the lane scale, snapped to the grid.
  const seek = (e: React.MouseEvent<HTMLDivElement>) => {
    const x = e.clientX - e.currentTarget.getBoundingClientRect().left;
    void exec("set_transport", { position: snapTime(secondsAtLaneX(x, pxPerSec)) });
  };
  // The ruler draws the SAME marks as the lanes (gridMarks): a tick at each one on the bottom
  // edge, the bar number / beat label just right of it. Zoomed out the marks thin themselves.
  return (
    <div className="ruler" style={{ width: widthPx }} data-testid="v3-ruler"
      data-beat-labels={beatLabels ? "1" : "0"} title="Click to move the playhead" onClick={seek}>
      {marks.map((m) => (
        <span key={m.beat} className="rmark" style={{ left: m.x }}>
          <i className={`tick${m.bar ? " bar" : ""}`} data-beat={m.beat} />
          <span className={`rn ${m.bar ? "bar" : "beat"}`}>{m.bar ? m.barNo : `.${(m.beat % 4) + 1}`}</span>
        </span>
      ))}
    </div>
  );
}

const DIV_LABEL: Record<SnapDiv, string> = { bar: "Bar", "1/4": "1/4", "1/8": "1/8", "1/16": "1/16", "1/32": "1/32" };

/** The corner over the track headers, left of the sections and ruler: the timeline's own view
 *  controls — snap on/off, the grid division clips snap to, and zoom — next to the thing they act on. */
function TimelineCorner() {
  const snap = useStore((s) => s.snap);
  const setSnap = useStore((s) => s.setSnap);
  const snapDivision = useStore((s) => s.snapDivision);
  const setSnapDivision = useStore((s) => s.setSnapDivision);
  const zoom = (action: "zoom_in" | "zoom_out") => void runAction(action, { store: useStore.getState(), pickFiles, pickSaveFile });
  return (
    <div className="tl-corner" data-testid="v3-timeline-corner" role="toolbar" aria-label="Timeline view">
      <button type="button" className="ibtn" title="Snap to grid" aria-label="Snap" aria-pressed={!!snap} onClick={() => setSnap(!snap)}>
        <IconSnap />
      </button>
      <select className="grid-div" aria-label="Grid" title="Grid: what clips and the playhead snap to" value={snapDivision}
        onChange={(e) => setSnapDivision(e.target.value as SnapDiv)}>
        {SNAP_DIVISIONS.map((d) => <option key={d} value={d}>{DIV_LABEL[d]}</option>)}
      </select>
      <span className="tl-sp" />
      <button type="button" className="ibtn" title="Zoom out (⌘−)" aria-label="Zoom out" data-testid="v3-zoom-out" onClick={() => zoom("zoom_out")}>
        <IconZoomOut />
      </button>
      <button type="button" className="ibtn" title="Zoom in (⌘+)" aria-label="Zoom in" data-testid="v3-zoom-in" onClick={() => zoom("zoom_in")}>
        <IconZoomIn />
      </button>
    </div>
  );
}

function LaneGrid({ marks }: { marks: GridMark[] }) {
  return (
    <div className="lane-grid" aria-hidden="true" data-testid="v3-lane-grid">
      {marks.map((m) => <i key={m.beat} className={m.bar ? "bar" : "beat"} data-beat={m.beat} style={{ left: m.x }} />)}
    </div>
  );
}

function TrackRow({ track, snapshot, marks, lanePx, pxPerSec }: { track: Track; snapshot: Snapshot; marks: GridMark[]; lanePx: number; pxPerSec: number }) {
  const exec = useStore((s) => s.exec);
  const selectedTrackId = useStore((s) => s.selectedTrackId);
  const recording = useStore((s) => s.transport.recording);
  const ensurePeaks = useStore((s) => s.ensurePeaks);
  const peaks = useStore((s) => s.peaks);
  const selection = useStore((s) => s.selection);
  const locks = useStore((s) => s.locksByLogicalId);
  const selfPeer = useStore((s) => s.mp.selfPeer);
  const peers = useStore((s) => s.peers);
  const setContext = useV3((s) => s.setContext);
  // Multiplayer: a track a PEER holds is read-only here (the backend lock guard is the
  // authority; this is the badge and the disabled controls, same as ui/Arrange.tsx).
  const lockOwner = lockOwnerOfTrack(track, locks);
  const lockedByOther = lockOwner !== null && lockOwner !== selfPeer;
  const lockName = lockedByOther ? (peers[lockOwner]?.name || lockOwner) : null;
  const sel = selectedTrackId === track.id;
  const tempo = snapshot.session.tempo;
  const clips = track.clips.filter((c) => !c.hidden);

  useEffect(() => {
    for (const c of clips) if (c.type === "wave") ensurePeaks(c.id);
  }, [clips, ensurePeaks]);

  return (
    <div className={`trk${sel ? " sel" : ""}`} data-testid="v3-track" data-track-id={track.id}
      data-locked-by={lockedByOther ? lockOwner : undefined} data-mute={track.mute || undefined}>
      <div className="hd">
        <button type="button" className="track-name" aria-label={`Select track ${track.name}`} aria-pressed={sel}
          onClick={() => { useStore.getState().setSelectedTrack(track.id); useStore.getState().clearSelection(); }}><b>{track.name}</b></button>
        {(track.type === "midi" || track.type === "drum" || clips.some((c) => c.type === "midi"))
          ? <span className="midi-tag">MIDI</span> : null}
        {lockName ? <span className="lock" data-testid="v3-track-lock" title={`Locked by ${lockName}`}>{lockName}</span> : null}
        <div className="ctl">
          <button type="button" className={track.armed ? "arm" : ""} aria-label="Arm" disabled={lockedByOther}
            onClick={() => void exec("arm_track", { trackId: track.id, armed: !track.armed })}>R</button>
          <button type="button" aria-pressed={!!track.mute} aria-label="Mute" disabled={lockedByOther}
            onClick={() => void exec("set_track_mute", { trackId: track.id, mute: !track.mute })}>M</button>
          <button type="button" aria-pressed={!!track.solo} aria-label="Solo" disabled={lockedByOther}
            onClick={() => void exec("set_track_solo", { trackId: track.id, solo: !track.solo })}>S</button>
        </div>
      </div>
      <div className="lane" style={{ width: lanePx }} onClick={() => {
        useStore.getState().setSelectedTrack(track.id);
        useStore.getState().clearSelection();
      }}>
        <LaneGrid marks={marks} />
        {clips.map((clip) => (
          <ClipBody key={clip.id} clip={clip} pxPerSec={pxPerSec} tempo={tempo}
            selected={selection.has(clip.id)}
            live={!!(recording && track.armed && clip.type === "wave")}
            peaks={peaks[clip.id]}
            editable={!lockedByOther}
            onSelect={() => {
              useStore.getState().setSelectedTrack(track.id);
              useStore.getState().select([clip.id]);
            }}
            onContext={(x, y, time) => setContext({ x, y, clipId: clip.id, trackId: track.id, time })}
          />
        ))}
      </div>
    </div>
  );
}

function ClipBody({
  clip, pxPerSec, tempo, selected, live, peaks, editable = true, onSelect, onContext,
}: {
  clip: Clip;
  pxPerSec: number;
  tempo: number | undefined;
  selected: boolean;
  live: boolean;
  peaks?: [number, number][];
  editable?: boolean;
  onSelect: () => void;
  onContext: (x: number, y: number, time: number) => void;
}) {
  const exec = useStore((s) => s.exec);
  const snapTime = useStore((s) => s.snapTime);
  const ripple = useStore((s) => s.ripple);
  // Optimistic move / trim preview — the same shape and commit path as v2's ClipView
  // (ui/clipDrag.ts): the preview stays until the snapshot lands, or reverts on refusal.
  const [preview, setPreview] = useState<DragPos | null>(null);
  useEffect(() => { setPreview(null); }, [clip.start, clip.length, clip.offset]);
  const drag = useRef<{ kind: DragKind; startX: number; startY: number; engaged: boolean; orig: DragPos; epoch: number } | null>(null);
  const escDispose = useRef<(() => void) | null>(null);
  const shown = preview ?? { start: clip.start, length: clip.length, offset: clip.offset };
  const { left, width } = clipBox(shown, pxPerSec);
  // Notes are laid out on the clip's exact beat length (it follows the drag preview too).
  const { lengthBeats } = clipBeats(shown, tempo);
  const midi = clip.type === "midi";
  const drums = midi && isDrumClip(clip.notes);
  const edit = () => { onSelect(); if (midi && editable) useStore.getState().openPianoRoll(clip.id); };
  const timeAt = (e: { clientX: number; currentTarget: EventTarget & Element }) => {
    const rect = e.currentTarget.getBoundingClientRect();
    return Math.max(0, shown.start + (e.clientX - rect.left) / pxPerSec);
  };
  const cancelDrag = () => { drag.current = null; setPreview(null); escDispose.current?.(); escDispose.current = null; };

  const onDown = (e: React.PointerEvent<HTMLDivElement>) => {
    e.stopPropagation();
    if (e.button !== 0 || !editable) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const localX = e.clientX - rect.left;
    const edgePx = liveFeel().edgeGrabPx;
    const region = classifyClipRegion({ x: localX, y: e.clientY - rect.top, width: rect.width, height: rect.height, edgeGrabPx: edgePx, headerPx: 0 });
    const mods = modsOf(e);
    const table = liveGestureTable();
    const clickAction = resolveGesture(table, { region, gesture: "click", mods, tool: "move" });
    const dragAction = resolveGesture(table, { region, gesture: "drag", mods, tool: "move" });
    if (clickAction === EA.SELECT) onSelect();
    else if (clickAction === EA.ADDITIVE_SELECT) useStore.getState().select([clip.id], true);
    let kind: DragKind | null = null;
    if (dragAction === EA.MOVE) kind = "move";
    else if (dragAction === EA.TRIM || dragAction === EA.STRETCH) kind = localX <= edgePx ? "trim-l" : "trim-r";
    if (!kind) return;            // e.g. a table whose body drag is a time selection — V3 has no range band
    capturePointer(e.currentTarget, e.pointerId);
    drag.current = { kind, startX: e.clientX, startY: e.clientY, engaged: false,
      orig: { start: clip.start, length: clip.length, offset: clip.offset }, epoch: useStore.getState().projectEpoch };
    escDispose.current?.();
    escDispose.current = pushEscapeHandler(cancelDrag);
  };
  const onMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const d = drag.current; if (!d) return;
    const dx = e.clientX - d.startX, dy = e.clientY - d.startY;
    const threshold = liveFeel().dragThreshold;
    if (!d.engaged) { if (!passedDragThreshold(dx, dy, threshold)) return; d.engaged = true; }
    if (Math.abs(dx) <= threshold) { setPreview(null); return; }
    const delta = dx / pxPerSec, o = d.orig;
    const t = (raw: number) => e.altKey ? raw : snapTime(raw);   // Option bypasses snap for this gesture
    if (d.kind === "move") setPreview({ ...o, start: Math.max(0, t(o.start + delta)) });
    else if (d.kind === "trim-r") setPreview({ ...o, length: Math.max(MIN_LEN, t(o.start + o.length + delta) - o.start) });
    else {
      const start = Math.max(0, Math.min(o.start + o.length - MIN_LEN, t(o.start + delta)));
      const used = start - o.start;
      setPreview({ start, length: o.length - used, offset: Math.max(0, o.offset + used) });
    }
  };
  const onUp = (e: React.PointerEvent<HTMLDivElement>) => {
    const d = drag.current; drag.current = null;
    escDispose.current?.(); escDispose.current = null;
    releasePointer(e.currentTarget, e.pointerId);
    if (!d || !d.engaged) return;
    if (useStore.getState().projectEpoch !== d.epoch) { setPreview(null); return; }
    commitClipDrag(d.kind, preview, d.orig.start, clip.id, exec, setPreview, ripple);
  };
  return (
    <div className={`clip${selected ? " hl" : ""}${drag.current?.engaged ? " dragging" : ""}`} style={{ left, width }}
      data-testid="v3-clip" data-clip-id={clip.id} data-clip-start={shown.start} data-clip-length={shown.length}
      role="button" tabIndex={0}
      title={midi ? "Double-click or press Enter to edit MIDI" : clip.name}
      aria-label={`${clip.name}, ${clip.type === "wave" ? "audio" : "MIDI"} clip`} aria-pressed={selected}
      onKeyDown={(e) => {
        // Enter only: Space bubbles to the app keymap (play/pause), so Space after a clip click plays.
        if (e.key === "Enter") { e.preventDefault(); e.stopPropagation(); edit(); }
      }}
      onPointerDown={onDown} onPointerMove={onMove} onPointerUp={onUp} onPointerCancel={cancelDrag}
      onDoubleClick={(e) => { e.stopPropagation(); edit(); }}
      onClick={(e) => { e.stopPropagation(); }}
      onContextMenu={(e) => { e.preventDefault(); onSelect(); onContext(e.clientX, e.clientY, snapTime(timeAt(e))); }}>
      <span className="clip-name" title={clip.name}>{clip.name}</span>
      {drums ? <DrumsClip notes={clip.notes} beats={lengthBeats} />
        : midi ? <MelodyClip notes={clip.notes} beats={lengthBeats} />
        : <SilhouetteWave peaks={peaks} selected={selected} live={live} />}
    </div>
  );
}

export function Arrangement({ snapshot }: { snapshot: Snapshot }) {
  const selectedTrackId = useStore((s) => s.selectedTrackId);
  const selectedTrack = snapshot.tracks.find((track) => track.id === selectedTrackId);
  const canAddMidi = !!selectedTrack && (selectedTrack.type === "midi" || selectedTrack.type === "drum"
    || selectedTrack.clips.some((clip) => clip.type === "midi")
    || selectedTrack.plugins?.some((plugin) => plugin.isInstrument));
  const run = (action: "insert_audio_track" | "insert_midi_track" | "insert_midi_clip") => void runAction(action, { store: useStore.getState(), pickFiles, pickSaveFile });
  const pxPerSec = useStore((s) => s.pxPerSec);
  // A running Moshi task holds ONE open undo transaction: a click that edits now would fold into
  // the agent's undo step, so the one-click part drops wait for it to end.
  const taskLive = useAgentTaskLive();
  const beatWidth = beatPx(snapshot.session.tempo, pxPerSec);
  const tracks = snapshot.tracks.filter((t) => !t.isReturn && t.active !== false);
  // Lanes are laid out in px at the shared zoom (store.pxPerSec — the scale v2 and Pro Tools
  // zoom too) inside the .tracks scroller; headers stay put (sticky) and the ruler follows the
  // lane scroll so bar numbers sit over their beats at every zoom.
  const scrollerRef = useRef<HTMLDivElement>(null);
  const rulerRef = useRef<HTMLDivElement>(null);
  const [viewportPx, setViewportPx] = useState(1100);
  useLayoutEffect(() => {
    const el = scrollerRef.current; if (!el) return;
    const measure = () => setViewportPx(Math.max(200, el.clientWidth - 8 * 2 - 154));
    measure();
    if (typeof ResizeObserver === "undefined") return;   // jsdom
    const ro = new ResizeObserver(measure); ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const lanePx = laneContentPx(snapshot.session, pxPerSec, viewportPx);
  const beats = gridBeatCount(snapshot.session, pxPerSec, lanePx);   // beats across the lane
  // One set of grid marks for every lane and the ruler, snapped to this display's pixels.
  const marks = gridMarks(beats, beatWidth, typeof window === "undefined" ? 1 : window.devicePixelRatio || 1);
  const beatLabels = gridDensity(beatWidth).beats;
  const onScroll = () => {
    if (rulerRef.current && scrollerRef.current) rulerRef.current.style.transform = `translateX(${-scrollerRef.current.scrollLeft}px)`;
  };
  return (
    <div className="main" data-testid="v3-arrangement" data-px-per-sec={pxPerSec}>
      <div className="workspace-head" role="toolbar" aria-label="Tracks">
        <button type="button" className="btn sm" data-testid="v3-add-audio" onClick={() => run("insert_audio_track")}>+ Audio track</button>
        <button type="button" className="btn sm" data-testid="v3-add-midi" onClick={() => run("insert_midi_track")}>+ MIDI track</button>
        <button type="button" className="btn sm" data-testid="v3-add-drum-beat" disabled={taskLive}
          title={taskLive ? "Moshi is working — add a beat when it finishes"
            : "A drum track with the bundled kit and a four-bar beat — from bar 1 in an empty session, else from the bar at the playhead — one undo step"}
          onClick={() => void dropDrumBeat()}>+ Drum beat</button>
        <button type="button" className="btn sm" data-testid="v3-add-chords" disabled={taskLive}
          title={taskLive ? "Moshi is working — add chords when it finishes"
            : "A Keys track with a four-bar chord progression (Am, F, C, G) — opens its presets; one undo step"}
          onClick={() => void dropChords()}>+ Chords</button>
        <button type="button" className="btn sm" data-testid="v3-add-midi-clip" disabled={!canAddMidi} title={canAddMidi ? "Add one bar at the playhead" : "Select a MIDI track first"} onClick={() => run("insert_midi_clip")}>+ MIDI clip</button>
        <button type="button" className="btn sm" data-testid="v3-import-audio" onClick={() => { useV3.getState().setPane("browser"); useV3.getState().setBrowserTab("files"); }}>Import audio…</button>
      </div>
      <div className="arr-head">
        <TimelineCorner />
        <div className="ruler-clip">
          <div className="ruler-scroll" ref={rulerRef} style={{ width: lanePx }}>
            <SectionStrip sections={snapshot.sections} tempo={snapshot.session.tempo} pxPerSec={pxPerSec} />
            <Ruler marks={marks} widthPx={lanePx} pxPerSec={pxPerSec} beatLabels={beatLabels} />
            {tracks.length > 0 && <RulerMarker />}
          </div>
        </div>
      </div>
      <div className="tracks" ref={scrollerRef} onScroll={onScroll}>
        {tracks.length === 0 && <div className="workspace-empty"><b>Start your session</b><p>Add an audio track to record, a MIDI track to write notes, drop in a drum beat or a chord progression, or import audio from the browser.</p></div>}
        <div className="rows">
          {tracks.map((t) => <TrackRow key={t.id} track={t} snapshot={snapshot} marks={marks} lanePx={lanePx} pxPerSec={pxPerSec} />)}
          {tracks.length > 0 && <Playhead />}
        </div>
      </div>
    </div>
  );
}
