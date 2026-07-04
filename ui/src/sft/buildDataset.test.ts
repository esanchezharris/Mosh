import { describe, it, expect } from "vitest";
import { sliceProgramFull, renderExample, tupleToExample, splitBySource, toJsonl, type RenderedExample } from "./buildDataset";
import { parseReply } from "../agent/brainCore";
import { validateCommand } from "../agent/commands";
import type { ImportProgram } from "../import/emit";
import type { Tuple } from "../harvest/tupleSchema";

const PROGRAM: ImportProgram = {
  commands: [
    { command: "set_tempo", args: { bpm: 90 } },
    { command: "create_track", args: { name: "Drums", type: "drum" }, bind: "t0" },
    { command: "set_track_volume", args: { trackId: "$t0", db: -2 } },
    { command: "add_midi_clip", args: { trackId: "$t0", start: 0, length: 4 }, bind: "c0_0" },
    { command: "add_note", args: { clipId: "$c0_0", pitch: 36, start: 0, length: 1, velocity: 100 } },
    { command: "add_note", args: { clipId: "$c0_0", pitch: 38, start: 1, length: 1, velocity: 90 } },
  ],
  unmappable: [],
};

describe("sliceProgramFull", () => {
  it("emits full target slices (mixer, session, add-clip, note-population)", () => {
    const raws = sliceProgramFull(PROGRAM, "p");
    const byGold = (g: string) => raws.find((r) => r.goldCommandNames.join(",") === g);
    expect(byGold("set_tempo")).toBeTruthy();
    expect(byGold("set_track_volume")).toBeTruthy();
    expect(byGold("add_midi_clip")).toBeTruthy();

    // note-population: the add_midi_clip is in the SETUP, the target is the notes.
    const pop = raws.find((r) => r.goldCommandNames[0] === "add_note")!;
    expect(pop.goldCommandNames).toEqual(["add_note", "add_note"]); // FULL note run, not just one
    expect(pop.startCommands.some((c) => c.command === "add_midi_clip")).toBe(true);
    expect(pop.targetCommands.every((c) => c.command === "add_note")).toBe(true);
    // note args survive into the target (the thing the metric slicer dropped)
    expect(pop.targetCommands[0].args.pitch).toBe(36);
    expect(pop.targetCommands[1].args.pitch).toBe(38);
  });

  it("emits TRUE relative tempo/pan siblings (setup carries the absolute; gold = current ± fixed delta)", () => {
    const prog: ImportProgram = {
      commands: [
        { command: "set_tempo", args: { bpm: 90 } },
        { command: "create_track", args: { name: "Keys" }, bind: "t0" },
        { command: "set_track_pan", args: { trackId: "$t0", pan: 0.2 } },
      ],
      unmappable: [],
    };
    const raws = sliceProgramFull(prog, "p");
    // tempo: the absolute set_tempo slice + ONE relative task whose gold is 90 ± delta
    const tempoRel = raws.filter((r) => r.goldCommandNames.join(",") === "set_tempo"
      && r.startCommands.some((c) => c.command === "set_tempo"));
    expect(tempoRel).toHaveLength(1);
    const bpm = Number(tempoRel[0].targetCommands[0].args.bpm);
    expect(bpm).not.toBe(90); // a real delta, never the unlearnable current-value pairing
    expect([92, 95, 85, 100, 88]).toContain(bpm); // the fixed convention deltas off 90
    // pan: the relative sibling stays in [-1, 1] and moves off the current 0.2
    const panRel = raws.filter((r) => r.goldCommandNames.join(",") === "set_track_pan"
      && r.startCommands.some((c) => c.command === "set_track_pan"));
    expect(panRel).toHaveLength(1);
    const pan = Number(panRel[0].targetCommands[0].args.pan);
    expect(pan).not.toBe(0.2);
    expect(Math.abs(pan)).toBeLessThanOrEqual(1);
    expect([0.1, 0.35, 0.05, 0.45]).toContain(pan); // 0.2 ± the fixed convention deltas
  });

  it("skips a relative task whose target would leave the legal range (never teach a clamped delta)", () => {
    const prog: ImportProgram = {
      commands: [
        { command: "create_track", args: { name: "Keys" }, bind: "t0" },
        { command: "set_track_pan", args: { trackId: "$t0", pan: 0.9 } },
      ],
      unmappable: [],
    };
    // rotation at this point selects a positive delta that would exceed 1.0 → skipped
    const raws = sliceProgramFull(prog, "p");
    const panRel = raws.filter((r) => r.goldCommandNames.join(",") === "set_track_pan"
      && r.startCommands.some((c) => c.command === "set_track_pan"));
    for (const r of panRel) expect(Math.abs(Number(r.targetCommands[0].args.pan))).toBeLessThanOrEqual(1);
  });
});

