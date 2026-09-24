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
      "save", "export_audio", "export_stems", "agent_memory_write", "agent_memory_delete",
      // Multiplayer: store/mp.ts claims the track on every track click.
      "mp_claim_track",
    ]) expect(movesUndoHead(command), command).toBe(false);
  });

  // Round-3 review, Q2: cmdMpCommitTrack content-addresses each wave clip into audio/by-hash and
  // repoints the clip there (repointWaveClipSource). SourceFileReference writes through the
  // Edit's own UndoManager, and Tracktion opens a new transaction 350 ms after a change — so the
  // first commit of a clip not yet by-hash puts a step on top of the receipt's batch, with no
  // beginTxn anywhere. The claim only stamps a logical id (null UndoManager).
  it("mp_commit_track moves the head (its by-hash repoint is an undo step); mp_claim_track does not", () => {
    expect(movesUndoHead("mp_commit_track")).toBe(true);
    expect(movesUndoHead("mp_commit_track", { recording: false })).toBe(true);
    expect(movesUndoHead("mp_claim_track")).toBe(false);
    expect(KEEPS_UNDO_HEAD.has("mp_commit_track")).toBe(false);
  });

  // Round-3 review, Q3: export_audio and export_stems detach the Edit with
  // transport.stop(false, false), which lands a take that is still recording — Tracktion's own
  // undo step, like the set_transport stop (U1). save_as does that too (saveProjectAs), and its
  // audio consolidation repoints clip sources even when nothing is recording, so it always counts.
  it("export_audio / export_stems move the head only while recording; save_as always does", () => {
    for (const command of ["export_audio", "export_stems"]) {
      expect(movesUndoHead(command), command).toBe(false);
      expect(movesUndoHead(command, { recording: false }), command).toBe(false);
      expect(movesUndoHead(command, { recording: true }), command).toBe(true);
      expect(LANDS_TAKE_WHILE_RECORDING.has(command), command).toBe(true);
    }
    expect(movesUndoHead("save_as")).toBe(true);
    expect(movesUndoHead("save_as", { recording: false })).toBe(true);
    expect(movesUndoHead("save_as", { recording: true })).toBe(true);
    expect(KEEPS_UNDO_HEAD.has("save_as")).toBe(false);
    // Plain save neither stops the transport nor repoints anything.
    expect(movesUndoHead("save", { recording: true })).toBe(false);
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
 *  first blind spot: stop_recording opens no transaction). Any `transport.stop (false, …)` lands
 *  a take that is still recording — the export renders' detach does it, and so does
 *  MoshEngine::saveProjectAs (round-3 review, Q3). */
function landsTake(handler: string, body: string): boolean {
  if (handler === "cmdStopRecording") return true;
  const afterSignature = body.slice(body.indexOf("\n"));
  return /\b(?:cmdStopRecording|loopFinalizeCapture|saveProjectAs)\s*\(/.test(afterSignature)
    || /(?:\bgetTransport\s*\(\s*\)|\btransport)\s*\.stop\s*\(\s*false\b/.test(afterSignature);
}

/** Handlers that rewrite a wave clip's source reference. SourceFileReference writes through the
 *  Edit's own UndoManager, and Tracktion opens a new transaction 350 ms after a change, so the
 *  rewrite is an undo step whether or not anything is recording (round-3 review, Q2: the
 *  mp_commit_track by-hash repoint; save_as's audio consolidation). */
function rewritesClipSource(body: string): boolean {
  const afterSignature = body.slice(body.indexOf("\n"));
  return /\b(?:repointWaveClipSource|setToDirectFileReference|getSourceFileReference|consolidateAudioInto|saveProjectAs)\s*\(/
    .test(afterSignature);
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
      // A handler that repoints a clip's source moves the head every time it runs.
      expect(
        rewritesClipSource(body!),
        `${command}: ${handler}() rewrites a clip's SourceFileReference through the Edit's ` +
          `UndoManager (an undo step with no beginTxn). Remove it from KEEPS_UNDO_HEAD.`,
      ).toBe(false);
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
    // Q3: the export renders' detach and Save As's saveProjectAs both stop a live take.
    expect(landsTake("cmdExportAudio", handlerBody("cmdExportAudio")!)).toBe(true);
    expect(landsTake("cmdExportStems", handlerBody("cmdExportStems")!)).toBe(true);
    expect(landsTake("cmdSaveAs", handlerBody("cmdSaveAs")!)).toBe(true);
    expect(landsTake("cmdSetMetronome", handlerBody("cmdSetMetronome")!)).toBe(false);
    expect(landsTake("cmdSave", handlerBody("cmdSave")!)).toBe(false);
  });

  it("the source-rewrite probe sees the real repoints (anti-vacuity)", () => {
    expect(rewritesClipSource(handlerBody("cmdMpCommitTrack")!)).toBe(true);
    expect(rewritesClipSource(handlerBody("cmdSaveAs")!)).toBe(true);
    expect(rewritesClipSource(handlerBody("cmdMpClaimTrack")!)).toBe(false);
    expect(rewritesClipSource(handlerBody("cmdSave")!)).toBe(false);
    expect(rewritesClipSource(handlerBody("cmdExportAudio")!)).toBe(false);
  });
});
