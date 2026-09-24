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
import { KEEPS_UNDO_HEAD, movesUndoHead } from "./undoHead";

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
    ]) expect(movesUndoHead(command), command).toBe(false);
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

function handlerBody(handler: string): string | null {
  const sig = moshOps.indexOf(`juce::var MoshOps::${handler} (`);
  if (sig < 0) return null;
  const next = moshOps.indexOf("\njuce::var MoshOps::", sig + 1);
  return moshOps.slice(sig, next < 0 ? undefined : next);
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
    });
  }
});
