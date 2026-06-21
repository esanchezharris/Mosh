// MoshIR — the normalized session IR shared by every project-file importer.
//
// Each format gets a thin parser frontend that targets THIS shape; a single
// emitter (emit.ts) turns it into agent-callable MoshOps commands. Adding a
// format = writing one parser to MoshIR, nothing else.
//
// The IR is deliberately small: only what maps to the agent-callable command
// subset. Anything a format carries that has no agent command (plugins by id,
// audio sample content, automation, sends/returns, group nesting, …) is recorded
// in `unmappable` rather than silently dropped (spec Phase-1 rule).

export type IRNote = {
  pitch: number; // MIDI 0–127
  start: number; // beats from the clip start
  length: number; // beats
  velocity: number; // 0–127
};

export type IRClip = {
  name?: string;
  kind: "wave" | "midi";
  start: number; // seconds on the timeline
  length: number; // seconds
  sourceFile?: string; // wave only — informational (no agent import_clip command)
  notes?: IRNote[]; // midi only
};

export type IRTrack = {
  name?: string;
  type: "audio" | "drum"; // the MoshOps track types
  volumeDb?: number;
  pan?: number; // -1 (L) … 1 (R)
  mute?: boolean;
  solo?: boolean;
  clips: IRClip[];
};

export type IRSession = {
  tempo?: number; // BPM
  timeSig?: { numerator: number; denominator: number };
  key?: { tonic: string; mode: string };
  tracks: IRTrack[];
};

export type ImportIR = {
  format: "rpp" | "als" | "flp";
  source: string; // file path or name
  session: IRSession;
  unmappable: string[]; // features seen but not representable as agent commands
};

/** Convenience: an empty IR for a given format/source. */
export function emptyIR(format: ImportIR["format"], source: string): ImportIR {
  return { format, source, session: { tracks: [] }, unmappable: [] };
}
