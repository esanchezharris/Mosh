// Task-scoped batch lifecycle: ONE native undo transaction spans every step of
// an agent task. Driven against the REAL store+mock seam (the executor.test
// idiom) so batch bracketing, undo grouping and the destructive budget are
// proven on the same path the app ships.

import { describe, it, expect, beforeEach, vi } from "vitest";

// Step-1 slice 6 — the bridge's executeCommand is spied (wrapping the real mock
// path, never replacing it) so the ENVELOPE a loop batch sends can be inspected:
// the `origin` sibling must reach the seam beside command/args.
vi.mock("../../bridge", async () => {
  const actual = await vi.importActual<typeof import("../../bridge")>("../../bridge");
  return { ...actual, executeCommand: vi.fn(actual.executeCommand) };
});

import { executeCommand } from "../../bridge";
import { createTaskExecutor, pickResultIds } from "./taskExec";
import { DESTRUCTIVE_BLOCK_REASON } from "../destructiveScreen";
import { useStore } from "../../store";
import { __resetMockForTests } from "../../bridge.mock";
import type { Snapshot } from "../../types";

function snap(): Snapshot {
  const s = useStore.getState().snapshot;
  if (!s) throw new Error("store has no snapshot");
  return s;
}

describe("createTaskExecutor — one undo unit per agent task", () => {
  beforeEach(async () => {
    __resetMockForTests();
    await useStore.getState().refresh();
  });

  it("two steps coalesce into ONE undo step", async () => {
    const tracksBefore = snap().tracks.length;
    const t = createTaskExecutor("build a beat", { utterance: "build a beat" });

    const s1 = await t.env.runBatch("step 1", [{ command: "create_track", args: { name: "LoopTrack" } }]);
    expect(s1.results[0]!.ok).toBe(true);
    const newId = s1.snapshot.tracks.find((x) => x.name === "LoopTrack")!.id;
    const s2 = await t.env.runBatch("step 2", [{ command: "rename_track", args: { trackId: newId, name: "Renamed" } }]);
    expect(s2.results[0]!.ok).toBe(true);
    await t.close();

    expect(snap().tracks.some((x) => x.name === "Renamed")).toBe(true);
    const u = await useStore.getState().exec("undo");
    expect(u.ok).toBe(true);
    await useStore.getState().refresh();
    expect(snap().tracks.length).toBe(tracksBefore);          // create AND rename reverted
    expect(snap().tracks.some((x) => x.name === "Renamed")).toBe(false);
  });

  it("a purely read-only task never opens a batch", async () => {
    const t = createTaskExecutor("look around", {});
    const s = await t.env.runBatch("step 1", [{ command: "list_builtins", args: {} }]);
    expect(s.results[0]!.ok).toBe(true);
    expect(t.opened()).toBe(false);
    await t.close();
  });

  it("self-heals a zombie batch left open by a prior crash", async () => {
    const pre = await useStore.getState().exec("batch_begin", { name: "zombie" });
    expect(pre.ok).toBe(true); // the stale batch a JS crash would leave behind

    const t = createTaskExecutor("recover", {});
    const s = await t.env.runBatch("step 1", [{ command: "create_track", args: { name: "AfterHeal" } }]);
    expect(s.results[0]!.ok).toBe(true);
    expect(t.opened()).toBe(true);
    await t.close();
    expect(snap().tracks.some((x) => x.name === "AfterHeal")).toBe(true);
  });

  it("the destructive budget is TASK-cumulative, not per step", async () => {
    const t = createTaskExecutor("cleanup", {});
    const six = Array.from({ length: 6 }, (_, i) => ({ command: "remove_clip", args: { clipId: `x${i}` } }));
    const s1 = await t.env.runBatch("step 1", six);
    expect(s1.results).toHaveLength(6); // allowed (6 ≤ 10) — they fail on bogus ids, but they were permitted

    const five = Array.from({ length: 5 }, (_, i) => ({ command: "remove_clip", args: { clipId: `y${i}` } }));
    const s2 = await t.env.runBatch("step 2", [...five, { command: "create_track", args: { name: "Kept" } }]);
    const blocked = s2.results.filter((r) => r.error === DESTRUCTIVE_BLOCK_REASON);
    expect(blocked).toHaveLength(5);                        // 6 used + 5 > 10 ⇒ all five blocked
    expect(s2.results.find((r) => r.command === "create_track")!.ok).toBe(true);
    await t.close();
  });

  it("invalid commands fail validation without reaching the seam", async () => {
    const t = createTaskExecutor("mixed", {});
    const s = await t.env.runBatch("step 1", [
      { command: "create_track", args: { name: "Real" } },
      { command: "definitely_not_a_command", args: {} },
    ]);
    expect(s.results.find((r) => r.command === "create_track")!.ok).toBe(true);
    const bad = s.results.find((r) => r.command === "definitely_not_a_command")!;
    expect(bad.ok).toBe(false);
    expect(bad.error).toMatch(/not an allowed command/);
    await t.close();
  });

  it("rejects an out-of-key note when the task explicitly says to keep it in key", async () => {
    const track = await useStore.getState().exec("create_track", { name: "Melody" });
    const trackId = (track.data as { trackId: string }).trackId;
    const clip = await useStore.getState().exec("add_midi_clip", { trackId, start: 0, length: 4 });
    const clipId = (clip.data as { clipId: string }).clipId;
    await useStore.getState().refresh();

    const t = createTaskExecutor("melody", {
      utterance: "give the keys a melody and keep it in key",
    });
    const s = await t.env.runBatch("step 1", [
      { command: "add_note", args: { clipId, pitch: 11, start: 0, length: 0.5, velocity: 100 } },
      { command: "add_note", args: { clipId, pitch: 70, start: 0, length: 0.5, velocity: 100 } },
      { command: "add_note", args: { clipId, pitch: 69, start: 0.5, length: 0.5, velocity: 100 } },
    ]);

    expect(s.results[0]).toMatchObject({ command: "add_note", ok: false });
    expect(s.results[0]!.error).toContain("outside the practical melody register");
    expect(s.results[1]).toMatchObject({ command: "add_note", ok: false });
    expect(s.results[1]!.error).toContain("outside A minor");
    expect(s.results[2]).toMatchObject({ command: "add_note", ok: true });
    await t.close();
  });

  it("rejects an out-of-key note inside a native note batch", async () => {
    const track = await useStore.getState().exec("create_track", { name: "Keys" });
    const trackId = (track.data as { trackId: string }).trackId;
    const clip = await useStore.getState().exec("add_midi_clip", { trackId, start: 0, length: 4 });
    const clipId = (clip.data as { clipId: string }).clipId;
    await useStore.getState().exec("set_key", { tonic: "A", mode: "minor" });
    await useStore.getState().refresh();

    const t = createTaskExecutor("melody", {
      utterance: "give the keys a melody and keep it in key",
    });
    const s = await t.env.runBatch("step 1", [{
      command: "add_note",
      args: {
        clipId,
        notes: [
          { pitch: 69, start: 0, length: 0.5, velocity: 88 },
          { pitch: 70, start: 0.5, length: 0.5, velocity: 82 },
        ],
      },
    }]);

    expect(s.results[0]).toMatchObject({ command: "add_note", ok: false });
    expect(s.results[0]!.error).toContain("notes[1]");
    expect(s.results[0]!.error).toContain("outside A minor");
    await t.close();
  });

  it("close() is idempotent and the env refuses work after close", async () => {
    const t = createTaskExecutor("done", {});
    await t.env.runBatch("step 1", [{ command: "create_track", args: { name: "X" } }]);
    await t.close();
    await t.close(); // second close is a no-op, not an error
    await expect(t.env.runBatch("late", [{ command: "create_track", args: { name: "Y" } }])).rejects.toThrow(/closed/);
  });
});

