// Integration tests for the agent batch-execution path (runAgentBatch), driving
// realistic MULTI-COMMAND producer flows against the mock backend end-to-end:
// validate → screenDestructive → dispatch each command through the real
// store.exec/executeCommand seam → confirm the resulting snapshot actually
// changed. These complement executor.test.ts's per-guard unit coverage (destructive
// scope limit, turn-marker plumbing) with scenarios shaped like what the brain
// actually emits in one turn — "build a beat", a runaway delete spree mixed with
// real constructive work, and a batch where one command fails partway through.
//
// Every command below is cross-checked against AGENT_COMMANDS (./commands.ts) —
// no invented commands, no invented args.

import { describe, it, expect, beforeEach, vi } from "vitest";
import { runAgentBatch, DESTRUCTIVE_BLOCK_REASON, MAX_DESTRUCTIVE_PER_BATCH } from "./executor";
import type { AgentCommandCall } from "./executor";
import { useStore } from "../store";
import { __resetMockForTests } from "../bridge.mock";
import type { Snapshot } from "../types";

function snap(): Snapshot {
  const s = useStore.getState().snapshot;
  if (!s) throw new Error("store has no snapshot");
  return s;
}

// The same trap-beat lane string proven elsewhere (bridge.mock.drumpattern.test.ts)
// to parse to exactly 14 notes / 16 steps / 1 bar — reused here so this file doesn't
// have to re-derive the parser's step math to make a real assertion about it.
const TRAP_PATTERN = "kick: x...x...x...x...; snare: ....x.......x...; hat: x.x.x.x.x.x.x.x.";

