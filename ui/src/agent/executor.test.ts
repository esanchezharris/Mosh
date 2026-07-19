// Agent ⇄ seam contract test. Guards against the catalog (commands.ts) declaring
// argument names that don't match what the backend (MoshOps.cpp) and the dev mock
// (bridge.mock.ts) actually read — a class of bug where a voiced/typed agent
// command passes validation, dispatches, and then silently no-ops.
//
// These drive the REAL agent path (runAgentBatch → validateCommand → store.exec
// → executeCommand → mock) and assert the resulting snapshot state actually
// changed, so a future rename on either side breaks the build instead of going
// unnoticed.

import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  runAgentBatch, isDestructiveCommand, screenDestructive,
  MAX_DESTRUCTIVE_PER_BATCH, DESTRUCTIVE_BLOCK_REASON,
} from "./executor";
import type { AgentCommandCall } from "./executor";
import { validateCommand } from "./commands";
import { useStore } from "../store";
import { __resetMockForTests } from "../bridge.mock";
import type { Snapshot } from "../types";

function snap(): Snapshot {
  const s = useStore.getState().snapshot;
  if (!s) throw new Error("store has no snapshot");
  return s;
}

describe("agent command contract — catalog args must match the seam", () => {
  beforeEach(async () => {
    __resetMockForTests();
    await useStore.getState().refresh();
  });

  it("set_transport flips transport.playing through the agent path", async () => {
    expect(snap().transport.playing).toBe(false);

    const cs = await runAgentBatch("play", [
      { command: "set_transport", args: { action: "toggle" } },
    ]);

    expect(cs.applied).toBe(1);
    expect(cs.entries.every((e) => e.ok)).toBe(true);
    expect(snap().transport.playing).toBe(true);
  });

  it("split_clip creates a new clip at the split point through the agent path", async () => {
    // Set up a known clip on a fresh track (exec is the same seam runAgentBatch uses).
    const tr = await useStore.getState().exec("create_track", { name: "Split Test" });
    const trackId = (tr.data as { trackId: string }).trackId;
    const tone = await useStore.getState().exec("add_test_tone_clip", { trackId, seconds: 4 });
    const clipId = (tone.data as { clipId: string }).clipId;
    await useStore.getState().refresh();

    const before = snap().tracks.find((t) => t.id === trackId)!.clips;
    const original = before.find((c) => c.id === clipId)!;
    const splitAt = original.start + 1;

    const cs = await runAgentBatch("split", [
      { command: "split_clip", args: { clipId, time: splitAt } },
    ]);

    expect(cs.applied).toBe(1);
    const after = snap().tracks.find((t) => t.id === trackId)!.clips;
    expect(after.length).toBe(before.length + 1);
    expect(after.some((c) => Math.abs(c.start - splitAt) < 1e-6)).toBe(true);
  });

  it("emits batch_begin carrying turn_id + utterance + source (the Phase-0 turn marker)", async () => {
    const seen: { command: string; args: Record<string, unknown> }[] = [];
    const orig = useStore.getState().exec;
    const spy = vi
      .spyOn(useStore.getState(), "exec")
      .mockImplementation(async (command: string, args?: Record<string, unknown>) => {
        seen.push({ command, args: args ?? {} });
        return orig(command, args);
      });

    await runAgentBatch("add a lead", [{ command: "create_track", args: { name: "Lead" } }], {
      utterance: "add a lead track",
      source: "voice",
    });

    const begin = seen.find((c) => c.command === "batch_begin");
    expect(begin).toBeTruthy();
    expect(typeof begin!.args.turn_id).toBe("string");
    expect((begin!.args.turn_id as string).length).toBeGreaterThan(0);
    expect(begin!.args.utterance).toBe("add a lead track");
    expect(begin!.args.source).toBe("voice");
    expect(begin!.args.name).toBe("add a lead"); // still the undo-transaction label

    spy.mockRestore();
  });

  it("defaults the marker's utterance to the label and source to brain_chat", async () => {
    const seen: { command: string; args: Record<string, unknown> }[] = [];
    const orig = useStore.getState().exec;
    const spy = vi
      .spyOn(useStore.getState(), "exec")
      .mockImplementation(async (command: string, args?: Record<string, unknown>) => {
        seen.push({ command, args: args ?? {} });
        return orig(command, args);
      });

    await runAgentBatch("just a label", [{ command: "create_track", args: {} }]);

    const begin = seen.find((c) => c.command === "batch_begin")!;
    expect(begin.args.utterance).toBe("just a label");
    expect(begin.args.source).toBe("brain_chat");

    spy.mockRestore();
  });

  it("locks the catalog to the seam: renamed args validate, old names are rejected", () => {
    // The corrected names pass client-side validation…
    expect(validateCommand("set_transport", { action: "toggle" })).toBeNull();
    expect(validateCommand("split_clip", { clipId: "1", time: 1 })).toBeNull();
    // …and seam-mismatched calls are rejected — either a wrong type, or the renamed
    // positional now missing as a required arg. (set_transport is all-optional by
    // design — seek/loop calls carry no action — so its guard is the arg type.)
    expect(validateCommand("set_transport", { action: 5 })).not.toBeNull();                                    // action must be a string
    expect(validateCommand("split_clip", { clipId: "1", position: 1 })).not.toBeNull();                         // old "position" → missing required "time"
  });
});

