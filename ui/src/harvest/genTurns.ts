// Real-turn generator — drive Moshi's REAL brain over a session arc and emit
// training tuples, headlessly. There is no in-app capture path that runs without
// a human at the keyboard, so this replays the SAME flow the app would: feed the
// brain the production systemPrompt + a live snapshot, parse its reply, run the
// valid commands through the mock backend, and record one tuple per turn —
// schema-identical to live-harvested tuples (same TupleSchema, same allowlist).
//
// State is built PROGRESSIVELY across the utterance list (the mock is reset once,
// not per turn) so a later turn sees the real ids created by an earlier one — the
// brain is told to "use the REAL ids from the session", so a from-empty arc that
// creates a track then edits it only works if state accumulates, exactly like a
// real session. Snapshots + commands are captured in a SINGLE pass so the ids the
// brain grounded on are exactly the ids stored in the tuple (no second replay,
// which would drift because the mock's id counters survive __resetMockForTests).
//
// The LLM call is INJECTED (CallBrain) so the logic is unit-testable with a fake
// brain and zero network/keys; the CLI (scripts/genTurns.mts) wires the real
// OpenAI-compatible call.

import type { Snapshot, CommandResult } from "../types";
import { __resetMockForTests, mockExecute, mockSnapshot } from "../bridge.mock";
import { validateCommand } from "../agent/commands";
import { systemPrompt, parseReply } from "../agent/brainCore";
import {
  TUPLE_SCHEMA_VERSION,
  isAgentCallable,
  type Tuple,
  type TupleCommand,
  type TurnSource,
} from "./tupleSchema";

export type ChatMessage = { role: string; content: string };
/** Injected model call: messages in → assistant content out. Mirrors the dev
 *  proxy / brain.ts request (system = production systemPrompt, then chat turns). */
export type CallBrain = (messages: ChatMessage[]) => Promise<string>;

export type GenOptions = {
  /** Turn source recorded on each tuple (default "brain_chat"). */
  source?: TurnSource;
  /** How many trailing chat messages to keep as context (default 8, like brain.ts). */
  historyWindow?: number;
  /** Deterministic turn-id factory (default `gen-<i>`). */
  turnIdFn?: (i: number) => string;
  /** Deterministic timestamp factory (default 1 + i, ms). */
  tsFn?: (i: number) => number;
  /** Start from a blank project (run `new_project` first) so the arc isn't built
   *  on top of the mock's seeded tracks. Off by default to keep the pure function
   *  predictable for unit tests; the CLI turns it on for a coherent from-empty arc. */
  cleanStart?: boolean;
  /** provenance.logPath stamped on each tuple. */
  logPath?: string;
  /** provenance.harvestedAt stamped on each tuple (default now). */
  harvestedAt?: string;
  /** Optional per-turn progress callback (for the CLI). */
  onTurn?: (info: { index: number; utterance: string; commands: number; valid: number; ok: number }) => void;
};

type LineOut = {
  ts: number;
  seq: number;
  command: string;
  args: Record<string, unknown>;
  ok: boolean;
  error?: string;
  undoable: boolean;
};

// Commands that are not undoable edits (transport/meta). Only affects log
// fidelity (the `undoable` flag); the harvester ignores it inside a tagged turn.
const NON_UNDOABLE = new Set(["set_transport", "save", "reload", "play", "stop", "undo", "redo"]);

/**
 * Core single pass: run each utterance through the (injected) brain against a
 * progressively-built mock session, returning both the mosh-log.jsonl text and
 * the harvested tuples. Mirrors runAgentBatch: commands are validated first; only
 * valid ones are executed + logged; a turn with no valid commands emits nothing
 * (no empty batch), so HUH/deferrals leave no trace — exactly like the live path.
 */
