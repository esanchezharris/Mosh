import { describe, it, expect } from "vitest";
import { resolvePref, applyHumanPref, mertSeedRow, type BlindManifest } from "./qualitySeed";
import type { TechniqueCard } from "./card";

const card = (): TechniqueCard => ({
  id: "card_x", source: "youtube", skill_name: "Boom-bap pattern", task_type: "drum_programming",
  genre_context: ["boom-bap"], producer_intent: "the skeleton", when: "programming boom-bap",
  recipe: { kind: "recipe", commands: [{ command: "add_note", args: { clipId: "$drumClipId", pitch: 36, start: 0 } }] },
  evidence: [{ brief: "lofi-85-Am", metric: "technique_conformance", withScore: 1, withoutScore: 0, delta: 1 }],
  confidence: 0.75, status: "conformant",
});
const man = (slot: "A" | "B"): BlindManifest => ({ cardId: "card_x", brief: "lofi-85-Am", a: "/q/A.wav", b: "/q/B.wav", techniqueSlot: slot });

// The owner listens to A vs B BLIND (which slot is the with-technique render is hidden);
// resolvePref maps their pick back to whether the technique was preferred.
describe("resolvePref — a blind A/B pick → technique/baseline/equal", () => {
  it("technique when the pick is the technique slot", () => {
    expect(resolvePref(man("A"), "A")).toBe("technique");
    expect(resolvePref(man("B"), "B")).toBe("technique");
  });
  it("baseline when the pick is the other slot", () => {
    expect(resolvePref(man("A"), "B")).toBe("baseline");
    expect(resolvePref(man("B"), "A")).toBe("baseline");
  });
  it("equal passes through", () => {
    expect(resolvePref(man("A"), "equal")).toBe("equal");
  });
});

// A human ear label records a human_pref evidence row and (only on a technique win) bumps
// the card to "preferred" — the schema's existing path. These labels seed the MERT-probe.
describe("applyHumanPref — ear label updates the card", () => {
  it("bumps conformant → preferred + records human_pref=1 when the technique wins", () => {
    const c = applyHumanPref(card(), "lofi-85-Am", "technique");
    expect(c.status).toBe("preferred");
    const ev = c.evidence.find((e) => e.metric === "human_pref");
    expect(ev?.withScore).toBe(1);
    expect(ev?.brief).toBe("lofi-85-Am");
  });
  it("keeps conformant + records human_pref=0 when baseline wins", () => {
    const c = applyHumanPref(card(), "lofi-85-Am", "baseline");
    expect(c.status).toBe("conformant");
    expect(c.evidence.find((e) => e.metric === "human_pref")?.withScore).toBe(0);
  });
  it("keeps the conformance evidence intact (only adds the human_pref row)", () => {
    const c = applyHumanPref(card(), "lofi-85-Am", "technique");
    expect(c.evidence.some((e) => e.metric === "technique_conformance")).toBe(true);
    expect(c.evidence.filter((e) => e.metric === "human_pref")).toHaveLength(1);
  });
  it("re-labeling the same brief overwrites (latest wins) + recomputes status", () => {
    const once = applyHumanPref(card(), "b", "technique");   // → preferred
    const twice = applyHumanPref(once, "b", "baseline");      // → demoted back
    expect(twice.evidence.filter((e) => e.metric === "human_pref" && e.brief === "b")).toHaveLength(1);
    expect(twice.evidence.find((e) => e.metric === "human_pref" && e.brief === "b")?.withScore).toBe(0);
    expect(twice.status).toBe("conformant");
  });
  it("stays preferred if ANY brief had a technique win", () => {
    const a = applyHumanPref(card(), "briefA", "technique"); // preferred
    const b = applyHumanPref(a, "briefB", "baseline");       // still preferred (briefA won)
    expect(b.status).toBe("preferred");
  });
});

describe("mertSeedRow — the probe-training row", () => {
  it("captures the card, the blinded slots, the owner's label + resolved pref", () => {
    const row = mertSeedRow(card(), man("B"), "B", 123);
    expect(row).toMatchObject({ card_id: "card_x", brief: "lofi-85-Am", technique_slot: "B", owner_label: "B", owner_pref: "technique", ts: 123 });
  });
});
