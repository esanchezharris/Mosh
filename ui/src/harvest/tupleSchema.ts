// Versioned training-tuple schema for Moshi (Phase 0).
//
// A tuple is one agent turn distilled from the MoshOps JSONL command log:
//   (snapshotBefore, utterance, command-sequence, snapshotAfter, outcome)
// Tuples are SFT / behavioral-cloning (imitation) data — NOT verified-reward RL
// rollouts. The verifier produces the reward signal separately; a harvested
// tuple only records what the agent did and whether the human kept it.
//
// The shape is intentionally flat JSON so it round-trips through JSONL and feeds
// the Python SFT/GEPA/GRPO drivers downstream without a parser.

import type { ControllerEventName, Snapshot } from "../types";
import { AGENT_COMMAND_MAP } from "../agent/commands";

export const TUPLE_SCHEMA_VERSION = 1 as const;

/** What the trajectory is for, kept explicit in the schema per the spec. */
export type TrajectoryKind = "imitation";

/** A single planned/executed command (the unit the model emits). */
export type CommandCall = {
  command: string;
  args?: Record<string, unknown>;
  bind?: string;
  capture?: Record<string, string>;
};

/** Where a turn's utterance came from. Direct human manipulation is never a turn. */
export type TurnSource = "brain_chat" | "voice" | "fastpath" | "unknown";

/** One command inside a turn, with its original log outcome + allowlist tag. */
export type TupleCommand = {
  command: string;
  args: Record<string, unknown>;
  ok: boolean;
  error?: string;
  agentCallable: boolean;
};

/** An explicit taste label emitted by the user (accept/reject of a render). */
export type TasteEvent = {
  kind: "accept_render" | "reject_render";
  clipId?: string;
  seq: number;
};

export type TupleOutcome = {
  /** Every command in the turn returned ok in the original (live) run. */
  appliedClean: boolean;
  /** Every command cleanly validated + applied on deterministic replay. */
  replayClean: boolean;
  /** The turn was reverted by a later undo (net of any redo) before session end. */
  undone: boolean;
  /** Render accept/reject taste labels associated with this turn (by clipId). */
  taste: TasteEvent[];
};

export type Tuple = {
  schemaVersion: typeof TUPLE_SCHEMA_VERSION;
  kind: TrajectoryKind;
  turnId: string;
  utterance: string;
  source: TurnSource;
  /** Wall-clock ms of the turn's batch_begin (from the log). */
  ts: number;
  /** The log sequence numbers bracketing the turn. */
  seq: { begin: number; end: number };
  snapshotBefore: Snapshot;
  snapshotAfter: Snapshot;
  commands: TupleCommand[];
  outcome: TupleOutcome;
  provenance: { logPath: string; harvestedAt: string };
};

export type ControllerLabel = "kept" | "undone" | "flagged";

export type ControllerEventRecord = {
  schemaVersion: typeof TUPLE_SCHEMA_VERSION;
  kind: "controller_event";
  event: ControllerEventName;
  label?: ControllerLabel;
  ts: number;
  seq: number;
  command: TupleCommand;
  snapshotBefore: Snapshot;
  snapshotAfter: Snapshot;
  provenance: { logPath: string; harvestedAt: string };
};

/** True iff `command` is in the curated agent-callable catalog (not structural,
 *  not backend-only). Reuses the single source of truth in agent/commands.ts. */
export function isAgentCallable(command: string): boolean {
  return AGENT_COMMAND_MAP.has(command);
}