describe("createTaskExecutor — guards from the 2026-09-23 real-app walkthrough (FINDINGS.md #4)", () => {
  // "build me a lofi sketch" (live, packaged app) planned add_drum_pattern onto the EXISTING
  // Drums track at bar 1 (overlapping the user's clip) and a create_track({name:"Keys",
  // type:"audio"}) that never got an add_midi_clip/add_note before the task ended. The first
  // and third tests below are true RED->GREEN reproductions of that defect (they FAIL without
  // the guards and PASS with them). The rest are non-regression guards proving the new checks
  // do not over-reach — they pass both before and after, since nothing removed/blocked
  // anything before the guards existed.
  beforeEach(async () => {
    __resetMockForTests();
    await useStore.getState().refresh();
  });

  it("refuses add_drum_pattern that would overlap an existing clip on the same track", async () => {
    const created = await useStore.getState().exec("create_track", { name: "Drums", type: "drum" });
    const trackId = (created.data as { trackId: string }).trackId;
    const original = await useStore.getState().exec("add_drum_pattern", {
      trackId, bars: 4, pattern: "kick: x...x...x...x...",
    });
    expect(original.ok).toBe(true);
    await useStore.getState().refresh();

    const t = createTaskExecutor("lofi sketch", { utterance: "build me a lofi sketch" });
    const s = await t.env.runBatch("step 1", [
      { command: "add_drum_pattern", args: { trackId, start: 0, bars: 2, pattern: "kick: x... .... x... ...." } },
    ]);
    expect(s.results[0]).toMatchObject({ command: "add_drum_pattern", ok: false });
    expect(s.results[0]!.error).toMatch(/overlap/i);
    await t.close();

    // no second clip was silently pushed onto the track
    expect(snap().tracks.find((x) => x.id === trackId)!.clips).toHaveLength(1);
  });

  it("still allows add_drum_pattern with clipId to replace lanes on the SAME existing clip in place", async () => {
    const created = await useStore.getState().exec("create_track", { name: "Drums", type: "drum" });
    const trackId = (created.data as { trackId: string }).trackId;
    const original = await useStore.getState().exec("add_drum_pattern", {
      trackId, bars: 4, pattern: "kick: x...x...x...x...",
    });
    const clipId = (original.data as { clipId: string }).clipId;
    await useStore.getState().refresh();

    const t = createTaskExecutor("dustier drums", { utterance: "make the drums dustier" });
    const s = await t.env.runBatch("step 1", [
      { command: "add_drum_pattern", args: { clipId, pattern: "hat: x.x.x.x.x.x.x.x." } },
    ]);
    expect(s.results[0]).toMatchObject({ command: "add_drum_pattern", ok: true });
    await t.close();
  });

  it("removes an empty melodic-instrument track this task created but never filled", async () => {
    // NOTE: the dev-mock seed already ships a DIFFERENT "Keys" track with its own clip
    // (bridge.mock.ts's defaultSeed) — assertions below are by trackId, not by name, so
    // this proves the repair removed the ONE this task made without touching the seed's.
    const t = createTaskExecutor("lofi sketch", { utterance: "build me a lofi sketch" });
    const s = await t.env.runBatch("step 1", [{ command: "create_track", args: { name: "Keys", type: "audio" } }]);
    expect(s.results[0]).toMatchObject({ command: "create_track", ok: true });
    const trackId = s.results[0]!.ids!.trackId as string;
    await t.close();

    expect(snap().tracks.some((x) => x.id === trackId)).toBe(false);
  });

  it("keeps an empty NON-melodic track this task created (e.g. a bare Vocal track)", async () => {
    const t = createTaskExecutor("add a vocal track", { utterance: "add a vocal track" });
    await t.env.runBatch("step 1", [{ command: "create_track", args: { name: "Vocal" } }]);
    await t.close();
    expect(snap().tracks.some((x) => x.name === "Vocal")).toBe(true);
  });

  it("keeps a melodic-instrument track this task created if it DID get a clip", async () => {
    const t = createTaskExecutor("add keys", { utterance: "add a keys part" });
    const s1 = await t.env.runBatch("step 1", [{ command: "create_track", args: { name: "Keys", type: "audio" } }]);
    const trackId = s1.results[0]!.ids!.trackId as string;
    const s2 = await t.env.runBatch("step 2", [{ command: "add_midi_clip", args: { trackId, start: 0, length: 4 } }]);
    expect(s2.results[0]!.ok).toBe(true);
    await t.close();
    expect(snap().tracks.some((x) => x.id === trackId)).toBe(true);
  });

  it("keeps an empty melodic-named track when the ask explicitly wants it empty/for later", async () => {
    const t = createTaskExecutor("add keys", { utterance: "add a blank keys track for me to play live" });
    const s = await t.env.runBatch("step 1", [{ command: "create_track", args: { name: "Keys", type: "audio" } }]);
    const trackId = s.results[0]!.ids!.trackId as string;
    await t.close();
    expect(snap().tracks.some((x) => x.id === trackId)).toBe(true);
  });

  it("generate_beat_recipe (the fast-path reroute's target) adds a NEW track and never touches an existing Drums track/clip", async () => {
    // Coordinator review point: the fast-path reroute to generate_beat_recipe is only safe if
    // the recipe command itself cannot clobber the user's existing material the way the
    // free-form plan did. bridge.mock.ts's case "generate_beat_recipe" always constructs a
    // brand-new track object and pushes it; it never looks up an existing track by name/id.
    const before = await useStore.getState().exec("create_track", { name: "Drums", type: "drum" });
    const drumsId = (before.data as { trackId: string }).trackId;
    const original = await useStore.getState().exec("add_drum_pattern", {
      trackId: drumsId, bars: 4, pattern: "kick: x...x...x...x...",
    });
    const originalClipId = (original.data as { clipId: string }).clipId;
    await useStore.getState().refresh();
    const drumsBefore = snap().tracks.find((x) => x.id === drumsId)!;
    const trackCountBefore = snap().tracks.length;

    const r = await useStore.getState().exec("generate_beat_recipe", { mood: "lofi" });
    expect(r.ok).toBe(true);
    await useStore.getState().refresh();

    // the user's Drums track and its clip are byte-identical
    const drumsAfter = snap().tracks.find((x) => x.id === drumsId)!;
    expect(drumsAfter.volumeDb).toBe(drumsBefore.volumeDb);
    expect(drumsAfter.clips).toHaveLength(1);
    expect(drumsAfter.clips[0]!.id).toBe(originalClipId);
    expect(drumsAfter.clips[0]!.notes).toEqual(drumsBefore.clips[0]!.notes);

    // exactly one NEW track was added
    expect(snap().tracks.length).toBe(trackCountBefore + 1);
  });
});

