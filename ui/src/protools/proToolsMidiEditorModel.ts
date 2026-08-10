import type { Clip, Snapshot, Track } from "../types";
import { beatAt, tempoMapFrom } from "../time";
import type { PianoRollContextNote } from "../ui/PianoRollContextNotes";

export type ProToolsMidiEditorTrack = {
  readonly trackId: string;
  readonly trackName: string;
  readonly color?: string;
  readonly clipCount: number;
  readonly targetClipId: string;
  readonly isTarget: boolean;
};

export type ProToolsMidiContextNote = PianoRollContextNote;

const midiClips = (track: Track): readonly Clip[] => (
  track.clips.filter((clip) => clip.type === "midi" && !clip.hidden)
);

const overlap = (a: Clip, b: Clip): number => (
  Math.max(0, Math.min(a.start + a.length, b.start + b.length) - Math.max(a.start, b.start))
);

const distance = (a: Clip, b: Clip): number => {
  if (overlap(a, b) > 0) return 0;
  if (a.start >= b.start + b.length) return a.start - (b.start + b.length);
  return b.start - (a.start + a.length);
};

const cleanBeat = (value: number): number => Number(value.toFixed(9));

export function resolveMidiEditorTargetClip(track: Track, referenceClip: Clip): Clip | null {
  const clips = midiClips(track);
  const exact = clips.find((clip) => clip.id === referenceClip.id);
  if (exact) return exact;
  return [...clips].sort((a, b) => (
    overlap(b, referenceClip) - overlap(a, referenceClip)
    || distance(a, referenceClip) - distance(b, referenceClip)
    || Math.abs(a.start - referenceClip.start) - Math.abs(b.start - referenceClip.start)
    || a.start - b.start
  ))[0] ?? null;
}

export function listMidiEditorTracks(
  snapshot: Snapshot,
  targetClipId: string,
): readonly ProToolsMidiEditorTrack[] {
  const target = snapshot.tracks
    .flatMap((track) => track.clips.map((clip) => ({ track, clip })))
    .find(({ clip }) => clip.id === targetClipId && clip.type === "midi");
  if (!target) return [];

  return snapshot.tracks.flatMap((track) => {
    if (track.isGroup || track.isReturn) return [];
    const clips = midiClips(track);
    if (clips.length === 0) return [];
    const targetClip = resolveMidiEditorTargetClip(track, target.clip);
    if (!targetClip) return [];
    return [{
      trackId: track.id,
      trackName: track.name,
      ...(track.color ? { color: track.color } : {}),
      clipCount: clips.length,
      targetClipId: targetClip.id,
      isTarget: track.id === target.track.id,
    }];
  });
}

export function projectMidiEditorContextNotes(
  snapshot: Snapshot,
  targetClipId: string,
  visibleTrackIds: readonly string[],
): readonly ProToolsMidiContextNote[] {
  const target = snapshot.tracks
    .flatMap((track) => track.clips.map((clip) => ({ track, clip })))
    .find(({ clip }) => clip.id === targetClipId && clip.type === "midi");
  if (!target) return [];

  const visible = new Set(visibleTrackIds);
  const tempoMap = tempoMapFrom(snapshot.session);
  const targetStartBeat = beatAt(tempoMap, target.clip.start);
  const targetEndBeat = beatAt(tempoMap, target.clip.start + target.clip.length);

  return snapshot.tracks.flatMap((track) => {
    if (!visible.has(track.id) || track.isGroup || track.isReturn) return [];
    return midiClips(track).flatMap((clip) => {
      if (clip.id === targetClipId) return [];
      const clipStartBeat = beatAt(tempoMap, clip.start);
      return (clip.notes ?? []).flatMap((note) => {
        const noteStartBeat = clipStartBeat + note.start;
        const noteEndBeat = noteStartBeat + Math.max(0, note.length);
        const visibleStartBeat = Math.max(targetStartBeat, noteStartBeat);
        const visibleEndBeat = Math.min(targetEndBeat, noteEndBeat);
        if (visibleEndBeat <= visibleStartBeat + 1.0e-9) return [];
        return [{
          key: `${track.id}:${clip.id}:${note.i}`,
          trackId: track.id,
          trackName: track.name,
          clipId: clip.id,
          clipName: clip.name,
          ...(track.color ? { color: track.color } : {}),
          pitch: note.pitch,
          start: cleanBeat(visibleStartBeat - targetStartBeat),
          length: cleanBeat(visibleEndBeat - visibleStartBeat),
          velocity: note.velocity,
        }];
      });
    });
  });
}
