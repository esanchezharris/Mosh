import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
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
import { clipBeatCount, clipBox, laneContentPx, sessionBeatCount } from "./timeline";
import { lockOwnerOfTrack } from "../multiplayer/sync";
import type { Clip, Snapshot, Track } from "../types";
import { useV3 } from "./shellState";
import { SilhouetteWave } from "./waves/SilhouetteWave";
import { DrumsClip, MelodyClip } from "./midi/MidiClips";
import { dropDrumBeat } from "./beats";

const modsOf = (e: { shiftKey?: boolean; altKey?: boolean; metaKey?: boolean; ctrlKey?: boolean }): Mods =>
  ({ shift: !!e.shiftKey, alt: !!e.altKey, meta: !!(e.metaKey || e.ctrlKey) });
const capturePointer = (el: Element, id: number) => { try { (el as HTMLElement).setPointerCapture(id); } catch { /* no-op */ } };
const releasePointer = (el: Element, id: number) => { try { (el as HTMLElement).releasePointerCapture(id); } catch { /* no-op */ } };
const MIN_LEN = 0.05;
type DragKind = "move" | "trim-l" | "trim-r";

function Ruler({ beats, widthPx, startBar = 1 }: { beats: number; widthPx: number; startBar?: number }) {
  const cells: ReactNode[] = [];
  for (let i = 0; i < beats; i++) {
    const beat = (i % 4) + 1;
    if (beat === 1) cells.push(<span key={i} className="rn bar">{startBar + Math.floor(i / 4)}</span>);
    else cells.push(<span key={i} className="rn beat">.{beat}</span>);
  }
  return <div className="ruler" style={{ ["--beats" as string]: String(beats), width: widthPx }} data-testid="v3-ruler">{cells}</div>;
}

function LaneGrid({ beats }: { beats: number }) {
  return (
    <div className="lane-grid" style={{ ["--cells" as string]: String(beats) }} aria-hidden="true">
      {Array.from({ length: beats }, (_, i) => <i key={i} />)}
    </div>
  );
}

function TrackRow({ track, snapshot, beats, lanePx, pxPerSec }: { track: Track; snapshot: Snapshot; beats: number; lanePx: number; pxPerSec: number }) {
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
      data-locked-by={lockedByOther ? lockOwner : undefined}>
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
        <LaneGrid beats={beats} />
        {clips.map((clip) => (
          <ClipBody key={clip.id} clip={clip} pxPerSec={pxPerSec} beats={clipBeatCount(clip.length, tempo)}
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
  clip, pxPerSec, beats, selected, live, peaks, editable = true, onSelect, onContext,
}: {
  clip: Clip;
  pxPerSec: number;
  beats: number;
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
        if (e.key === "Enter" || e.key === " ") { e.preventDefault(); e.stopPropagation(); if (e.key === "Enter") edit(); else onSelect(); }
      }}
      onPointerDown={onDown} onPointerMove={onMove} onPointerUp={onUp} onPointerCancel={cancelDrag}
      onDoubleClick={(e) => { e.stopPropagation(); edit(); }}
      onClick={(e) => { e.stopPropagation(); }}
      onContextMenu={(e) => { e.preventDefault(); onSelect(); onContext(e.clientX, e.clientY, snapTime(timeAt(e))); }}>
      <span className="clip-name" title={clip.name}>{clip.name}</span>
      {drums ? <DrumsClip notes={clip.notes} beats={beats} />
        : midi ? <MelodyClip notes={clip.notes} beats={beats} />
        : <SilhouetteWave peaks={peaks} selected={selected} live={live} beats={beats} />}
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
  const beats = sessionBeatCount(snapshot.session);
  const tracks = snapshot.tracks.filter((t) => !t.isReturn && t.active !== false);
  // Lanes are laid out in px at the shared zoom (store.pxPerSec — the scale v2 and Pro Tools
  // zoom too) inside the .tracks scroller; headers stay put (sticky) and the ruler follows the
  // lane scroll so bar numbers sit over their beats at every zoom.
  const scrollerRef = useRef<HTMLDivElement>(null);
  const rulerRef = useRef<HTMLDivElement>(null);
  const [viewportPx, setViewportPx] = useState(1100);
  useLayoutEffect(() => {
    const el = scrollerRef.current; if (!el) return;
    const measure = () => setViewportPx(Math.max(200, el.clientWidth - 8 * 2 - 148 - 6));
    measure();
    if (typeof ResizeObserver === "undefined") return;   // jsdom
    const ro = new ResizeObserver(measure); ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const lanePx = laneContentPx(snapshot.session, pxPerSec, viewportPx);
  const onScroll = () => {
    if (rulerRef.current && scrollerRef.current) rulerRef.current.style.transform = `translateX(${-scrollerRef.current.scrollLeft}px)`;
  };
  return (
    <div className="main" data-testid="v3-arrangement" data-px-per-sec={pxPerSec}>
      <div className="workspace-head" role="toolbar" aria-label="Tracks">
        <button type="button" className="btn sm" data-testid="v3-add-audio" onClick={() => run("insert_audio_track")}>+ Audio track</button>
        <button type="button" className="btn sm" data-testid="v3-add-midi" onClick={() => run("insert_midi_track")}>+ MIDI track</button>
        <button type="button" className="btn sm" data-testid="v3-add-drum-beat" title="A drum track with the bundled kit and a one-bar beat at the playhead — one undo step"
          onClick={() => void dropDrumBeat()}>+ Drum beat</button>
        <button type="button" className="btn sm" data-testid="v3-add-midi-clip" disabled={!canAddMidi} title={canAddMidi ? "Add one bar at the playhead" : "Select a MIDI track first"} onClick={() => run("insert_midi_clip")}>+ MIDI clip</button>
        <button type="button" className="btn sm" data-testid="v3-import-audio" onClick={() => { useV3.getState().setPane("browser"); useV3.getState().setBrowserTab("files"); }}>Import audio…</button>
      </div>
      <div className="arr-head">
        <div className="hdr-spacer" />
        <div className="ruler-clip" ref={rulerRef}><Ruler beats={beats} widthPx={lanePx} startBar={1} /></div>
      </div>
      <div className="tracks" ref={scrollerRef} onScroll={onScroll}>
        {tracks.length === 0 && <div className="workspace-empty"><b>Start your session</b><p>Add an audio track to record, a MIDI track to write notes, drop in a drum beat, or import audio from the browser.</p></div>}
        {tracks.map((t) => <TrackRow key={t.id} track={t} snapshot={snapshot} beats={beats} lanePx={lanePx} pxPerSec={pxPerSec} />)}
      </div>
    </div>
  );
}
