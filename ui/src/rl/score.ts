// RL reward seam — Rung 1 (clean-apply).
//
// The GRPO loop scores each sampled rollout with the SAME deterministic verifier
// the SFT eval uses (`scoreReply` in gepa/metric.ts: clean-apply × fair command-name
// recall, through the mock backend — no audio, no native build, fully reproducible).
// Keeping the reward here, behind one tiny function, is deliberate: Rung 2 swaps this
// implementation for the teardown `Reward` (floor + MERT pull over rendered audio)
// without touching the trainer or the rollout plumbing.

import type { EvalExample } from "../gepa/evalset";
import { scoreReply } from "../gepa/metric";

export type RolloutReward = {
  /** scalar reward in [0,1] — clean-apply × fair gold-command-name recall */
  reward: number;
  /** true when the policy emitted no commands (the "acts-shy" failure → reward 0) */
  deferred: boolean;
  /** human-readable why (apply errors / missing commands), for tripwire logs */
  feedback: string;
};

/** Score one policy completion against its task. Pure, deterministic, audio-free. */
export async function scoreRollout(ex: EvalExample, content: string): Promise<RolloutReward> {
  const s = await scoreReply(ex, content);
  return { reward: s.score, deferred: s.deferred, feedback: s.feedback };
}