describe("agent executor — multi-command producer flows (integration)", () => {
  beforeEach(async () => {
    __resetMockForTests();
    await useStore.getState().refresh();
  });

  it("(a) a beat-build sequence — create_track + add_drum_pattern + set_track_volume — dispatches in order and every command really applies", async () => {
    const before = snap();
    const bassId = before.tracks.find((t) => t.name === "Bass")!.id;
    const priorDrumsIds = new Set(before.tracks.filter((t) => t.name === "Drums").map((t) => t.id));

    const seen: string[] = [];
    const orig = useStore.getState().exec;
    const spy = vi
      .spyOn(useStore.getState(), "exec")
      .mockImplementation(async (command: string, args?: Record<string, unknown>) => {
        seen.push(command);
        return orig(command, args);
      });

    const cs = await runAgentBatch("build the beat", [
      { command: "create_track", args: { name: "Hats" } },
      { command: "add_drum_pattern", args: { pattern: TRAP_PATTERN } },
      { command: "set_track_volume", args: { trackId: bassId, db: -9 } },
    ]);

    spy.mockRestore();

    // Dispatched in order, wrapped in exactly one batch transaction.
    expect(seen).toEqual(["batch_begin", "create_track", "add_drum_pattern", "set_track_volume", "batch_end"]);

    // The ChangeSet reports all three as applied, in call order.
    expect(cs.entries.map((e) => e.command)).toEqual(["create_track", "add_drum_pattern", "set_track_volume"]);
    expect(cs.entries.every((e) => e.ok)).toBe(true);
    expect(cs.applied).toBe(3);

    // Every command really mutated the backend — not just a green entry.ok.
    const after = snap();
    expect(after.tracks.length).toBe(before.tracks.length + 2); // "Hats" + a new "Drums" track
    expect(after.tracks.some((t) => t.name === "Hats")).toBe(true);

    const newDrumsTrack = after.tracks.find((t) => t.name === "Drums" && !priorDrumsIds.has(t.id));
    expect(newDrumsTrack).toBeTruthy();
    expect(newDrumsTrack!.type).toBe("drum");
    expect(newDrumsTrack!.isInstrument).toBe(true);
    const laidNotes = newDrumsTrack!.clips[0]?.notes ?? [];
    expect(laidNotes.length).toBe(14); // TRAP_PATTERN's proven note count

    expect(after.tracks.find((t) => t.id === bassId)?.volumeDb).toBe(-9);
  });

  it("(b) a batch mixing real constructive work with an over-limit delete spree blocks every destructive call while the constructive work fully applies and the real clips survive", async () => {
    // Real setup: an existing track carrying MAX_DESTRUCTIVE_PER_BATCH + 1 real clips —
    // each one genuinely removable, so "blocked" is a meaningful claim (unlike a spree of
    // clipIds that don't exist, where a would-be "not blocked" run would ALSO fail).
    const setupTrack = await useStore.getState().exec("create_track", { name: "Loop Chops" });
    const trackId = (setupTrack.data as { trackId: string }).trackId;
    const clipIds: string[] = [];
    for (let i = 0; i < MAX_DESTRUCTIVE_PER_BATCH + 1; i++) {
      const r = await useStore.getState().exec("add_test_tone_clip", { trackId, start: i * 2, seconds: 1 });
      clipIds.push((r.data as { clipId: string }).clipId);
    }
    await useStore.getState().refresh();
    const before = snap();
    expect(before.tracks.find((t) => t.id === trackId)!.clips.length).toBe(MAX_DESTRUCTIVE_PER_BATCH + 1);

    const spree: AgentCommandCall[] = clipIds.map((clipId) => ({ command: "remove_clip", args: { clipId } }));
    const producerWork: AgentCommandCall[] = [
      { command: "rename_track", args: { trackId, name: "Loop Chops (kept)" } },
      { command: "set_track_volume", args: { trackId, db: -4 } },
      { command: "create_track", args: { name: "New Layer" } },
    ];

    const cs = await runAgentBatch("clean up and add a layer", [...spree, ...producerWork]);

    // Every destructive call is blocked, with the reason surfaced on each entry.
    const removeEntries = cs.entries.filter((e) => e.command === "remove_clip");
    expect(removeEntries).toHaveLength(MAX_DESTRUCTIVE_PER_BATCH + 1);
    expect(removeEntries.every((e) => !e.ok && e.error === DESTRUCTIVE_BLOCK_REASON)).toBe(true);

    // The constructive work is reported applied…
    const workEntries = cs.entries.filter((e) => e.command !== "remove_clip");
    expect(workEntries).toHaveLength(3);
    expect(workEntries.every((e) => e.ok)).toBe(true);
    expect(cs.applied).toBe(3);

    // …and it — and only it — really happened against the backend.
    const after = snap();
    const survivingTrack = after.tracks.find((t) => t.id === trackId)!;
    expect(survivingTrack.name).toBe("Loop Chops (kept)");
    expect(survivingTrack.volumeDb).toBe(-4);
    // All 11 real clips survived the blocked spree — the guard actually protected data,
    // not just returned blocked entries.
    expect(survivingTrack.clips.length).toBe(MAX_DESTRUCTIVE_PER_BATCH + 1);
    expect(survivingTrack.clips.map((c) => c.id).sort()).toEqual([...clipIds].sort());
    expect(after.tracks.some((t) => t.name === "New Layer")).toBe(true);
  });

  it("(c) a mid-batch command failure is recorded on its own entry, does not stop or roll back the batch, and the surrounding commands still apply (the executor's real contract, not an assumed one)", async () => {
    const before = snap();

    const seen: string[] = [];
    const orig = useStore.getState().exec;
    const spy = vi
      .spyOn(useStore.getState(), "exec")
      .mockImplementation(async (command: string, args?: Record<string, unknown>) => {
        seen.push(command);
        return orig(command, args);
      });

    const cs = await runAgentBatch("beat build with a bad reference", [
      { command: "create_track", args: { name: "Lead" } },
      { command: "set_track_volume", args: { trackId: "does-not-exist", db: -6 } }, // real backend error, not a validation error
      { command: "set_tempo", args: { bpm: 140 } },
    ]);

    spy.mockRestore();

    // The executor does NOT stop at the failing command — it dispatches all three, then
    // still closes the batch normally (a per-command failure is not a boundary failure;
    // only batch_begin/batch_end failures throw AgentBatchBoundaryError — see
    // executor.batch-boundary.test.ts). No exception was thrown getting here.
    expect(seen).toEqual(["batch_begin", "create_track", "set_track_volume", "set_tempo", "batch_end"]);

    expect(cs.entries).toHaveLength(3);
    expect(cs.entries[0]).toMatchObject({ command: "create_track", ok: true });
    expect(cs.entries[1]).toMatchObject({ command: "set_track_volume", ok: false, error: "track not found" });
    expect(cs.entries[2]).toMatchObject({ command: "set_tempo", ok: true });
    expect(cs.applied).toBe(2); // the failing command is excluded from applied, the other two count

    // The commands either side of the failure really executed — the batch commits
    // whatever succeeded rather than rolling back on a single command's error.
    const after = snap();
    expect(after.tracks.length).toBe(before.tracks.length + 1);
    expect(after.tracks.some((t) => t.name === "Lead")).toBe(true);
    expect(after.session.tempo).toBe(140);
    expect(after.tracks.some((t) => t.id === "does-not-exist")).toBe(false);
  });
});
