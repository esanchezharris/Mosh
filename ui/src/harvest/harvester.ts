// Harvester — turn the live MoshOps JSONL command log into versioned training
// tuples. The live log carries commands but NOT snapshots, so snapshots are
// reconstructed by replaying the whole log once through the mock backend and
// capturing state at each agent turn's batch boundaries (O(n), single pass).
//
// An agent turn is the span between a `batch_begin` that carries a `turn_id`
// (written by the TS executor) and its `batch_end`. Manual (direct-manipulation)
// commands and legacy pre-marker batches advance state but never form tuples,
// keeping the agent-vs-human split clean.

import type { Snapshot, CommandResult } from "../types";
import { __resetMockForTests, mockExecute, mockSnapshot } from "../bridge.mock";
import { validateCommand } from "../agent/commands";
import { computeUndoneTurns, type UndoEvent } from "./outcome";
import {
  TUPLE_SCHEMA_VERSION,
  isAgentCallable,
  type ControllerEventRecord,
  type ControllerLabel,
  type Tuple,
  type TupleCommand,
  type TasteEvent,
  type TurnSource,
} from "./tupleSchema";
import type { ControllerEventName } from "../types";

export type LogLine = {
  ts: number;
  seq: number;
  command: string;
  args: Record<string, unknown>;
  ok: boolean;
  error?: string;
  undoable: boolean;
};

const STRUCTURAL = new Set(["batch_begin", "batch_end"]);
const TASTE = new Set(["accept_render", "reject_render"]);
const CONTROLLER_EVENTS = new Set<ControllerEventName>([
  "TRANSPORT_TOGGLE",
  "TRANSPORT_SCRUB",
  "TAKE_LISTEN",
  "TAKE_KEEP",
  "TAKE_REDO",
  "TAKE_MARK",
]);
const CONTROLLER_LABELS = new Set<ControllerLabel>(["kept", "undone", "flagged"]);

/** Parse a mosh-log.jsonl into typed records, tolerant of blank/garbage lines. */
export function parseLog(text: string): LogLine[] {
  const out: LogLine[] = [];
  for (const raw of text.split("\n")) {
    const s = raw.trim();
    if (!s) continue;
    let obj: unknown;
    try {
      obj = JSON.parse(s);
    } catch {
      continue;
    }
    if (!obj || typeof obj !== "object") continue;
    const o = obj as Record<string, unknown>;
    if (typeof o.command !== "string") continue;
    out.push({
      ts: typeof o.ts === "number" ? o.ts : 0,
      seq: typeof o.seq === "number" ? o.seq : 0,
      command: o.command,
      args: o.args && typeof o.args === "object" ? (o.args as Record<string, unknown>) : {},
      ok: o.ok !== false,
      error: typeof o.error === "string" ? o.error : undefined,
      undoable: o.undoable === true,
    });
  }
  return out;
}

type WorkingTurn = {
  turnId: string;
  utterance: string;
  source: TurnSource;
  ts: number;
  seqBegin: number;
  seqEnd: number;
  snapshotBefore: Snapshot;
  snapshotAfter: Snapshot;
  commands: TupleCommand[];
  appliedClean: boolean;
  replayClean: boolean;
  clipIds: Set<string>; // clips this turn referenced (for taste association)
  taste: TasteEvent[];
};

function asSource(v: unknown): TurnSource {
  return v === "brain_chat"
    || v === "voice"
    || v === "fastpath"
    || v === "section_scope"
    || v === "agent_loop"
    || v === "studio_skill"
    || v === "studio_skill_blocked"
    || v === "studio_skill_unsupported"
    ? v
    : "unknown";
}

function asControllerEvent(v: unknown): ControllerEventName | null {
  return typeof v === "string" && CONTROLLER_EVENTS.has(v as ControllerEventName) ? (v as ControllerEventName) : null;
}

function controllerLabelFor(event: ControllerEventName, args: Record<string, unknown>): ControllerLabel | undefined {
  const explicit = args.controllerLabel;
  if (typeof explicit === "string" && CONTROLLER_LABELS.has(explicit as ControllerLabel)) {
    return explicit as ControllerLabel;
  }
  if (event === "TAKE_KEEP") return "kept";
  if (event === "TAKE_REDO") return "undone";
  if (event === "TAKE_MARK") return "flagged";
  return undefined;
}

