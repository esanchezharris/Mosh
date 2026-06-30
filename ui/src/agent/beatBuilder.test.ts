import { describe, it, expect } from "vitest";
import {
  buildBeat,
  validateSlotNotes,
  extractJsonObject,
  type BeatSink,
  type BrainFn,
  type AgentCommandCall,
  type Slot,
  type BeatContext,
} from "./beatBuilder";
import { beatSpecById } from "./beatSpecs";

// A sink that records every issued command and hands back sequential engine ids for
// the create_track / add_midi_clip calls (mirrors the mock's id assignment).
class FakeSink implements BeatSink {
  calls: AgentCommandCall[] = [];
  private seq = 0;
  failOn?: string;
  async execute(call: AgentCommandCall) {
    this.calls.push(call);
    if (this.failOn && call.command === this.failOn) return { ok: false, error: "forced failure" };
    if (call.command === "create_track") return { ok: true, id: `t${++this.seq}` };
    if (call.command === "add_midi_clip") return { ok: true, id: `c${++this.seq}` };
    return { ok: true };
  }
  count(cmd: string) { return this.calls.filter((c) => c.command === cmd).length; }
  notesInto(clipId: string) { return this.calls.filter((c) => c.command === "add_note" && c.args?.clipId === clipId); }
}

// Brain helpers: branch on the system prompt (tempo step vs note step).
const TEN_NOTES = JSON.stringify({
  notes: Array.from({ length: 10 }, (_, i) => ({ pitch: 70, start: i * 0.5, length: 0.25, velocity: 100 })),
});
const goodBrain: BrainFn = async (messages) => {
  const sys = messages[0]?.content ?? "";
  if (sys.includes("Choose a tempo")) return '{"bpm":140}';
  return TEN_NOTES;
};
const emptyBrain: BrainFn = async () => "_chirp_ 🐹 i'm not sure what you mean!"; // no JSON → all fallback
const garbageBrain: BrainFn = async () => '{"notes":[]}'; // valid JSON, but empty → forcing kicks in

const spec = () => beatSpecById("dark_trap")!;

describe("extractJsonObject", () => {
  it("strips an emote/think preamble and returns the first balanced object", () => {
    expect(extractJsonObject('_chirp_ <think>hmm</think> {"bpm":140} trailing')).toBe('{"bpm":140}');
    expect(extractJsonObject('```json\n{"notes":[{"pitch":36}]}\n```')).toBe('{"notes":[{"pitch":36}]}');
  });
});

describe("validateSlotNotes", () => {
  const ctx: BeatContext = { spec: spec(), tempo: 140, beatsTotal: 8 };
  const kick: Slot = spec().tracks[0].slots[0];
  const bass: Slot = spec().tracks[1].slots[0];

  it("forces the GM pad pitch on drum slots regardless of the model's pitch", () => {
    const v = validateSlotNotes(kick, ctx, [
      { pitch: 99, start: 0, length: 0.25, velocity: 100 },
      { pitch: 12, start: 2, length: 0.25, velocity: 100 },
      { pitch: 50, start: 2.5, length: 0.25, velocity: 100 },
      { pitch: 0, start: 3, length: 0.25, velocity: 100 },
    ]);
    expect(v.reason).toBeUndefined();
    expect(v.notes.every((n) => n.pitch === 36)).toBe(true);
  });

  it("drops out-of-bounds starts and reports a precise reason when too few survive", () => {
    const v = validateSlotNotes(kick, ctx, [
      { pitch: 36, start: 0, length: 0.25, velocity: 100 },
      { pitch: 36, start: 99, length: 0.25, velocity: 100 }, // past the loop → dropped
      { pitch: 36, start: -1, length: 0.25, velocity: 100 }, // negative → dropped
    ]);
    expect(v.notes).toHaveLength(1);
    expect(v.reason).toMatch(/only 1 valid notes/);
  });

  it("clamps melodic pitch into the slot range", () => {
    const v = validateSlotNotes(bass, ctx, Array.from({ length: 4 }, (_, i) => ({ pitch: 127, start: i, length: 1, velocity: 100 })));
    expect(v.reason).toBeUndefined();
    expect(v.notes.every((n) => n.pitch <= bass.pitchRange[1] && n.pitch >= bass.pitchRange[0])).toBe(true);
  });

  it("rejects a non-object reply", () => {
    expect(validateSlotNotes(kick, ctx, null).reason).toMatch(/not the JSON/);
  });
});

describe("buildBeat", () => {
  it("a cooperative model fills every slot — no fallback, full structure, audible", async () => {
    const sink = new FakeSink();
    const r = await buildBeat(spec(), goodBrain, sink);
    expect(r.ok).toBe(true);
    expect(r.error).toBeUndefined();
    expect(r.tempoFromModel).toBe(true);
    expect(r.tempo).toBe(140);
    expect(r.modelNotePct).toBe(1);
    expect(r.steps.every((s) => !s.fallbackUsed && s.modelContributed)).toBe(true);
    // structure: 3 tracks, 3 clips, set_tempo + set_key
    expect(sink.count("create_track")).toBe(3);
    expect(sink.count("add_midi_clip")).toBe(3);
    expect(sink.count("set_tempo")).toBe(1);
    expect(sink.count("set_key")).toBe(1);
    // every slot wrote notes → non-silent
    expect(r.totalNotes).toBeGreaterThan(0);
    expect(sink.count("add_note")).toBe(r.totalNotes);
  });

  it("a deferring/empty model still yields a complete beat via the forced fallback", async () => {
    const sink = new FakeSink();
    const r = await buildBeat(spec(), emptyBrain, sink);
    expect(r.ok).toBe(true); // NEVER silent — the wall is closed by construction
    expect(r.modelNotePct).toBe(0);
    expect(r.steps.every((s) => s.fallbackUsed)).toBe(true);
    expect(r.tempoFromModel).toBe(false);
    expect(r.tempo).toBe(spec().tempo);
    expect(r.totalNotes).toBeGreaterThan(0);
    // fallback rejected each slot maxRetries+1 times → reasons recorded (honest audit)
    expect(r.steps[0].rejects.length).toBeGreaterThanOrEqual(1);
  });

  it("an empty-notes model triggers forcing the same way", async () => {
    const sink = new FakeSink();
    const r = await buildBeat(spec(), garbageBrain, sink);
    expect(r.ok).toBe(true);
    expect(r.steps.every((s) => s.fallbackUsed)).toBe(true);
  });

  it("recovers when the model fails the first attempt then succeeds", async () => {
    let n = 0;
    const flaky: BrainFn = async (messages) => {
      const sys = messages[0]?.content ?? "";
      if (sys.includes("Choose a tempo")) return '{"bpm":140}';
      n++;
      return n === 1 ? "no." : TEN_NOTES; // first note-slot reply is junk, rest fine
    };
    const sink = new FakeSink();
    const r = await buildBeat(spec(), flaky, sink, { maxRetries: 2 });
    expect(r.ok).toBe(true);
    const firstSlot = r.steps[0];
    expect(firstSlot.fallbackUsed).toBe(false);
    expect(firstSlot.modelContributed).toBe(true);
    expect(firstSlot.retries).toBe(1); // one re-prompt then success
  });

  it("reports a structural failure honestly when track creation fails", async () => {
    const sink = new FakeSink();
    sink.failOn = "create_track";
    const r = await buildBeat(spec(), goodBrain, sink);
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/create_track/);
  });
});
