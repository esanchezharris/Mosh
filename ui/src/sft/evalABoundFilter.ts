export type ClipWindow = { start: number; length: number };

const EVAL_A_BOUND_CLIPS: Record<string, ClipWindow> = {
  keys: { start: 4, length: 8 },
  sub: { start: 0, length: 3 },
};

export function inferEvalABoundClip(utterance: string): ClipWindow | null {
  if (/\bsub\b|\baudio clip\b/i.test(utterance)) return EVAL_A_BOUND_CLIPS.sub;
  if (/\bkeys\b|\bmidi\b/i.test(utterance)) return EVAL_A_BOUND_CLIPS.keys;
  return null;
}

export function parseSplitTimeSeconds(utterance: string): number | null {
  const match = utterance.match(/\bat\s+(\d+(?:\.\d+)?)\s*(?:seconds?|s)\b/i);
  return match ? Number(match[1]) : null;
}

export function isEvalABoundCompatible(cmd: string, utterance: string): boolean {
  if (cmd !== "split_clip") return true;
  const clip = inferEvalABoundClip(utterance);
  const splitTime = parseSplitTimeSeconds(utterance);
  if (!clip || splitTime == null) return true;
  return splitTime > clip.start && splitTime < clip.start + clip.length;
}