/** Read a mosh-log.jsonl (text) and emit one tuple per tagged agent turn. */
export async function harvest(
  text: string,
  opts: { logPath?: string; harvestedAt?: string } = {},
): Promise<Tuple[]> {
  const lines = parseLog(text);
  const logPath = opts.logPath ?? "";
  const harvestedAt = opts.harvestedAt ?? new Date().toISOString();

  __resetMockForTests();

  const turns: WorkingTurn[] = [];
  const events: UndoEvent[] = []; // undo-stack model for outcome.undone
  const tasteLines: { kind: TasteEvent["kind"]; clipId?: string; seq: number }[] = [];

  let open: WorkingTurn | null = null;
  let inLegacyBatch = false; // a batch_begin with no turn_id

  for (const ln of lines) {
    if (ln.command === "batch_begin") {
      const turnId = typeof ln.args.turn_id === "string" ? ln.args.turn_id : null;
      if (turnId) {
        // A new tagged turn opens here. If a previous turn never closed (a
        // malformed log — the engine returns before logging a nested batch_begin,
        // so this can't happen in production), reassigning `open` drops it cleanly:
        // its commands are never merged into this turn.
        open = {
          turnId,
          // FS-B2a (H2) — NO fallback to args.name. The name is the undo-transaction
          // label, which is Moshi's OWN text; substituting it here would re-fabricate
          // the ask one layer below the executor and train the model on its own words.
          // An absent utterance stays empty, and emptiness is filtered out below.
          utterance: typeof ln.args.utterance === "string" ? ln.args.utterance : "",
          source: asSource(ln.args.source),
          ts: ln.ts,
          seqBegin: ln.seq,
          seqEnd: ln.seq,
          snapshotBefore: await mockSnapshot<Snapshot>(), // state before the batch
          snapshotAfter: await mockSnapshot<Snapshot>(),
          commands: [],
          appliedClean: true,
          replayClean: true,
          clipIds: new Set<string>(),
          taste: [],
        };
      } else {
        inLegacyBatch = true;
      }
      await mockExecute<CommandResult>({ command: ln.command, args: ln.args });
      continue;
    }

    if (ln.command === "batch_end") {
      await mockExecute<CommandResult>({ command: ln.command, args: ln.args });
      if (open) {
        open.seqEnd = ln.seq;
        open.snapshotAfter = await mockSnapshot<Snapshot>();
        events.push({ kind: "push", unit: { turnIndex: turns.length } });
        turns.push(open);
        open = null;
      } else if (inLegacyBatch) {
        inLegacyBatch = false;
      }
      continue;
    }

    // undo / redo drive the outcome model and the reconstructed state alike
    if (ln.command === "undo" && ln.ok) events.push({ kind: "undo" });
    else if (ln.command === "redo" && ln.ok) events.push({ kind: "redo" });

    // taste labels (accept/reject_render) — recorded for association below
    if (TASTE.has(ln.command)) {
      const clipId = typeof ln.args.clipId === "string" ? ln.args.clipId : undefined;
      tasteLines.push({ kind: ln.command as TasteEvent["kind"], clipId, seq: ln.seq });
    }

    // apply through the mock (advances reconstructed state)
    const res = await mockExecute<CommandResult>({ command: ln.command, args: ln.args });

    if (open) {
      // a command belonging to the current agent turn
      const agentCallable = isAgentCallable(ln.command);
      open.commands.push({
        command: ln.command,
        args: ln.args,
        ok: ln.ok,
        error: ln.error,
        agentCallable,
      });
      if (!ln.ok) open.appliedClean = false;
      const validateErr = STRUCTURAL.has(ln.command) ? null : validateCommand(ln.command, ln.args);
      if (validateErr || !res.ok) open.replayClean = false;
      if (typeof ln.args.clipId === "string") open.clipIds.add(ln.args.clipId);
    } else if (ln.undoable && ln.command !== "undo" && ln.command !== "redo") {
      // a standalone manual undoable command — its own unit on the undo stack
      events.push({ kind: "push", unit: { turnIndex: null } });
    }
  }

  // resolve undone turns from the undo-stack model
  const undone = computeUndoneTurns(events);

  // Associate each taste label with the most-recent turn that started no later
  // than the label and referenced that clipId. seqBegin (not seqEnd) is deliberate:
  // an agent that renders AND accepts within one batch should keep its own taste
  // label, even though that accept_render's seq falls inside the batch window.
  for (const t of tasteLines) {
    if (!t.clipId) continue;
    let best: WorkingTurn | null = null;
    for (const turn of turns) {
      if (turn.seqBegin <= t.seq && turn.clipIds.has(t.clipId)) best = turn;
    }
    if (best) best.taste.push({ kind: t.kind, clipId: t.clipId, seq: t.seq });
  }

  // FS-B2a (H3) — a turn that ran zero commands is an ASK WE COULD NOT SERVE, not a
  // trajectory. It is recorded in the log on purpose (it names a missing skill — see
  // harvestUnservedAsks below) but it must never enter the imitation corpus, or the
  // model learns "for this ask, do nothing". Filtered by index so `undone` still lines
  // up with the turn it was computed for.
  return turns
    .map((turn, i) => ({ turn, i }))
    .filter(({ turn }) => turn.commands.length > 0)
    .map(({ turn, i }) => ({
      schemaVersion: TUPLE_SCHEMA_VERSION,
      kind: "imitation" as const,
      turnId: turn.turnId,
      utterance: turn.utterance,
      source: turn.source,
      ts: turn.ts,
      seq: { begin: turn.seqBegin, end: turn.seqEnd },
      snapshotBefore: turn.snapshotBefore,
      snapshotAfter: turn.snapshotAfter,
      commands: turn.commands,
      outcome: {
        appliedClean: turn.appliedClean,
        replayClean: turn.replayClean,
        undone: undone.has(i),
        taste: turn.taste,
      },
      provenance: { logPath, harvestedAt },
    }));
}

