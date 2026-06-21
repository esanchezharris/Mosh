import { describe, it, expect } from "vitest";
import { sliceProgram } from "./evalset";
import { nameRecall, scoreExample } from "./metric";
import { optimizeRules, sanitizeRules, buildReflectionPrompt } from "./optimize";
import type { ImportProgram } from "../import/emit";
import type { CallBrain } from "../harvest/genTurns";

const PROGRAM: ImportProgram = {
  commands: [
    { command: "set_tempo", args: { bpm: 90 } },
    { command: "create_track", args: { name: "Drums", type: "drum" }, bind: "t0" },
    { command: "set_track_volume", args: { trackId: "$t0", db: -2 } },
    { command: "add_midi_clip", args: { trackId: "$t0", start: 0, length: 4 }, bind: "c0_0" },
    { command: "add_note", args: { clipId: "$c0_0", pitch: 36, start: 0, length: 1, velocity: 100 } },
  ],
  unmappable: [],
};

const firstTrackId = (s: string) => s.match(/^\s{2}"([^"]+)"\s+"/m)?.[1] ?? null;
const firstClipId = (s: string) => s.match(/"([^"]+)":(?:midi|wave)@/)?.[1] ?? null;

// An "actor" brain that maps each templated utterance to the right command,
// grounding ids from the rendered snapshot. Optionally gated on a marker in the
// rules so the optimizer test can prove rule changes drive behavior.
function actorBrain(opts: { requireMarker?: string } = {}): CallBrain {
  return async (messages) => {
    const sys = messages.find((m) => m.role === "system")?.content ?? "";
    const u = [...messages].reverse().find((m) => m.role === "user")?.content ?? "";
    if (opts.requireMarker && !sys.includes(opts.requireMarker)) return JSON.stringify({ intent: "HUH" });
    const tid = firstTrackId(sys);
    const cid = firstClipId(sys);
    if (/turn the/.test(u)) return JSON.stringify({ commands: [{ command: "set_track_volume", args: { trackId: tid, db: 1 } }] });
    if (/tempo/.test(u)) return JSON.stringify({ commands: [{ command: "set_tempo", args: { bpm: Number(u.match(/\d+/)?.[0] ?? 120) } }] });
    if (/MIDI clip/.test(u)) return JSON.stringify({ commands: [{ command: "add_midi_clip", args: { trackId: tid, start: 0, length: 4 } }] });
    if (/pattern into the clip/.test(u)) return JSON.stringify({ commands: [{ command: "add_note", args: { clipId: cid, pitch: 36, start: 0, length: 1, velocity: 100 } }] });
    return JSON.stringify({ intent: "HUH" });
  };
}
const deferBrain: CallBrain = async () => JSON.stringify({ intent: "HUH", say: "?" });

describe("nameRecall", () => {
  it("is multiset recall of expected names", () => {
    expect(nameRecall(["add_note", "add_note"], ["add_note"])).toBe(0.5);
    expect(nameRecall(["set_tempo"], ["set_tempo", "set_tempo"])).toBe(1);
    expect(nameRecall(["x"], ["y"])).toBe(0);
  });
});

describe("sliceProgram", () => {
  it("cuts a program into gradeable tasks (mixer, session, add-clip, populate)", () => {
    const ex = sliceProgram(PROGRAM, "p");
    const golds = ex.map((e) => e.goldCommandNames.join(","));
    expect(golds).toContain("set_tempo");
    expect(golds).toContain("set_track_volume");
    expect(golds).toContain("add_midi_clip");
    expect(golds).toContain("add_note");
    // the populate task keeps the clip in the SETUP (brain can't ref a clip it makes this turn)
    const populate = ex.find((e) => e.goldCommandNames[0] === "add_note")!;
    expect(populate.startCommands.some((c) => c.command === "add_midi_clip")).toBe(true);
    expect(populate.utterance).toMatch(/Drums/);
  });
});

describe("scoreExample", () => {
  it("scores 1.0 when the brain emits the right, cleanly-applying command", async () => {
    const vol = sliceProgram(PROGRAM, "p").find((e) => e.goldCommandNames[0] === "set_track_volume")!;
    const s = await scoreExample("Rules:", vol, actorBrain());
    expect(s.deferred).toBe(false);
    expect(s.score).toBe(1);
  });

  it("scores 0 and flags a deferral when the brain emits no commands", async () => {
    const vol = sliceProgram(PROGRAM, "p").find((e) => e.goldCommandNames[0] === "set_track_volume")!;
    const s = await scoreExample("Rules:", vol, deferBrain);
    expect(s.deferred).toBe(true);
    expect(s.score).toBe(0);
    expect(s.feedback).toMatch(/DEFERRED/);
  });

  it("grades note population over an existing clip", async () => {
    const pop = sliceProgram(PROGRAM, "p").find((e) => e.goldCommandNames[0] === "add_note")!;
    expect((await scoreExample("Rules:", pop, actorBrain())).score).toBe(1);
  });
});

describe("optimizeRules", () => {
  it("selects rules that improve the verifier reward over the baseline", async () => {
    const examples = sliceProgram(PROGRAM, "p");
    const MARK = "ACT_NOW";
    // brain only acts when the rules contain the marker → baseline (no marker) defers.
    const brain = actorBrain({ requireMarker: MARK });
    const reflect = async () => `Rules:\n- ${MARK}: when the needed id is visible, act instead of deferring.`;
    const res = await optimizeRules({
      seedRules: "Rules:\n- be cautious",
      train: examples,
      val: examples,
      callBrain: brain,
      reflect,
      rounds: 1,
    });
    expect(res.baselineVal).toBe(0); // baseline defers everything
    expect(res.bestVal).toBeGreaterThan(res.baselineVal);
    expect(res.bestRules).toContain(MARK);
    expect(res.rounds[0].accepted).toBe(true);
  });

  it("keeps the baseline when reflection does not help", async () => {
    const examples = sliceProgram(PROGRAM, "p");
    const brain = actorBrain({ requireMarker: "NEVER_PRESENT" });
    const reflect = async () => "Rules:\n- still unhelpful";
    const res = await optimizeRules({ seedRules: "Rules:\n- seed", train: examples, val: examples, callBrain: brain, reflect, rounds: 2 });
    expect(res.bestRules).toBe("Rules:\n- seed");
    expect(res.rounds.every((r) => !r.accepted)).toBe(true);
  });
});

describe("sanitizeRules / buildReflectionPrompt", () => {
  it("strips fences and guarantees a Rules: block", () => {
    expect(sanitizeRules("```\nRules:\n- a\n```")).toBe("Rules:\n- a");
    expect(sanitizeRules("- a\n- b")).toBe("Rules:\n- a\n- b");
    expect(sanitizeRules("blah\nRules:\n- keep")).toBe("Rules:\n- keep");
  });
  it("embeds the current rules + feedback", () => {
    const p = buildReflectionPrompt("Rules:\n- x", "- DEFERRED on foo");
    expect(p).toContain("Rules:\n- x");
    expect(p).toContain("DEFERRED on foo");
    expect(p.toLowerCase()).toContain("only the new rules");
  });
});