describe("createTaskExecutor — result ids reach the step results (step-1 slice 4)", () => {
  // Before this slice the step envelope was {command, ok, error} and `data` was
  // dropped, so a trackId/clipId/busNumber a command minted never reached the model
  // — it had to guess (or re-read the session) to chain the next call.
  beforeEach(async () => {
    __resetMockForTests();
    await useStore.getState().refresh();
  });

  it("keeps the ids a result payload carries (create_track → trackId, create_bus → busNumber+trackId) and nothing else", async () => {
    const t = createTaskExecutor("build", {});
    const s = await t.env.runBatch("step 1", [
      { command: "create_track", args: { name: "Vocal" } },
      { command: "create_bus", args: { name: "Reverb" } },
    ]);
    const vocal = s.snapshot.tracks.find((x) => x.name === "Vocal")!;
    expect(s.results[0]).toMatchObject({ command: "create_track", ok: true, ids: { trackId: vocal.id } });
    expect(Object.keys(s.results[0]!.ids!)).toEqual(["trackId"]);
    const reverb = s.snapshot.buses!.find((b) => b.name === "Reverb")!;
    // the mock's create_bus payload is {busNumber, trackId, name} — `name` is not an id
    expect(s.results[1]!.ids).toEqual({ busNumber: reverb.bus, trackId: reverb.trackId });
    await t.close();
  });

  it("a result whose payload carries no ids has NO ids field at all (and neither does a rejected call)", async () => {
    const t = createTaskExecutor("tempo", {});
    const s = await t.env.runBatch("step 1", [
      { command: "set_tempo", args: { bpm: 100 } },
      { command: "definitely_not_a_command", args: {} },
    ]);
    expect(s.results[0]).toMatchObject({ command: "set_tempo", ok: true });
    expect("ids" in s.results[0]!).toBe(false);
    expect(s.results[1]!.ok).toBe(false);
    expect("ids" in s.results[1]!).toBe(false);
    await t.close();
  });
});