describe("renderExample", () => {
  it("renders a clean chat triple whose assistant target round-trips parseReply + validateCommand", async () => {
    const pop = sliceProgramFull(PROGRAM, "p").find((r) => r.goldCommandNames[0] === "add_note")!;
    const ex = (await renderExample(pop))!;
    expect(ex).toBeTruthy();
    expect(ex.messages.map((m) => m.role)).toEqual(["system", "user", "assistant"]);
    const reply = parseReply(ex.messages[2].content);
    expect(reply.intent).toBe("ACK_GOT_IT");
    expect(reply.commands).toHaveLength(2);
    for (const c of reply.commands!) {
      expect(c.command).toBe("add_note");
      expect(validateCommand(c.command, c.args ?? {})).toBeNull(); // valid
      expect(typeof (c.args as { clipId: unknown }).clipId).toBe("string"); // concrete id, not a $ref
      expect(String((c.args as { clipId: string }).clipId).startsWith("$")).toBe(false);
    }
    // the concrete clipId the model must emit is visible in the rendered snapshot
    const sys = ex.messages[0].content;
    const clipId = (reply.commands![0].args as { clipId: string }).clipId;
    expect(sys).toContain(`"${clipId}"`);
  });

  it("renders a mixer task targeting the real track id", async () => {
    const vol = sliceProgramFull(PROGRAM, "p").find((r) => r.goldCommandNames[0] === "set_track_volume")!;
    const ex = (await renderExample(vol))!;
    const reply = parseReply(ex.messages[2].content);
    expect(reply.commands![0].command).toBe("set_track_volume");
    expect(validateCommand("set_track_volume", reply.commands![0].args ?? {})).toBeNull();
  });

  it("drops an example whose target cannot apply (bad ref)", async () => {
    const bad = sliceProgramFull(PROGRAM, "p")[0];
    bad.targetCommands = [{ command: "set_track_volume", args: { trackId: "$nope", db: 1 } }];
    expect(await renderExample(bad)).toBeNull();
  });
});

describe("tupleToExample", () => {
  const tuple: Tuple = {
    schemaVersion: 1,
    kind: "imitation",
    turnId: "t1",
    utterance: "add a drum track",
    source: "brain_chat",
    ts: 1,
    seq: { begin: 0, end: 2 },
    snapshotBefore: {
      schemaVersion: 1,
      session: { sampleRate: 48000, tempo: 120, timeSigNumerator: 4, timeSigDenominator: 4, metronome: false, key: { tonic: "C", mode: "major" }, length: 16, editFile: "" },
      tracks: [],
      transport: { playing: false, recording: false, position: 0, looping: false, loopStart: 0, loopEnd: 0 },
      master: { volumeDb: 0, pan: 0 },
    },
    snapshotAfter: {} as Tuple["snapshotAfter"],
    commands: [{ command: "create_track", args: { name: "Drums" }, ok: true, agentCallable: true }],
    outcome: { appliedClean: true, replayClean: true, undone: false, taste: [] },
    provenance: { logPath: "x", harvestedAt: "y" },
  };

  it("projects a clean tuple to a chat example", () => {
    const ex = tupleToExample(tuple, 0)!;
    expect(ex.sourceId).toBe("tuples");
    expect(parseReply(ex.messages[2].content).commands![0].command).toBe("create_track");
  });

  it("drops a dirty / undone / empty tuple", () => {
    expect(tupleToExample({ ...tuple, outcome: { ...tuple.outcome, undone: true } }, 0)).toBeNull();
    expect(tupleToExample({ ...tuple, outcome: { ...tuple.outcome, appliedClean: false } }, 0)).toBeNull();
    expect(tupleToExample({ ...tuple, commands: [] }, 0)).toBeNull();
  });
});

describe("splitBySource", () => {
  const mk = (sourceId: string, id: string): RenderedExample => ({ id, sourceId, messages: [], goldCommandNames: [] });
  it("is deterministic and never straddles a source across splits", () => {
    const examples = [
      ...["a", "b", "c", "d", "e"].flatMap((s) => [mk(s, `${s}1`), mk(s, `${s}2`), mk(s, `${s}3`)]),
    ];
    const a = splitBySource(examples, [60, 20, 20], 1);
    const b = splitBySource(examples, [60, 20, 20], 1);
    expect(a).toEqual(b); // deterministic
    // every source lands wholly in exactly one split
    const splitOf = new Map<string, string>();
    for (const [name, list] of [["train", a.train], ["valid", a.valid], ["test", a.test]] as const)
      for (const e of list) {
        if (splitOf.has(e.sourceId)) expect(splitOf.get(e.sourceId)).toBe(name);
        else splitOf.set(e.sourceId, name);
      }
    expect(a.train.length + a.valid.length + a.test.length).toBe(examples.length);
  });
});

describe("toJsonl", () => {
  it("emits one {messages:[...]} object per line", () => {
    const ex: RenderedExample = { id: "x", sourceId: "p", goldCommandNames: [], messages: [{ role: "user", content: "hi" }] };
    const lines = toJsonl([ex]).trim().split("\n");
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0])).toEqual({ messages: [{ role: "user", content: "hi" }] });
  });
});
