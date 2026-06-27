import { describe, it, expect } from "vitest";
import { buildRlPromptSet, sourceId, shapeKey } from "./prompts";
import type { EvalExample } from "../gepa/evalset";

const ex = (id: string, gold: string[], utterance = "do it"): EvalExample => ({
  id, utterance, startCommands: [], goldCommandNames: gold,
});

describe("sourceId / shapeKey", () => {
  it("splits the source from the slice index", () => {
    expect(sourceId(ex("beat.als@42#7", []))).toBe("beat.als@42");
  });
  it("shapeKey is the sorted unique gold multiset", () => {
    expect(shapeKey(ex("x#0", ["add_note", "add_note", "add_midi_clip"]))).toBe("add_midi_clip+add_note");
    expect(shapeKey(ex("x#1", []))).toBe("(none)");
  });
});

describe("buildRlPromptSet", () => {
  it("drops every example sharing a source with the gate (no leakage)", () => {
    const gate = [ex("song.als@1#0", ["set_tempo"])];
    const pools = [ex("song.als@1#5", ["set_tempo"]), ex("other.als@2#0", ["set_tempo"])];
    const { examples, stats } = buildRlPromptSet(pools, gate, { perShapeCap: 100 });
    expect(examples.map((e) => e.id)).toEqual(["other.als@2#0"]);
    expect(stats.droppedLeakage).toBe(1);
    // the kept example must not share a source with any gate example
    const gateSrc = new Set(gate.map(sourceId));
    expect(examples.every((e) => !gateSrc.has(sourceId(e)))).toBe(true);
  });

  it("dedups by id", () => {
    const pools = [ex("a@1#0", ["set_tempo"]), ex("a@1#0", ["set_tempo"])];
    const { examples, stats } = buildRlPromptSet(pools, [], {});
    expect(examples.length).toBe(1);
    expect(stats.droppedDup).toBe(1);
  });

  it("caps each gold-command shape so add_note can't dominate", () => {
    const pools = [
      ...Array.from({ length: 50 }, (_, i) => ex(`np@1#${i}`, ["add_note"])),
      ...Array.from({ length: 3 }, (_, i) => ex(`mix@2#${i}`, ["set_track_volume"])),
    ];
    const { examples, stats } = buildRlPromptSet(pools, [], { perShapeCap: 5 });
    expect(stats.perShape["add_note"]).toBe(5); // capped
    expect(stats.perShape["set_track_volume"]).toBe(3); // under cap → all kept
    expect(examples.length).toBe(8);
  });

  it("is deterministic for a fixed seed and applies the overall cap", () => {
    const pools = Array.from({ length: 30 }, (_, i) => ex(`s@${i}#0`, ["set_tempo"]));
    const a = buildRlPromptSet(pools, [], { perShapeCap: 100, max: 10, seed: 7 });
    const b = buildRlPromptSet(pools, [], { perShapeCap: 100, max: 10, seed: 7 });
    expect(a.examples.map((e) => e.id)).toEqual(b.examples.map((e) => e.id));
    expect(a.examples.length).toBe(10);
  });
});
