// Minimal snapshot subset the phone controller reads. Deliberately decoupled from the main
// UI's big types.ts — the companion is a separate, self-contained page. Field names mirror
// the real MoshOps snapshot (see ui/src/types.ts Snapshot/Transport/Track/ControllerState).

export type Cmd = { command: string; args: Record<string, unknown> };

export type Transport = {
  playing: boolean;
  recording: boolean;
  position: number; // seconds
  looping?: boolean;
  loopStart?: number;
  loopEnd?: number;
};

export type Clip = {
  id: string;
  name?: string;
  type?: string;
  start: number; // seconds
  length: number; // seconds
  hidden?: boolean;
};

export type Track = {
  id: string;
  name?: string;
  index?: number;
  armed?: boolean;
  clips?: Clip[];
};

export type ControllerTake = {
  exists: boolean;
  clipId?: string;
  trackId?: string;
  start?: number;
  length?: number;
  canKeep?: boolean;
  numTakes?: number;
  currentTakeIndex?: number;
};

export type ControllerState = {
  mode?: "capture" | "judgment";
  record?: "idle" | "armed" | "recording";
  take?: ControllerTake;
};

export type Snap = {
  session?: { tempo?: number; timeSigNumerator?: number; length?: number };
  tracks?: Track[];
  transport?: Transport;
  controller?: ControllerState;
};

export type Button = "record" | "keep" | "again" | "hear" | "stop";