describe("agent destructive-command scope limit (safety)", () => {
  beforeEach(async () => {
    __resetMockForTests();
    await useStore.getState().refresh();
  });

  it("isDestructiveCommand flags removes + the remove/delete/clear_ prefix, not constructive ops", () => {
    expect(isDestructiveCommand("remove_track")).toBe(true);
    expect(isDestructiveCommand("remove_note")).toBe(true);
    expect(isDestructiveCommand("delete_everything")).toBe(true);   // prefix catch-all (future-proof)
    expect(isDestructiveCommand("clear_track")).toBe(true);
    expect(isDestructiveCommand("create_track")).toBe(false);
    expect(isDestructiveCommand("set_transport")).toBe(false);
  });

  it("screenDestructive allows a batch at the limit", () => {
    const calls = Array.from({ length: MAX_DESTRUCTIVE_PER_BATCH }, () => ({ command: "remove_clip", args: { clipId: "x" } }));
    const { allowed, blocked } = screenDestructive(calls);
    expect(blocked).toHaveLength(0);
    expect(allowed).toHaveLength(MAX_DESTRUCTIVE_PER_BATCH);
  });

  it("screenDestructive blocks ALL destructive calls over the limit but keeps constructive ones", () => {
    const removes = Array.from({ length: MAX_DESTRUCTIVE_PER_BATCH + 1 }, () => ({ command: "remove_clip", args: { clipId: "x" } }));
    const { allowed, blocked } = screenDestructive([{ command: "create_track", args: {} }, ...removes]);
    expect(blocked).toHaveLength(MAX_DESTRUCTIVE_PER_BATCH + 1);
    expect(allowed).toEqual([{ command: "create_track", args: {} }]);
  });

  it("runAgentBatch blocks an over-limit delete spree before it reaches the seam, but applies constructive work", async () => {
    const removes = Array.from({ length: MAX_DESTRUCTIVE_PER_BATCH + 1 }, (_, i) => ({ command: "remove_clip", args: { clipId: `c${i}` } }));
    const cs = await runAgentBatch("wipe", [{ command: "create_track", args: { name: "Survivor" } }, ...removes]);

    const blocked = cs.entries.filter((e) => !e.ok && e.error === DESTRUCTIVE_BLOCK_REASON);
    expect(blocked).toHaveLength(MAX_DESTRUCTIVE_PER_BATCH + 1);   // every remove blocked
    expect(cs.applied).toBeGreaterThanOrEqual(1);                 // create_track still ran
  });

  it("keep_take is destructive — it discards every take lane but the kept one, and doesn't match the remove/delete/clear_ prefix", () => {
    // keep_take is the genuine gap: the DEFAULT prefix regex only catches remove_/
    // delete_/clear_, so this command needs an explicit entry in DESTRUCTIVE.
    expect(isDestructiveCommand("keep_take")).toBe(true);
  });

  it("delete_time_range consumes the FULL destructive budget — one per batch, alone", () => {
    // A single delete_time_range wipes a span across ALL tracks, so it is weighted
    // at the whole budget: one alone is fine, two (or one + any other destructive
    // call) blocks every destructive call in the batch.
    const one = screenDestructive([{ command: "delete_time_range", args: { start: 0, end: 8 } }]);
    expect(one.blocked).toHaveLength(0);
    expect(one.allowed).toHaveLength(1);

    const withRemove = screenDestructive([
      { command: "delete_time_range", args: { start: 0, end: 8 } },
      { command: "remove_clip", args: { clipId: "c1" } },
    ]);
    expect(withRemove.blocked).toHaveLength(2);
    expect(withRemove.allowed).toHaveLength(0);

    const two = screenDestructive([
      { command: "delete_time_range", args: { start: 0, end: 8 } },
      { command: "delete_time_range", args: { start: 8, end: 16 } },
    ]);
    expect(two.blocked).toHaveLength(2);
  });

  it("delete_time_range + constructive calls: only the range delete is budget-weighted, constructive still runs", () => {
    const { allowed, blocked } = screenDestructive([
      { command: "create_track", args: {} },
      { command: "delete_time_range", args: { start: 0, end: 8 } },
      { command: "remove_clip", args: { clipId: "c1" } },
    ]);
    expect(blocked.map((c) => c.command).sort()).toEqual(["delete_time_range", "remove_clip"]);
    expect(allowed).toEqual([{ command: "create_track", args: {} }]);
  });

  it("runAgentBatch: an over-limit MIXED-type destructive batch (remove_clip + keep_take) is fully blocked with the reason surfaced on every entry, while constructive commands still run and really mutate the session", async () => {
    // Real setup track, mutated only by the batch under test (proves execution, not just entry.ok).
    const setup = await useStore.getState().exec("create_track", { name: "Keep Me" });
    const trackId = (setup.data as { trackId: string }).trackId;
    await useStore.getState().refresh();

    const destructive: AgentCommandCall[] = [
      ...Array.from({ length: 6 }, (_, i) => ({ command: "remove_clip", args: { clipId: `c${i}` } })),
      ...Array.from({ length: 5 }, (_, i) => ({ command: "keep_take", args: { clipId: `k${i}` } })),
    ]; // 11 destructive calls, two different destructive commands, over the limit of 10
    const constructive: AgentCommandCall[] = [
      { command: "rename_track", args: { trackId, name: "Renamed Live" } },
      { command: "create_track", args: { name: "New Constructive Track" } },
    ];

    const cs = await runAgentBatch("mixed wipe", [...destructive, ...constructive]);

    // Every destructive call — BOTH kinds — is blocked, with the reason surfaced on each entry.
    const destructiveEntries = cs.entries.filter((e) => e.command === "remove_clip" || e.command === "keep_take");
    expect(destructiveEntries).toHaveLength(11);
    expect(destructiveEntries.every((e) => !e.ok)).toBe(true);
    expect(destructiveEntries.every((e) => e.error === DESTRUCTIVE_BLOCK_REASON)).toBe(true);

    // Constructive commands are returned as applied…
    const constructiveEntries = cs.entries.filter((e) => e.command === "rename_track" || e.command === "create_track");
    expect(constructiveEntries).toHaveLength(2);
    expect(constructiveEntries.every((e) => e.ok)).toBe(true);
    expect(cs.applied).toBe(2);
    expect(cs.entries).toHaveLength(13);

    // …and they really executed against the backend, not just a green entry.ok.
    const after = snap();
    expect(after.tracks.find((t) => t.id === trackId)?.name).toBe("Renamed Live");
    expect(after.tracks.some((t) => t.name === "New Constructive Track")).toBe(true);
  });
});
