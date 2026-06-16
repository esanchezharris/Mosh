// Pure helpers for the quality seed set (scripts/qualitySeed.mts): the deferred audio-
// quality layer's DATA-COLLECTION half. For a conformant recipe card we render the base
// arrangement WITHOUT the technique vs WITH it, stage a BLIND A/B (which slot is the
// technique is hidden), and the owner's ear pick becomes a human_pref label — bumping the
// card to "preferred" (the schema's existing path) and seeding a future MERT-probe. This is
// data + a cleanliness guard, NOT a judge. Pure (no node) so it unit-tests.
import type { TechniqueCard, CardEvidence, CardStatus } from "./card";

export type AbLabel = "A" | "B" | "equal";       // the owner's blind pick
export type Pref = "technique" | "baseline" | "equal";
export type BlindManifest = { cardId: string; brief: string; a: string; b: string; techniqueSlot: "A" | "B" };

/** Map a blind A/B pick back to whether the WITH-technique render was preferred. */
export function resolvePref(m: { techniqueSlot: "A" | "B" }, label: AbLabel): Pref {
  if (label === "equal") return "equal";
  return label === m.techniqueSlot ? "technique" : "baseline";
}

/** Record an ear label as a human_pref evidence row (overwriting any prior row for the
 *  same brief) and recompute status: "preferred" iff SOME brief's technique render won. */
export function applyHumanPref(card: TechniqueCard, brief: string, pref: Pref): TechniqueCard {
  const withScore = pref === "technique" ? 1 : pref === "equal" ? 0.5 : 0;
  const row: CardEvidence = { brief, metric: "human_pref", withScore, withoutScore: 1 - withScore, delta: withScore - (1 - withScore) };
  const evidence = [...card.evidence.filter((e) => !(e.metric === "human_pref" && e.brief === brief)), row];
  const won = evidence.some((e) => e.metric === "human_pref" && e.withScore === 1);
  const status: CardStatus = won ? "preferred" : card.status === "preferred" ? "conformant" : card.status;
  return { ...card, evidence, status };
}

export type MertSeedRow = {
  card_id: string; skill_name: string; brief: string;
  a_wav: string; b_wav: string; technique_slot: "A" | "B";
  owner_label: AbLabel; owner_pref: Pref; ts: number;
};

/** The training row for the future MERT-probe: the blinded pair + the owner's verdict. */
export function mertSeedRow(card: TechniqueCard, m: BlindManifest, label: AbLabel, ts: number): MertSeedRow {
  return {
    card_id: card.id, skill_name: card.skill_name, brief: m.brief,
    a_wav: m.a, b_wav: m.b, technique_slot: m.techniqueSlot,
    owner_label: label, owner_pref: resolvePref(m, label), ts,
  };
}