/** An ask that reached Moshi but produced no command — the marker pair with nothing
 *  between it. These are the missing-skill signals FS-B2 mines: what producers ask
 *  for that the current skill set cannot serve. Deliberately NOT tuples (there is no
 *  trajectory to imitate) and deliberately not derived from `args.name` — an ask with
 *  no recorded utterance carries no information and is skipped. */
export type UnservedAsk = { turnId: string; utterance: string; source: TurnSource; ts: number };

export function harvestUnservedAsks(text: string): UnservedAsk[] {
  const lines = parseLog(text);
  const out: UnservedAsk[] = [];
  let open: { turnId: string; utterance: string; source: TurnSource; ts: number } | null = null;
  let commandsSinceBegin = 0;

  for (const ln of lines) {
    if (ln.command === "batch_begin") {
      const turnId = typeof ln.args.turn_id === "string" ? ln.args.turn_id : null;
      open = turnId
        ? {
            turnId,
            utterance: typeof ln.args.utterance === "string" ? ln.args.utterance : "",
            source: asSource(ln.args.source),
            ts: ln.ts,
          }
        : null;
      commandsSinceBegin = 0;
    } else if (ln.command === "batch_end") {
      if (open && commandsSinceBegin === 0 && open.utterance) out.push(open);
      open = null;
    } else if (open) {
      commandsSinceBegin++;
    }
  }
  return out;
}

export async function harvestControllerEvents(
  text: string,
  opts: { logPath?: string; harvestedAt?: string } = {},
): Promise<ControllerEventRecord[]> {
  const lines = parseLog(text);
  const logPath = opts.logPath ?? "";
  const harvestedAt = opts.harvestedAt ?? new Date().toISOString();

  __resetMockForTests();

  const records: ControllerEventRecord[] = [];
  for (const ln of lines) {
    const snapshotBefore = await mockSnapshot<Snapshot>();
    const res = await mockExecute<CommandResult>({ command: ln.command, args: ln.args });
    const snapshotAfter = await mockSnapshot<Snapshot>();

    if (ln.args.source !== "phone_controller") continue;
    const event = asControllerEvent(ln.args.controllerEvent);
    if (!event) continue;

    records.push({
      schemaVersion: TUPLE_SCHEMA_VERSION,
      kind: "controller_event",
      event,
      label: controllerLabelFor(event, ln.args),
      ts: ln.ts,
      seq: ln.seq,
      command: {
        command: ln.command,
        args: ln.args,
        ok: ln.ok,
        error: ln.error,
        agentCallable: isAgentCallable(ln.command),
      },
      snapshotBefore,
      snapshotAfter,
      provenance: { logPath, harvestedAt },
    });

    if (!res.ok && ln.ok) {
      records[records.length - 1].command.error = res.error;
    }
  }

  return records;
}
