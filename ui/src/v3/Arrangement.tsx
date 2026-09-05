import { useEffect, type ReactNode } from "react";
import { useStore } from "../store";
import { isDrumClip } from "../ui/clipRenderers";
import type { Clip, Snapshot, Track } from "../types";
import { useV3 } from "./shellState";
import { SilhouetteWave } from "./waves/SilhouetteWave";
import { DrumsClip, MelodyClip } from "./midi/MidiClips";

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
  const selectedClipId = useV3((s) => s.selectedClipId);
  const setSelectedClipId = useV3((s) => s.setSelectedClipId);
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
        <b>{track.name}</b>
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
      <div className="lane" onClick={() => useStore.getState().setSelectedTrack(track.id)}>
        <LaneGrid beats={beats} />
        {clips.map((clip) => (
          <ClipBody key={clip.id} clip={clip} length={length} beats={beats}
            selected={selectedClipId === clip.id || (sel && selectedClipId == null)}
            live={!!(recording && track.armed && clip.type === "wave")}
            peaks={peaks[clip.id]}
            onSelect={() => {
              useStore.getState().setSelectedTrack(track.id);
              setSelectedClipId(clip.id);
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
  return (
    <div className={`clip${selected ? " hl" : ""}`} style={{ left, width }}
      data-testid="v3-clip" data-clip-id={clip.id}
      onClick={(e) => { e.stopPropagation(); onSelect(); }}
      onContextMenu={(e) => { e.preventDefault(); onSelect(); onContext(e.clientX, e.clientY); }}>
      {drums ? <DrumsClip notes={clip.notes} beats={beats} />
        : midi ? <MelodyClip notes={clip.notes} beats={beats} />
        : <SilhouetteWave peaks={peaks} selected={selected} live={live} beats={beats} />}
    </div>
  );
}

export function Arrangement({ snapshot }: { snapshot: Snapshot }) {
  const beats = sessionBeats(snapshot);
  const tracks = snapshot.tracks.filter((t) => !t.isReturn && t.active !== false);
  return (
    <div className="main" data-testid="v3-arrangement">
      <div className="arr-head">
        <div className="hdr-spacer" />
        <Ruler beats={beats} startBar={1} />
      </div>
      <div className="tracks">
        {tracks.map((t) => <TrackRow key={t.id} track={t} snapshot={snapshot} beats={beats} />)}
      </div>
    </div>
  );
}
