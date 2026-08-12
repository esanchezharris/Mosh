import { describe, it, expect } from "vitest";
import { harvest, harvestControllerEvents, harvestUnservedAsks, parseLog } from "./harvester";

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

  it("emits additive phone-controller event records with labels and snapshots", async () => {
    let seq = 0;
    let ts = 4000;
    const line = (command: string, args: Record<string, unknown>, ok = true, undoable = false) =>
      JSON.stringify({ ts: ts++, seq: ++seq, command, args, ok, undoable });
    const log =
      [
        line("set_transport", { source: "phone_controller", controllerEvent: "TRANSPORT_TOGGLE", issuedAtPhoneMs: 1, action: "toggle" }),
        line("keep_take", { source: "phone_controller", controllerEvent: "TAKE_KEEP", controllerLabel: "kept", clipId: "C1" }, true, true),
        line("undo", { source: "phone_controller", controllerEvent: "TAKE_REDO", controllerLabel: "undone" }),
        line("mark_take", { source: "phone_controller", controllerEvent: "TAKE_MARK", controllerLabel: "flagged", position: 2.5 }),
        line("set_transport", { source: "keyboard", controllerEvent: "TRANSPORT_TOGGLE", action: "toggle" }),
      ].join("\n") + "\n";

    const records = await harvestControllerEvents(log, { logPath: "/tmp/mosh-log.jsonl", harvestedAt: "now" });

    expect(records.map((r) => r.event)).toEqual(["TRANSPORT_TOGGLE", "TAKE_KEEP", "TAKE_REDO", "TAKE_MARK"]);
    expect(records.map((r) => r.label)).toEqual([undefined, "kept", "undone", "flagged"]);
    expect(records[0].kind).toBe("controller_event");
    expect(records[0].schemaVersion).toBe(1);
    expect(records[0].snapshotBefore.transport.playing).toBe(false);
    expect(records[0].snapshotAfter.transport.playing).toBe(true);
    expect(records[0].provenance.logPath).toBe("/tmp/mosh-log.jsonl");
  });
});

// ─── FS-B2a — turn provenance: no fabricated asks, unserved asks kept apart ───
describe("FS-B2a — the ask is honest and unserved asks are separated", () => {
  const seqLine = (() => {
    let seq = 0;
    let ts = 5000;
    return (command: string, args: Record<string, unknown>, ok = true, undoable = true) =>
      JSON.stringify({ ts: ts++, seq: ++seq, command, args, ok, undoable });
  })();

  // A marker with NO utterance key (the executor omits it when no transcript reached
  // it) alongside a `name` that WOULD be a tempting fallback — plus a served turn and
  // an unserved one.
  const log =
    [
      seqLine("batch_begin", { name: "mute the drums", turn_id: "n1", source: "voice" }, true, false),
      seqLine("create_track", { name: "NoUtterance" }),
      seqLine("batch_end", {}, true, false),
      seqLine("batch_begin", { name: "add a pad", turn_id: "n2", utterance: "add a warm pad", source: "brain_chat" }, true, false),
      seqLine("create_track", { name: "Pad" }),
      seqLine("batch_end", {}, true, false),
      seqLine("batch_begin", { name: "no idea what you mean", turn_id: "n3", utterance: "make it sound purple", source: "brain_chat" }, true, false),
      seqLine("batch_end", {}, true, false),
    ].join("\n") + "\n";

  it("never substitutes the transaction label for a missing utterance", async () => {
    const tuples = await harvest(log);
    const t = tuples.find((x) => x.turnId === "n1")!;
    expect(t).toBeTruthy();
    expect(t.utterance).toBe(""); // empty, NOT "mute the drums" (Moshi's own label)
  });

  it("keeps a zero-command turn out of the imitation corpus", async () => {
    const tuples = await harvest(log);
    expect(tuples.map((t) => t.turnId)).toEqual(["n1", "n2"]); // n3 ran nothing
    expect(tuples.every((t) => t.commands.length > 0)).toBe(true);
  });

  it("surfaces the zero-command turn as an unserved ask instead", () => {
    const asks = harvestUnservedAsks(log);
    expect(asks).toHaveLength(1);
    expect(asks[0]).toMatchObject({ turnId: "n3", utterance: "make it sound purple", source: "brain_chat" });
  });

  it("preserves studio-skill provenance for unsupported asks", () => {
    const skillLog = [
      seqLine("batch_begin", { turn_id: "skill", utterance: "load Serum 2", source: "studio_skill" }, true, false),
      seqLine("load_plugin", { trackId: "t1", pluginId: "serum-2" }, true, true),
      seqLine("batch_end", {}, true, false),
      seqLine("batch_begin", { turn_id: "blocked", utterance: "load Omnisphere", source: "studio_skill_blocked" }, true, false),
      seqLine("batch_end", {}, true, false),
      seqLine("batch_begin", { turn_id: "missing", utterance: "master this", source: "studio_skill_unsupported" }, true, false),
      seqLine("batch_end", {}, true, false),
    ].join("\n");

    expect(harvestUnservedAsks(skillLog)).toEqual([
      expect.objectContaining({ turnId: "blocked", source: "studio_skill_blocked" }),
      expect.objectContaining({ turnId: "missing", source: "studio_skill_unsupported" }),
    ]);
  });

  it("preserves section and developer-loop provenance", async () => {
    const routedLog = [
      seqLine("batch_begin", { turn_id: "section", utterance: "make the chorus louder", source: "section_scope" }, true, false),
      seqLine("set_track_volume", { trackId: "t1", volumeDb: 2 }, true, true),
      seqLine("batch_end", {}, true, false),
      seqLine("batch_begin", { turn_id: "loop", utterance: "build a lofi beat", source: "agent_loop" }, true, false),
      seqLine("batch_end", {}, true, false),
    ].join("\n");

    const tuples = await harvest(routedLog);
    expect(tuples).toEqual([
      expect.objectContaining({ turnId: "section", source: "section_scope" }),
    ]);
    expect(harvestUnservedAsks(routedLog)).toEqual([
      expect.objectContaining({ turnId: "loop", source: "agent_loop" }),
    ]);
  });

  it("does not report a served turn, or an unserved one with no recorded ask, as unserved", () => {
    const noAsk =
      [
        seqLine("batch_begin", { name: "label only", turn_id: "n4", source: "voice" }, true, false),
        seqLine("batch_end", {}, true, false),
      ].join("\n") + "\n";
    expect(harvestUnservedAsks(noAsk)).toEqual([]);
    expect(harvestUnservedAsks(buildLog())).toEqual([]);
  });
});
