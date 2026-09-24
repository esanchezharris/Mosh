// D2 (demo readiness round 2) — which successful commands move the undo head, so a Moshi
// receipt whose Undo is a plain `undo` retires the moment it would revert something else.
//
// The list of commands that DON'T move the head is a claim about MoshOps, and a written claim
// ages. So, like txnSafeRegistry.test.ts, the second half re-derives it from the C++: every
// entry that dispatches natively must have a handler that opens no undo transaction.

import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  HISTORY_MOVES, KEEPS_UNDO_HEAD, LANDS_TAKE_WHILE_RECORDING, movesUndoHead, noteUndoHeadMove, undoHeadMark,
} from "./undoHead";

describe("movesUndoHead", () => {
  it("edits and history moves retire a receipt", () => {
    for (const command of [
      "add_drum_pattern", "add_midi_clip", "set_track_volume", "set_track_pan", "set_tempo",
      "load_preset", "load_plugin", "set_plugin_param", "move_clip", "remove_clip", "create_track",
      "undo", "redo", "jump_to_history",
      // MoshOps opens an undo step for these although TransactionSafe.h files some as NonUndoable.
      "set_track_output", "enable_track_meter", "enable_all_meters", "batch_begin",
    ]) expect(movesUndoHead(command), command).toBe(true);
  });

  it("an unknown command counts as an edit (a stale Undo costs more than a receipt hidden early)", () => {
    expect(movesUndoHead("some_future_edit")).toBe(true);
  });

  it("reads, transport, preferences, persistence and agent-memory writes do not", () => {
    for (const command of [
      "get_command_log", "get_clip_peaks", "list_presets", "list_audio_devices", "batch_status", "loop_state",
      "set_transport", "set_metronome", "set_count_in", "set_input_monitor", "arm_track",
      "save", "export_audio", "agent_memory_write", "agent_memory_delete",
      // Multiplayer: store/mp.ts sends these on every track click and every 20 s in a session.
      "mp_commit_track", "mp_claim_track",
    ]) expect(movesUndoHead(command), command).toBe(false);
  });

  // Round-2 review, finding 1: V3 ends every recording with set_transport (TopBar Record →
  // Record, Play/Pause, Stop). While a take is recording, MoshOps finalizes it first
  // (cmdSetTransport → cmdStopRecording), and Tracktion lands the clip through the Edit's own
  // UndoManager — a new undo step. So set_transport keeps the head only when NOT recording.
  it("set_transport moves the head only when it stops a recording (the take lands as an undo step)", () => {
    expect(movesUndoHead("set_transport")).toBe(false);
    expect(movesUndoHead("set_transport", { recording: false })).toBe(false);
    expect(movesUndoHead("set_transport", { recording: true })).toBe(true);
    // stop_recording is unlisted, so it always counts; the other preferences don't care.
    expect(movesUndoHead("stop_recording")).toBe(true);
    expect(movesUndoHead("stop_recording", { recording: false })).toBe(true);
    for (const command of ["set_metronome", "arm_track", "set_input_monitor", "get_snapshot"])
      expect(movesUndoHead(command, { recording: true }), command).toBe(false);
  });

  it("HISTORY_MOVES is the one list store.ts uses for historyEpoch (no second copy to drift)", () => {
    expect([...HISTORY_MOVES].sort()).toEqual(["jump_to_history", "redo", "undo"]);
    const store = readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), "../store.ts"), "utf8");
    expect(store).toMatch(/import \{[^}]*\bHISTORY_MOVES\b[^}]*\} from "\.\/agent\/undoHead"/);
    expect(store).not.toMatch(/const HISTORY_MOVES\b/);
  });
});

// Round-2 review, finding 4: a receipt's change set is stamped with this mark right after its
// batch_end; setAgentChangeSet refuses it if anything moved the head in between.
describe("undo-head mark", () => {
  it("advances once per noted move and never otherwise", () => {
    const before = undoHeadMark();
    expect(undoHeadMark()).toBe(before);
    noteUndoHeadMove();
    expect(undoHeadMark()).toBe(before + 1);
    noteUndoHeadMove();
    expect(undoHeadMark()).toBe(before + 2);
  });
});

// ── drift guard against MoshOps ─────────────────────────────────────────────────────────

const here = dirname(fileURLToPath(import.meta.url)); // ui/src/agent
const moshOpsDir = resolve(here, "../../../src/moshops");
const moshOps = readdirSync(moshOpsDir)
  .filter((f) => f.startsWith("MoshOps") && f.endsWith(".cpp"))
  .sort()
  .map((f) => readFileSync(resolve(moshOpsDir, f), "utf8"))
  .join("\n");

const dispatch = new Map<string, string>();
for (const m of moshOps.matchAll(
  /if \(name == "([a-z0-9_]+)"\)\s*return [^;]*?(cmd[A-Za-z0-9]+)\s*\(args\)/g,
))
  dispatch.set(m[1], m[2]);

/** Handlers that land a recorded take. Tracktion adds the landed clip through the Edit's own
 *  UndoManager, so the landing is an undo step even with no beginTxn in sight (the drift guard's
 *  first blind spot: stop_recording opens no transaction). */