async function runArc(
  utterances: string[],
  callBrain: CallBrain,
  opts: GenOptions,
): Promise<{ logText: string; tuples: Tuple[] }> {
  const source: TurnSource = opts.source ?? "brain_chat";
  const window = opts.historyWindow ?? 8;
  const turnIdFn = opts.turnIdFn ?? ((i) => `gen-${i}`);
  const tsFn = opts.tsFn ?? ((i) => 1 + i);
  const logPath = opts.logPath ?? "generated:genTurns";
  const harvestedAt = opts.harvestedAt ?? new Date().toISOString();

  __resetMockForTests();

  const lines: LineOut[] = [];
  const tuples: Tuple[] = [];
  const history: ChatMessage[] = [];
  let seq = 0;

  if (opts.cleanStart) {
    // Blank the seeded session so a from-empty corpus doesn't duplicate the mock's
    // default tracks. Logged as a standalone (non-turn) line for replay fidelity.
    await mockExecute<CommandResult>({ command: "new_project", args: {} });
    lines.push({ ts: 0, seq: seq++, command: "new_project", args: {}, ok: true, undoable: false });
  }

  for (let i = 0; i < utterances.length; i++) {
    const utterance = utterances[i];
    const snapshotBefore = await mockSnapshot<Snapshot>();
    history.push({ role: "user", content: utterance });
    const messages: ChatMessage[] = [
      { role: "system", content: systemPrompt(snapshotBefore) },
      ...history.slice(-window),
    ];

    let content = "";
    try {
      content = await callBrain(messages);
    } catch {
      content = ""; // a failed call parses to HUH → no commands, no tuple
    }
    history.push({ role: "assistant", content });

    const reply = parseReply(content);
    const calls = reply.commands ?? [];
    const valid = calls.filter((c) => !validateCommand(c.command, c.args ?? {}));

    if (valid.length === 0) {
      opts.onTurn?.({ index: i, utterance, commands: calls.length, valid: 0, ok: 0 });
      continue;
    }

    const ts = tsFn(i);
    const seqBegin = seq;
    lines.push({
      ts,
      seq: seq++,
      command: "batch_begin",
      args: { name: "Moshi", turn_id: turnIdFn(i), utterance, source },
      ok: true,
      undoable: false,
    });

    const commands: TupleCommand[] = [];
    let appliedClean = true;
    for (const c of valid) {
      const args = c.args ?? {};
      const res = await mockExecute<CommandResult>({ command: c.command, args });
      const ok = res.ok !== false;
      lines.push({
        ts,
        seq: seq++,
        command: c.command,
        args,
        ok,
        error: ok ? undefined : res.error,
        undoable: !NON_UNDOABLE.has(c.command),
      });
      commands.push({
        command: c.command,
        args,
        ok,
        error: ok ? undefined : res.error,
        agentCallable: isAgentCallable(c.command),
      });
      if (!ok) appliedClean = false;
    }
    lines.push({ ts, seq: seq++, command: "batch_end", args: {}, ok: true, undoable: false });

    const snapshotAfter = await mockSnapshot<Snapshot>();
    const okCount = commands.filter((c) => c.ok).length;
    opts.onTurn?.({ index: i, utterance, commands: calls.length, valid: valid.length, ok: okCount });

    tuples.push({
      schemaVersion: TUPLE_SCHEMA_VERSION,
      kind: "imitation",
      turnId: turnIdFn(i),
      utterance,
      source,
      ts,
      seq: { begin: seqBegin, end: seq - 1 },
      snapshotBefore,
      snapshotAfter,
      commands,
      // All commands were pre-validated, so replayClean tracks live apply success.
      // Generated arcs are constructive; `undone`/`taste` come from human edits and
      // are absent here by construction.
      outcome: { appliedClean, replayClean: appliedClean, undone: false, taste: [] },
      provenance: { logPath, harvestedAt },
    });
  }

  return { logText: lines.map((l) => JSON.stringify(l)).join("\n") + (lines.length ? "\n" : ""), tuples };
}

/** Run the arc and return only the mosh-log.jsonl text (for writing a replayable
 *  log / feeding the live `harvest --watch` path). */
export async function generateLog(
  utterances: string[],
  callBrain: CallBrain,
  opts: GenOptions = {},
): Promise<string> {
  return (await runArc(utterances, callBrain, opts)).logText;
}

/** Run the arc and return both the log text and the harvested tuples. */
export async function generateTuples(
  utterances: string[],
  callBrain: CallBrain,
  opts: GenOptions = {},
): Promise<{ logText: string; tuples: Tuple[] }> {
  return runArc(utterances, callBrain, opts);
}
