import { describe, it, expect } from "vitest";
import { harvest, parseLog } from "./harvester";

// Build a synthetic mosh-log.jsonl exercising: turn grouping, an interleaved
// manual command, an undo that reverts a turn, a render+taste flow, and a legacy
// (pre-marker) batch with no turn_id.
function buildLog(): string {
  let seq = 0;
  let ts = 1000;
  const line = (
    command: string,
    args: Record<string, unknown>,
    ok = true,
    undoable = true,
  ) => JSON.stringify({ ts: ts++, seq: ++seq, command, args, ok, undoable });

  return (
    [
      // turn 1 — brain_chat, one create_track
      line("batch_begin", { name: "add a lead track", turn_id: "t1", utterance: "add a lead track", source: "brain_chat" }, true, false),
      line("create_track", { name: "Lead" }),
      line("batch_end", {}, true, false),
      // a manual (untagged) command between turns — its own undoable unit
      line("create_track", { name: "ByHand" }),
      // turn 2 — voice; reverted by the undo that follows
      line("batch_begin", { name: "make a synth", turn_id: "t2", utterance: "make a synth", source: "voice" }, true, false),
      line("create_track", { name: "Synth" }),
      line("batch_end", {}, true, false),
      line("undo", {}, true, false), // reverts turn 2 (most-recent unit), not the manual command
      // turn 3 — brain_chat; render flow on a clip that doesn't exist in the mock seed
      line("batch_begin", { name: "reimagine the loop", turn_id: "t3", utterance: "reimagine the loop", source: "brain_chat" }, true, false),
      line("create_render_layer", { clipId: "C1" }),
      line("render_layer", { clipId: "C1" }, true, false),
      line("batch_end", {}, true, false),
      // standalone taste label for C1
      line("accept_render", { clipId: "C1" }),
      // legacy batch — no turn_id → no tuple, but state still advances
      line("batch_begin", { name: "legacy" }, true, false),
      line("create_track", { name: "Legacy" }),
      line("batch_end", {}, true, false),
    ].join("\n") + "\n"
  );
}

describe("parseLog", () => {
  it("skips blank and malformed lines", () => {
    const text = `${JSON.stringify({ seq: 1, ts: 1, command: "save", args: {}, ok: true, undoable: false })}\n\nnot json\n`;
    const lines = parseLog(text);
    expect(lines).toHaveLength(1);
    expect(lines[0].command).toBe("save");
  });
});

describe("harvest", () => {
  it("emits one tuple per tagged agent turn, excluding manual + legacy commands", async () => {
    const tuples = await harvest(buildLog(), { logPath: "/tmp/x.jsonl" });
    expect(tuples.map((t) => t.turnId)).toEqual(["t1", "t2", "t3"]);
  });

  it("groups a turn's commands under its utterance + source with versioned shape", async () => {
    const [t1] = await harvest(buildLog(), { logPath: "/tmp/x.jsonl" });
    expect(t1.schemaVersion).toBe(1);
    expect(t1.kind).toBe("imitation");
    expect(t1.utterance).toBe("add a lead track");
    expect(t1.source).toBe("brain_chat");
    expect(t1.commands).toHaveLength(1);
    expect(t1.commands[0].command).toBe("create_track");
    expect(t1.commands[0].agentCallable).toBe(true);
    expect(t1.seq.begin).toBeLessThan(t1.seq.end);
    expect(t1.provenance.logPath).toBe("/tmp/x.jsonl");
  });

  it("reconstructs before/after snapshots via replay", async () => {
    const [t1] = await harvest(buildLog());
    expect(t1.snapshotAfter.tracks.length).toBe(t1.snapshotBefore.tracks.length + 1);
  });

  it("marks a turn reverted by a later undo as undone", async () => {
    const tuples = await harvest(buildLog());
    const t2 = tuples.find((t) => t.turnId === "t2")!;
    expect(t2.source).toBe("voice");
    expect(t2.outcome.undone).toBe(true);
  });

  it("separates appliedClean (live) from replayClean (mock divergence)", async () => {
    const tuples = await harvest(buildLog());
    const t3 = tuples.find((t) => t.turnId === "t3")!;
    expect(t3.outcome.appliedClean).toBe(true); // the log says every command succeeded live
    expect(t3.outcome.replayClean).toBe(false); // the mock can't find clip C1
    expect(t3.outcome.undone).toBe(false);
  });

  it("associates an accept_render taste label with the turn that rendered that clip", async () => {
    const tuples = await harvest(buildLog());
    const t3 = tuples.find((t) => t.turnId === "t3")!;
    expect(t3.outcome.taste).toHaveLength(1);
    expect(t3.outcome.taste[0]).toMatchObject({ kind: "accept_render", clipId: "C1" });
  });

  it("keeps an in-batch auto-accept taste label on the turn that performed it", async () => {
    // An agent that renders AND accepts within one batch: the accept_render lands
    // between the turn's batch_begin and batch_end. It must stay on THIS turn —
    // the reason taste association uses seqBegin (not seqEnd).
    let seq = 0;
    let ts = 2000;
    const line = (command: string, args: Record<string, unknown>, ok = true, undoable = true) =>
      JSON.stringify({ ts: ts++, seq: ++seq, command, args, ok, undoable });
    const log =
      [
        line("batch_begin", { turn_id: "ta", utterance: "render and keep", source: "brain_chat" }, true, false),
        line("create_render_layer", { clipId: "C9" }),
        line("render_layer", { clipId: "C9" }, true, false),
        line("accept_render", { clipId: "C9" }), // auto-accept, still inside the batch
        line("batch_end", {}, true, false),
      ].join("\n") + "\n";
    const [t] = await harvest(log);
    expect(t.turnId).toBe("ta");
    expect(t.outcome.taste).toHaveLength(1);
    expect(t.outcome.taste[0]).toMatchObject({ kind: "accept_render", clipId: "C9" });
  });

  it("drops an unclosed turn when a new tagged batch starts (malformed log) without merging", async () => {
    let seq = 0;
    let ts = 3000;
    const line = (command: string, args: Record<string, unknown>, ok = true, undoable = true) =>
      JSON.stringify({ ts: ts++, seq: ++seq, command, args, ok, undoable });
    const log =
      [
        line("batch_begin", { turn_id: "t1", utterance: "first", source: "brain_chat" }, true, false),
        line("create_track", { name: "A" }),
        // no batch_end — a second tagged batch starts (the engine can't actually emit this)
        line("batch_begin", { turn_id: "t2", utterance: "second", source: "brain_chat" }, true, false),
        line("create_track", { name: "B" }),
        line("batch_end", {}, true, false),
      ].join("\n") + "\n";
    const tuples = await harvest(log);
    expect(tuples.map((t) => t.turnId)).toEqual(["t2"]); // t1 dropped, not merged into t2
    expect(tuples[0].commands).toHaveLength(1); // only B's command — no leakage from t1
  });
});