function landsTake(handler: string, body: string): boolean {
  if (handler === "cmdStopRecording") return true;
  const afterSignature = body.slice(body.indexOf("\n"));
  return /\b(?:cmdStopRecording|loopFinalizeCapture)\s*\(/.test(afterSignature);
}

/** The handler's own definition: its signature through the brace that closes it. (Slicing to
 *  the next `juce::var MoshOps::` ran on into whatever helpers followed — for the last handler
 *  in a file, into the NEXT file: cmdAllNotesOff swallowed MoshOps.Loop.cpp's loop helpers.)
 *  Comments and string/char literals are skipped so a brace inside one cannot end it early. */
function handlerBody(handler: string): string | null {
  const sig = moshOps.indexOf(`juce::var MoshOps::${handler} (`);
  if (sig < 0) return null;
  const open = moshOps.indexOf("{", sig);
  let depth = 0;
  for (let i = open; i < moshOps.length; i++) {
    const c = moshOps[i];
    if (c === "/" && moshOps[i + 1] === "/") { i = moshOps.indexOf("\n", i); if (i < 0) break; continue; }
    if (c === "/" && moshOps[i + 1] === "*") { i = moshOps.indexOf("*/", i + 2) + 1; continue; }
    if (c === '"' || c === "'") {
      for (i++; i < moshOps.length && moshOps[i] !== c; i++) if (moshOps[i] === "\\") i++;
      continue;
    }
    if (c === "{") depth++;
    else if (c === "}" && --depth === 0) return moshOps.slice(sig, i + 1);
  }
  return null;
}

describe("KEEPS_UNDO_HEAD ⇄ MoshOps", () => {
  const checked = [...KEEPS_UNDO_HEAD].filter((c) => dispatch.has(c));

  it("parsed a real dispatch table and checks most of the list (guards against an empty probe)", () => {
    expect(dispatch.size).toBeGreaterThanOrEqual(190);
    expect(checked.length).toBeGreaterThanOrEqual(25);
  });

  for (const command of KEEPS_UNDO_HEAD) {
    it(`${command}: opens no undo transaction`, () => {
      const handler = dispatch.get(command);
      if (!handler) return;   // not a MoshOps command (a mock-only or bridge read); nothing to derive
      const body = handlerBody(handler);
      expect(body, `${handler}() not found`).toBeTruthy();
      const opener = body!.match(/\bbeginTxn \(|\bbeginUndoTransaction \(|beginNewTransaction \(/);
      expect(
        opener,
        `${command}: ${handler}() calls ${opener?.[0]} — it moves the undo head, so a Moshi receipt ` +
          `left up after it would undo THIS edit. Remove it from KEEPS_UNDO_HEAD.`,
      ).toBeNull();
      // A handler that can land a recorded take moves the head while recording, so it may stay
      // listed only if movesUndoHead knows that (LANDS_TAKE_WHILE_RECORDING).
      if (landsTake(handler, body!))
        expect(
          LANDS_TAKE_WHILE_RECORDING.has(command),
          `${command}: ${handler}() lands a recorded take (an undo step) — list it in ` +
            `LANDS_TAKE_WHILE_RECORDING or remove it from KEEPS_UNDO_HEAD.`,
        ).toBe(true);
    });
  }

  it("every LANDS_TAKE_WHILE_RECORDING entry is listed and really lands a take (no stale exception)", () => {
    expect(LANDS_TAKE_WHILE_RECORDING.size).toBeGreaterThan(0);
    for (const command of LANDS_TAKE_WHILE_RECORDING) {
      expect(KEEPS_UNDO_HEAD.has(command), command).toBe(true);
      const handler = dispatch.get(command);
      expect(handler, `${command} dispatches natively`).toBeTruthy();
      expect(landsTake(handler!, handlerBody(handler!)!), `${command}: ${handler}() lands a take`).toBe(true);
    }
  });

  it("a handler body is exactly that handler — whole, and nothing after it (anti-vacuity)", () => {
    const transport = handlerBody("cmdSetTransport")!;
    expect(transport.startsWith("juce::var MoshOps::cmdSetTransport (")).toBe(true);
    expect(transport.trimEnd().endsWith("}")).toBe(true);
    expect(transport).toContain('return okResult ("set_transport", transportToVar());');   // its last line
    expect(transport).not.toContain("juce::var MoshOps::cmdSetTempo (");                  // the next handler
    expect(handlerBody("cmdSetTempo")).toMatch(/\bbeginTxn \(/);                          // an edit is still seen
    expect(handlerBody("cmdAllNotesOff")).not.toContain("loopFinalizeCapture");           // no run-on into Loop.cpp
  });

  it("the take-landing probe sees the real landing paths (anti-vacuity)", () => {
    expect(landsTake("cmdSetTransport", handlerBody("cmdSetTransport")!)).toBe(true);
    expect(landsTake("cmdLoopStop", handlerBody("cmdLoopStop")!)).toBe(true);
    expect(landsTake("cmdSetMetronome", handlerBody("cmdSetMetronome")!)).toBe(false);
  });
});
