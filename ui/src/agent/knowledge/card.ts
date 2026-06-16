// A TechniqueCard is one unit of producer knowledge the agent can draw on: "when X,
// do Y". Cards are acquired by the flywheel (distill from the LLM + self-play), each
// VALIDATED by the audio scorer (does injecting it measurably raise the score?), then
// retrieved + injected into the agent's prompt at inference. The schema is aligned
// with the legacy autotutorial spike's `TutorialTask` so a future YouTube miner can
// emit the SAME shape (source:"youtube") into the same store + the same loop.
//
// Pure + browser-safe (no node imports): the product bundle imports this for retrieval.
import type { CheckSpec } from "./check";

export type CardSource = "distill" | "selfplay" | "youtube";
// prompt cards: candidate → validated/rejected (audio brief-match bar). recipe (in-the-box)
// cards: candidate → conformant (symbolic move-took-effect bar) → preferred (a human/learned
// audio-quality upgrade, deferred). See judgeAcceptance vs judgeConformance below.
export type CardStatus = "candidate" | "validated" | "rejected" | "conformant" | "preferred";

// Mirrors the spike's task_type enum (+ "prompt_craft" for generative-prompt knowledge).
export type TaskType =
  | "sound_design" | "arrangement" | "mixing" | "drum_programming"
  | "melody" | "bass" | "plugin_chain" | "prompt_craft" | "other";

// A card's intervention is one of two kinds, so the flywheel can A/B it cheaply:
//  - prompt: text appended to a generative (Stable Audio) prompt — tested by re-rendering.
//  - recipe: a concrete MoshOps command sequence applied in the DAW — tested by replay.
// A recipe card optionally carries its CONFORMANCE check as DATA (a CheckSpec) so the
// loop can re-validate it and a non-TS source (LLM/YouTube) can emit it whole. The baked
// product card ignores `check` (retrieval/injection only need the commands + the intent).
export type CardRecipe =
  | { kind: "prompt"; guidance: string }
  | { kind: "recipe"; commands: { command: string; args: Record<string, unknown> }[]; check?: CheckSpec };

// One A/B measurement: with-card vs without-card on a brief, on one scorer dimension.
// technique_conformance (recipe cards): withScore 1 = move took effect, 0 = it didn't.
// human_pref (deferred): a blind A/B ear label, 1 = with-card preferred.
export type CardEvidence = {
  brief: string;
  metric: "clap_brief" | "pq_perceptual" | "pq_hygiene" | "technique_conformance" | "human_pref";
  withScore: number;
  withoutScore: number;
  delta: number; // withScore - withoutScore
};

export type TechniqueCard = {
  id: string;
  source: CardSource;
  skill_name: string;        // "lo-fi hip-hop production recipe"
  task_type: TaskType;
  genre_context: string[];   // ["lo-fi hip-hop", "boom-bap"] — drives retrieval
  producer_intent: string;   // why / what it's for
  when: string;              // the retrieval trigger, in plain language
  recipe: CardRecipe;
  evidence: CardEvidence[];  // the scorer's verdict, per brief
  confidence: number;        // 0..1
  status: CardStatus;
};

// A small, stable, dependency-free hash (djb2) so a card's id is reproducible from its
// content — mirrors the spike's hash-derived ids (no node:crypto, this is browser-safe).
function djb2(s: string): string {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) >>> 0;
  return h.toString(36);
}

export function stableId(c: Pick<TechniqueCard, "skill_name" | "recipe">): string {
  // Identity = what the card DOES (skill + commands/guidance), NOT how it's validated.
  // Strip the optional recipe `check` so adding or changing a check never re-ids an
  // existing card (and the same technique mined from two sources collides correctly).
  const recipe = c.recipe.kind === "recipe" ? { kind: c.recipe.kind, commands: c.recipe.commands } : c.recipe;
  return "card_" + djb2(c.skill_name.trim().toLowerCase() + "|" + JSON.stringify(recipe));
}

export const isValidated = (c: TechniqueCard): boolean => c.status === "validated";

// The product ships cards that EARNED a place via either bar: prompt cards that passed
// brief-match ("validated"), or recipe (in-the-box) cards that passed conformance
// ("conformant") — or were ear-upgraded ("preferred"). Used by the store (what to bake)
// and retrieval (what to inject). candidate/rejected never ship.
export const isShippable = (c: TechniqueCard): boolean =>
  c.status === "validated" || c.status === "conformant" || c.status === "preferred";

// The acceptance bar (the flywheel's whole point): a card EARNS "validated" only if,
// injected, it raises clap_brief by ≥ margin on the primary brief AND never regresses
// brief-match on any tested brief (reproducibility over ≥2 briefs), AND doesn't flip
// the audio to a broken (hygiene/PQ) verdict. Pure + deterministic so it unit-tests.
export const ACCEPT_MARGIN = 0.02;

export function judgeAcceptance(
  evidence: CardEvidence[],
  opts: { margin?: number; regressedHygiene?: boolean } = {},
): { pass: boolean; reason: string } {
  const margin = opts.margin ?? ACCEPT_MARGIN;
  if (opts.regressedHygiene) return { pass: false, reason: "made the audio broken (hygiene/PQ flagged)" };
  const clap = evidence.filter((e) => e.metric === "clap_brief");
  const briefs = new Set(clap.map((e) => e.brief));
  if (briefs.size < 2) return { pass: false, reason: "needs brief-match evidence on ≥2 briefs" };
  if (clap.some((e) => e.delta < 0)) return { pass: false, reason: "regressed brief-match on a brief" };
  if (!clap.some((e) => e.delta >= margin)) return { pass: false, reason: `no brief improved by ≥${margin}` };
  return { pass: true, reason: "improves brief-match, reproduced, no regression" };
}

// The acceptance bar for RECIPE (in-the-box) cards — a CONFORMANCE bar, not a quality
// one: a card earns "conformant" iff the move took effect (symbolic conformance, read
// from the snapshot) on ≥2 arrangements, with no arrangement where it failed, and
// without breaking the mix. Quality — "does it sound better" — is the deferred
// audio-quality layer, NOT this. Pure + deterministic so it unit-tests.
export function judgeConformance(
  evidence: CardEvidence[],
  opts: { regressedHygiene?: boolean } = {},
): { pass: boolean; reason: string } {
  if (opts.regressedHygiene) return { pass: false, reason: "made the audio broken (hygiene/PQ flagged)" };
  const conf = evidence.filter((e) => e.metric === "technique_conformance");
  const briefs = new Set(conf.map((e) => e.brief));
  if (briefs.size < 2) return { pass: false, reason: "needs conformance on ≥2 arrangements" };
  if (conf.some((e) => e.withScore < 1)) return { pass: false, reason: "the move didn't take effect on an arrangement" };
  return { pass: true, reason: "move reproduced across arrangements, mix intact" };
}

// Map an accepted card's mean brief-match delta to a 0..1 confidence (bigger lift =
// more confident, saturating). Used to rank cards when several match a request.
export function deltaConfidence(evidence: CardEvidence[]): number {
  const clap = evidence.filter((e) => e.metric === "clap_brief");
  if (!clap.length) return 0.5;
  const mean = clap.reduce((a, e) => a + e.delta, 0) / clap.length;
  return Math.max(0, Math.min(1, 0.5 + mean * 4)); // +0.125 lift → ~1.0
}
