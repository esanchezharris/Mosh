import { describe, it, expect } from "vitest";
import { fairRecall, SHORT_PATTERN_NOTES, scoreExample, scoreReply } from "./metric";
import type { EvalExample } from "./evalset";
import type { CallBrain } from "../harvest/genTurns";

// A populate task whose gold is a LONG note run (like a real .mid slice: 32 notes),
// but whose utterance only asks for "a short pattern". The clip already exists in
// the setup prefix (the brain can't reference a clip it makes the same turn).
const POP_EXAMPLE: EvalExample = {
  id: "pop",
  utterance: 'write a short pattern into the clip on the "Keys" track',
  startCommands: [
    { command: "create_track", args: { name: "Keys", type: "instrument" }, bind: "t0" },
    { command: "add_midi_clip", args: { trackId: "$t0", start: 0, length: 4 }, bind: "c0" },
  ],
  goldCommandNames: Array(32).fill("add_note"),
};

// Build an {intent, commands} reply that writes `n` valid notes into the existing clip.
function notesReply(clipId: string, n: number): string {
  const commands = Array.from({ length: n }, (_, i) => ({
    command: "add_note",
    args: { clipId, pitch: 60 + (i % 12), start: i * 0.25, length: 0.25, velocity: 100 },
  }));
  return JSON.stringify({ intent: "ACK_GOT_IT", commands });
}

// An actor that reads the clip id out of the rendered snapshot and writes `n` notes.
function notesBrain(n: number): CallBrain {
  return async (messages) => {
    const sys = messages.find((m) => m.role === "system")?.content ?? "";
    const cid = sys.match(/"([^"]+)":(?:midi|wave)@/)?.[1] ?? "";
    return notesReply(cid, n);
  };
}

describe("fairRecall", () => {
  it("credits a short pattern's worth of notes against a long note gold", () => {
    const gold = Array(32).fill("add_note");
    // a full short pattern (floor) fully satisfies a 32-note gold
    expect(fairRecall(gold, Array(SHORT_PATTERN_NOTES).fill("add_note"))).toBe(1);
    // extra notes beyond the floor neither help nor hurt
    expect(fairRecall(gold, Array(SHORT_PATTERN_NOTES * 3).fill("add_note"))).toBe(1);
    // a thin pattern scales linearly against the floor, NOT against the 32-note source
    expect(fairRecall(gold, Array(3).fill("add_note"))).toBeCloseTo(3 / SHORT_PATTERN_NOTES);
  });

  it("grades deterministic single-op gold exactly as strict recall (unchanged)", () => {
    expect(fairRecall(["set_tempo"], ["set_tempo"])).toBe(1);
    expect(fairRecall(["set_tempo"], ["set_track_volume"])).toBe(0);
    expect(fairRecall(["set_tempo"], [])).toBe(0);
    expect(fairRecall([], ["anything"])).toBe(1); // empty gold → trivially covered
  });

  it("caps only the high-multiplicity name in a mixed gold (clip + its notes)", () => {
    const gold = ["add_midi_clip", ...Array(32).fill("add_note")];
    const got = ["add_midi_clip", ...Array(SHORT_PATTERN_NOTES).fill("add_note")];
    expect(fairRecall(gold, got)).toBe(1);
    // missing the clip op costs exactly its share (1 of the 1+floor required slots)
    const noClip = Array(SHORT_PATTERN_NOTES).fill("add_note");
    expect(fairRecall(gold, noClip)).toBeCloseTo(SHORT_PATTERN_NOTES / (SHORT_PATTERN_NOTES + 1));
  });
});

describe("scoreExample / scoreReply — fair note population", () => {
  it("gives a short, valid pattern full credit on a long-note gold (scoreExample)", async () => {
    expect(POP_EXAMPLE.goldCommandNames.length).toBeGreaterThan(SHORT_PATTERN_NOTES);
    const s = await scoreExample("Rules:", POP_EXAMPLE, notesBrain(SHORT_PATTERN_NOTES));
    expect(s.deferred).toBe(false);
    expect(s.score).toBe(1);
  });

  it("scores a thin 3-note reply at the fair fraction, not 3/32 (scoreReply)", async () => {
    // resolve the real clip id the offline reply must target
    const { buildExamplePrompt } = await import("./metric");
    const msgs = await buildExamplePrompt("Rules:", POP_EXAMPLE);
    const cid = msgs.find((m) => m.role === "system")!.content.match(/"([^"]+)":(?:midi|wave)@/)![1];
    const s = await scoreReply(POP_EXAMPLE, notesReply(cid, 3));
    expect(s.deferred).toBe(false);
    expect(s.score).toBeCloseTo(3 / SHORT_PATTERN_NOTES); // clean-apply 1.0 × fair recall 3/floor
  });

  it("still flags a real deferral as 0", async () => {
    const s = await scoreReply(POP_EXAMPLE, JSON.stringify({ intent: "HUH", say: "?" }));
    expect(s.deferred).toBe(true);
    expect(s.score).toBe(0);
  });
});
