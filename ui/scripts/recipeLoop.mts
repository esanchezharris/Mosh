// The shared in-the-box conformance loop: take a candidate recipe card (meta + commands +
// a declarative CheckSpec), apply it on each base arrangement, read the resulting snapshot,
// and judge symbolic conformance. ONE path for every source — the hand-seeded cards
// (recipeFlywheel), the LLM distiller (recipeDistill), the YouTube miner (ytMiner) — so a
// card from any origin is validated identically. No audio / DSP / SA3.
import { Engine } from "./agentEngine.mts";
import { bindRecipe, type RecipeCommand } from "../src/agent/knowledge/recipe";
import { runCheck } from "../src/agent/knowledge/check";
import { type ConformanceResult } from "../src/agent/knowledge/conformance";
import {
  type TechniqueCard, type CardEvidence, type CardRecipe, type CardSource,
  stableId, judgeConformance,
} from "../src/agent/knowledge/card";
import { type CandidateCard } from "../src/agent/knowledge/distill";
import { coerceArgs, validateCommand } from "../src/agent/commands";
import { buildBase, type BaseSpec } from "./recipeBase.mts";

export type Outcome = { card: TechniqueCard; perArr: { baseId: string; res: ConformanceResult }[]; reason: string };

// Progressive bind+exec: resolve $tokens against the base bindings + ids captured from
// EARLIER commands in this same recipe (e.g. create_bus → $busNumber), validate, run.
export async function applyRecipe(eng: Engine, commands: RecipeCommand[], bindings: Record<string, unknown>): Promise<Record<string, unknown>> {
  const runtime: Record<string, unknown> = {};
  for (const raw of commands) {
    const [bound] = bindRecipe([raw], { ...runtime, ...bindings }); // base bindings win on name collisions
    const args = coerceArgs(bound.command, bound.args);
    const err = validateCommand(bound.command, args);
    if (err) throw new Error(`recipe command invalid: ${err}`);
    const r = await eng.exec(bound.command, args);
    if (!r?.ok) throw new Error(`recipe ${bound.command} failed — ${r?.error || "no error"}`);
    for (const k of ["busNumber", "trackId", "clipId", "pointIndex"]) if (r.data?.[k] != null && runtime[k] == null) runtime[k] = r.data[k];
  }
  return runtime;
}

// Run one candidate across ≥2 arrangements (isolated Engine each) → an Outcome with a
// conformant/rejected card. onResult lets the caller stream per-arrangement progress.
export async function runCandidateThroughLoop(
  cand: CandidateCard,
  arrangements: BaseSpec[],
  opts: { source?: CardSource; env: Record<string, string>; onResult?: (baseId: string, res: ConformanceResult) => void },
): Promise<Outcome> {
  const evidence: CardEvidence[] = [];
  const perArr: { baseId: string; res: ConformanceResult }[] = [];
  for (const arr of arrangements) {
    let res: ConformanceResult;
    const eng = new Engine(opts.env);
    try {
      const base = await buildBase(eng, arr);
      const before = await eng.snapshot();
      const runtime = await applyRecipe(eng, cand.commands, base as unknown as Record<string, unknown>);
      const after = await eng.snapshot();
      res = runCheck(cand.check, before, after, base as unknown as Record<string, unknown>, runtime);
    } catch (e) {
      res = { conformant: false, detail: `error: ${(e as Error).message}` };
    } finally { eng.close(); }
    perArr.push({ baseId: arr.baseId, res });
    evidence.push({ brief: arr.baseId, metric: "technique_conformance", withScore: res.conformant ? 1 : 0, withoutScore: 0, delta: res.conformant ? 1 : 0 });
    opts.onResult?.(arr.baseId, res);
  }
  const verdict = judgeConformance(evidence);
  const recipe: CardRecipe = { kind: "recipe", commands: cand.commands, check: cand.check };
  const card: TechniqueCard = {
    id: stableId({ skill_name: cand.meta.skill_name, recipe }),
    source: opts.source ?? "distill",
    skill_name: cand.meta.skill_name, task_type: cand.meta.task_type,
    genre_context: cand.meta.genre_context, producer_intent: cand.meta.producer_intent, when: cand.meta.when,
    recipe, evidence, confidence: verdict.pass ? 0.75 : 0.3, status: verdict.pass ? "conformant" : "rejected",
  };
  return { card, perArr, reason: verdict.reason };
}
