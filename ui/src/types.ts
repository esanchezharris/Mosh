// Snapshot shape from MoshOps.snapshot() (docs/02_MOSHOPS_CONTRACT.md). The UI
// renders this; no Tracktion/audio concepts leak across the seam.

export type Clip = {
  id: string;
  name: string;
  type: "wave" | "midi" | "clip";
  start: number;
  length: number;
  offset: number;
  sourceFile?: string;
  sourceLength?: number;
  hasRenderLayer: boolean;
};

export type Track = {
  id: string;
  index: number;
  name: string;
  type: string;
  clips: Clip[];
  volumeDb?: number;
  pan?: number;
  mute?: boolean;
  solo?: boolean;
};

export type Transport = {
  playing: boolean;
  recording: boolean;
  position: number;
  looping: boolean;
  loopStart: number;
  loopEnd: number;
};

export type Snapshot = {
  schemaVersion: number;
  session: { sampleRate: number; tempo: number; editFile: string };
  tracks: Track[];
  transport: Transport;
};

export type CommandResult<T = unknown> = {
  ok: boolean;
  command: string;
  data?: T;
  error?: string;
};

export type MoshEvent = { type: string; payload?: unknown };
