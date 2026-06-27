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
});
