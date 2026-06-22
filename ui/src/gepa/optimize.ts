// GEPA-style reflective prompt optimizer (rung 1, TS-native).
//
// Optimizes the brain's RULES block (brainCore.DEFAULT_RULES) against the
// verifier reward (metric.ts). Each round: evaluate the current best on the
// train set, hand the worst failures to a REFLECTION model that rewrites the
// rules, evaluate the candidate, and keep it only if it improves on a held-out
// val set. This is the cheap, no-GPU first rung — it optimizes a prompt, not
// weights, using the deterministic verifier as the feedback signal.
//
// Both model roles are injected (the candidate brain + the reflection LM) so the
// loop is unit-tested with fakes and zero network. The CLI (scripts/gepa.mts)
// wires real OpenAI-compatible calls.

import type { CallBrain } from "../harvest/genTurns";
import type { EvalExample } from "./evalset";
import { evaluate, type EvalReport, type ExampleScore } from "./metric";

export type Reflect = (prompt: string) => Promise<string>;

export type Round = { rules: string; trainMean: number; valMean: number | null; accepted: boolean };
export type OptimizeResult = {
  baselineRules: string;
  baselineVal: number;
  baselineTrain: number;
  bestRules: string;
  bestVal: number;
  rounds: Round[];
};

/** Worst-first feedback digest for the reflection model. */
export function collectFeedback(report: EvalReport, limit = 8): string {
  const worst = [...report.perExample].sort((a, b) => a.score - b.score).slice(0, limit);
  return worst.map((e: ExampleScore) => `- ${e.feedback}`).join("\n");
}

/** Build the reflection prompt (pure, testable). */
export function buildReflectionPrompt(currentRules: string, feedbackDigest: string): string {
  return [
    'You are improving the RULES block of a system prompt for "Moshi", an agent that edits a music app by emitting JSON commands.',
    "The persona, the reply format, and the command catalog are FIXED — you may ONLY rewrite the rules block.",
    "",
    "Current rules:",
    currentRules,
    "",
    "The agent failed on these tasks (each line is what went wrong):",
    feedbackDigest || "(no specific failures captured)",
    "",
    "Rewrite the rules to fix these failures. Guidance:",
    "- A frequent failure is DEFERRING (emitting no commands / intent HUH) when the request is actionable and the needed id is visible in the session. Push the agent to act when it can.",
    "- ids must be emitted as JSON strings exactly as shown in the session, never bare numbers.",
    "- Never invent commands outside the catalog; keep the rules concise.",
    'Output ONLY the new rules block, starting with the line "Rules:". No commentary, no code fences.',
  ].join("\n");
}

/** Clean a reflection reply into a usable rules block. */
export function sanitizeRules(raw: string): string {
  let s = String(raw ?? "").trim().replace(/^```[a-z]*\s*/i, "").replace(/```$/i, "").trim();
  const i = s.indexOf("Rules:");
  if (i > 0) s = s.slice(i);
  if (!s.startsWith("Rules:")) s = `Rules:\n${s}`;
  return s.trim();
}

export async function optimizeRules(opts: {
  seedRules: string;
  train: EvalExample[];
  val: EvalExample[];
  callBrain: CallBrain;
  reflect: Reflect;
  rounds: number;
  onProgress?: (msg: string) => void;
}): Promise<OptimizeResult> {
  const log = opts.onProgress ?? (() => {});

  let bestTrainReport = await evaluate(opts.seedRules, opts.train, opts.callBrain);
  const baselineValReport = await evaluate(opts.seedRules, opts.val, opts.callBrain);
  const baselineTrain = bestTrainReport.mean;
  let bestRules = opts.seedRules;
  let bestVal = baselineValReport.mean;
  let bestTrain = bestTrainReport.mean;
  log(`baseline: train ${bestTrain.toFixed(3)} (${bestTrainReport.deferrals} deferrals), val ${bestVal.toFixed(3)}`);

  const rounds: Round[] = [];
  for (let r = 0; r < opts.rounds; r++) {
    const feedback = collectFeedback(bestTrainReport);
    const candidate = sanitizeRules(await opts.reflect(buildReflectionPrompt(bestRules, feedback)));
    const candTrain = await evaluate(candidate, opts.train, opts.callBrain);

    let valMean: number | null = null;
    let accepted = false;
    if (candTrain.mean > bestTrain) {
      const candVal = await evaluate(candidate, opts.val, opts.callBrain);
      valMean = candVal.mean;
      if (candVal.mean >= bestVal) {
        bestRules = candidate;
        bestVal = candVal.mean;
        bestTrain = candTrain.mean;
        bestTrainReport = candTrain;
        accepted = true;
      }
    }
    rounds.push({ rules: candidate, trainMean: candTrain.mean, valMean, accepted });
    log(`round ${r + 1}: train ${candTrain.mean.toFixed(3)}${valMean != null ? `, val ${valMean.toFixed(3)}` : " (no train gain, val skipped)"}${accepted ? " ✓ accepted" : ""}`);
  }

  return { baselineRules: opts.seedRules, baselineVal: baselineValReport.mean, baselineTrain, bestRules, bestVal, rounds };
}
