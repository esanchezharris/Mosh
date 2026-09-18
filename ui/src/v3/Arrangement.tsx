import { useEffect, type ReactNode } from "react";
import { pickFiles, pickSaveFile } from "../bridge";
import { runAction } from "../menuActions";
import { useStore } from "../store";
import { isDrumClip } from "../ui/clipRenderers";
import type { Clip, Snapshot, Track } from "../types";
import { useV3 } from "./shellState";
import { SilhouetteWave } from "./waves/SilhouetteWave";
import { DrumsClip, MelodyClip } from "./midi/MidiClips";
import { dropDrumBeat } from "./beats";

function sessionBeats(snapshot: Snapshot): number {
  const tempo = snapshot.session.tempo ?? 120;
  const length = snapshot.session.length ?? 32;
  const beats = Math.round((length * tempo) / 60);
  return Math.max(16, Math.min(64, beats || 32));
}

function Ruler({ beats, startBar = 1 }: { beats: number; startBar?: number }) {
  const cells: ReactNode[] = [];
  for (let i = 0; i < beats; i++) {
    const beat = (i % 4) + 1;
    if (beat === 1) cells.push(<span key={i} className="rn bar">{startBar + Math.floor(i / 4)}</span>);
    else cells.push(<span key={i} className="rn beat">.{beat}</span>);
  }
  return <div className="ruler" style={{ ["--beats" as string]: String(beats) }} data-testid="v3-ruler">{cells}</div>;
}

function LaneGrid({ beats }: { beats: number }) {
  return (
    <div className="lane-grid" style={{ ["--cells" as string]: String(beats) }} aria-hidden="true">
      {Array.from({ length: beats }, (_, i) => <i key={i} />)}
    </div>
  );
}

function TrackRow({ track, snapshot, beats }: { track: Track; snapshot: Snapshot; beats: number }) {
  const exec = useStore((s) => s.exec);
  const selectedTrackId = useStore((s) => s.selectedTrackId);
  const recording = useStore((s) => s.transport.recording);
  const ensurePeaks = useStore((s) => s.ensurePeaks);
  const peaks = useStore((s) => s.peaks);
  const selection = useStore((s) => s.selection);
  const setContext = useV3((s) => s.setContext);
  const sel = selectedTrackId === track.id;
  const length = Math.max(1e-6, snapshot.session.length ?? 32);
  const clips = track.clips.filter((c) => !c.hidden);

  useEffect(() => {
    for (const c of clips) if (c.type === "wave") ensurePeaks(c.id);
  }, [clips, ensurePeaks]);

  return (
    <div className={`trk${sel ? " sel" : ""}`} data-testid="v3-track" data-track-id={track.id}>
      <div className="hd">
        <button type="button" className="track-name" aria-label={`Select track ${track.name}`} aria-pressed={sel}
          onClick={() => { useStore.getState().setSelectedTrack(track.id); useStore.getState().clearSelection(); }}><b>{track.name}</b></button>
        {(track.type === "midi" || track.type === "drum" || clips.some((c) => c.type === "midi"))
          ? <span className="midi-tag">MIDI</span> : null}
        <div className="ctl">
          <button type="button" className={track.armed ? "arm" : ""} aria-label="Arm"
            onClick={() => void exec("arm_track", { trackId: track.id, armed: !track.armed })}>R</button>
          <button type="button" aria-pressed={!!track.mute} aria-label="Mute"
            onClick={() => void exec("set_track_mute", { trackId: track.id, mute: !track.mute })}>M</button>
          <button type="button" aria-pressed={!!track.solo} aria-label="Solo"
            onClick={() => void exec("set_track_solo", { trackId: track.id, solo: !track.solo })}>S</button>
        </div>
      </div>
      <div className="lane" onClick={() => {
        useStore.getState().setSelectedTrack(track.id);
        useStore.getState().clearSelection();
      }}>
        <LaneGrid beats={beats} />
        {clips.map((clip) => (
          <ClipBody key={clip.id} clip={clip} length={length} beats={beats}
            selected={selection.has(clip.id)}
            live={!!(recording && track.armed && clip.type === "wave")}
            peaks={peaks[clip.id]}
            onSelect={() => {
              useStore.getState().setSelectedTrack(track.id);
              useStore.getState().select([clip.id]);
            }}
            onContext={(x, y) => setContext({ x, y, clipId: clip.id, trackId: track.id })}
          />
        ))}
      </div>
    </div>
  );
}

function ClipBody({
  clip, length, beats, selected, live, peaks, onSelect, onContext,
}: {
  clip: Clip;
  length: number;
  beats: number;
  selected: boolean;
  live: boolean;
  peaks?: [number, number][];
  onSelect: () => void;
  onContext: (x: number, y: number) => void;
}) {
  const left = `${(clip.start / length) * 100}%`;
  const width = `${Math.max(2, (clip.length / length) * 100)}%`;
  const midi = clip.type === "midi";
  const drums = midi && isDrumClip(clip.notes);
  const edit = () => { onSelect(); if (midi) useStore.getState().openPianoRoll(clip.id); };
  return (
    <div className={`clip${selected ? " hl" : ""}`} style={{ left, width }}
      data-testid="v3-clip" data-clip-id={clip.id} role="button" tabIndex={0}
      title={midi ? "Double-click or press Enter to edit MIDI" : clip.name}
      aria-label={`${clip.name}, ${clip.type === "wave" ? "audio" : "MIDI"} clip`} aria-pressed={selected}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") { e.preventDefault(); e.stopPropagation(); if (e.key === "Enter") edit(); else onSelect(); }
      }}
      onDoubleClick={(e) => { e.stopPropagation(); edit(); }}
      onClick={(e) => { e.stopPropagation(); onSelect(); }}
      onContextMenu={(e) => { e.preventDefault(); onSelect(); onContext(e.clientX, e.clientY); }}>
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
  const beats = sessionBeats(snapshot);
  const tracks = snapshot.tracks.filter((t) => !t.isReturn && t.active !== false);
  return (
    <div className="main" data-testid="v3-arrangement">
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
        <Ruler beats={beats} startBar={1} />
      </div>
      <div className="tracks">
        {tracks.length === 0 && <div className="workspace-empty"><b>Start your session</b><p>Add an audio track to record, a MIDI track to write notes, drop in a drum beat, or import audio from the browser.</p></div>}
        {tracks.map((t) => <TrackRow key={t.id} track={t} snapshot={snapshot} beats={beats} />)}
      </div>
    </div>
  );
}