describe("pickResultIds — the loop-safe subset of a result payload", () => {
  it("picks only the id keys, in a stable order, from an object payload", () => {
    expect(pickResultIds({ name: "x", clipId: "101", trackId: "17", nested: { trackId: "nope" } }))
      .toEqual({ trackId: "17", clipId: "101" });
    expect(Object.keys(pickResultIds({ clipId: "101", trackId: "17" })!)).toEqual(["trackId", "clipId"]);
  });

  it("returns undefined for a payload without ids, an array, a primitive, or nothing", () => {
    expect(pickResultIds(undefined)).toBeUndefined();
    expect(pickResultIds(true)).toBeUndefined();
    expect(pickResultIds([{ trackId: "17" }])).toBeUndefined();
    expect(pickResultIds({ name: "Kept", db: -3 })).toBeUndefined();
  });

  it("keeps numeric ids (busNumber 0, index 0, padId) and drops empty or non-finite values", () => {
    expect(pickResultIds({ busNumber: 0, index: 0, padId: 3, bus: 1 })).toEqual({ bus: 1, busNumber: 0, index: 0, padId: 3 });
    expect(pickResultIds({ trackId: "", clipId: null, padId: Number.NaN })).toBeUndefined();
  });
});

// Step-1 slice 6 — the loop's provenance reaches the ENVELOPE, not only batch_begin's
// args: every command of a task carries `origin` beside command/args so MoshOps can
// stamp it on each JSONL line (with the batch's turn_id). Default "agent_loop";
// meta.source wins when a caller names its lane.
describe("createTaskExecutor — origin on the envelope (step-1 slice 6)", () => {
  type Envelope = Record<string, unknown>;
  const envelopes = (): Envelope[] =>
    vi.mocked(executeCommand).mock.calls.map(([req]) => req as Envelope);

  beforeEach(async () => {
    __resetMockForTests();
    await useStore.getState().refresh();
    vi.mocked(executeCommand).mockClear();
  });

  it("every envelope of a loop batch carries origin agent_loop by default", async () => {
    const trackId = snap().tracks[0]!.id;
    const t = createTaskExecutor("lower it", { utterance: "lower the vocal 3 dB" });
    const s = await t.env.runBatch("step 1", [{ command: "set_track_volume", args: { trackId, db: -6 } }]);
    expect(s.results[0]!.ok).toBe(true);
    await t.close();
    const seen = envelopes();
    expect(seen.map((e) => e.command)).toEqual(["batch_begin", "set_track_volume", "batch_end"]);
    for (const e of seen) expect(e.origin).toBe("agent_loop");
    // batch_begin's own args still carry the marker fields the harvester reads.
    const beginArgs = seen[0]!.args as Record<string, unknown>;
    expect(beginArgs.source).toBe("agent_loop");
    expect(typeof beginArgs.turn_id).toBe("string");
  });

  it("meta.source names the lane and wins over the default", async () => {
    const trackId = snap().tracks[0]!.id;
    const t = createTaskExecutor("lower it", { source: "produce_driver" });
    await t.env.runBatch("step 1", [{ command: "set_track_volume", args: { trackId, db: -6 } }]);
    await t.close();
    const seen = envelopes();
    expect(seen.length).toBe(3);
    for (const e of seen) expect(e.origin).toBe("produce_driver");
  });

  it("execRaw (the produce preflight path) carries the origin too", async () => {
    const t = createTaskExecutor("produce", { source: "agent_loop" });
    const r = await t.execRaw("create_track", { name: "Preflight" });
    expect(r.ok).toBe(true);
    await t.close();
    const seen = envelopes();
    expect(seen.map((e) => e.command)).toEqual(["batch_begin", "create_track", "batch_end"]);
    for (const e of seen) expect(e.origin).toBe("agent_loop");
  });

  it("an injected deps.exec receives the origin as its third argument", async () => {
    const calls: Array<[string, Record<string, unknown> | undefined, string | undefined]> = [];
    const exec = async (command: string, args?: Record<string, unknown>, origin?: string) => {
      calls.push([command, args, origin]);
      return useStore.getState().exec(command, args, undefined, origin);
    };
    const trackId = snap().tracks[0]!.id;
    const t = createTaskExecutor("lower it", {}, { exec, refresh: () => useStore.getState().refresh() });
    await t.env.runBatch("step 1", [{ command: "set_track_volume", args: { trackId, db: -6 } }]);
    await t.close();
    expect(calls.map(([c]) => c)).toEqual(["batch_begin", "set_track_volume", "batch_end"]);
    for (const [, , origin] of calls) expect(origin).toBe("agent_loop");
  });
});
