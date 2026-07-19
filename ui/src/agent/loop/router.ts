// The lane router: which asks deserve the multi-step loop, which stay on the
// cheap single-shot path. Pure heuristic v1 (a model-based router is a later
// upgrade behind this same seam). Precedence is decided by the CALLER —
// sectionScope and the fast path always run first, and hands-free voice never
// reaches an LLM at all.

export type Lane = "single" | "loop";

const SEQUENTIAL = /\bthen\b|;|\bafter that\b|\bnext\b|\bfinally\b/;
const CREATIVE_VERB = /\b(build|make|create|start|write|compose|produce|lay|sketch)\b/;
const CREATIVE_OBJECT = /\b(beat|track|song|sketch|groove|bassline|melody|drums|hook|loop|mix|arrangement|idea)\b/;
const VAGUE_TASTE = /\b(better|vibe|vibes|feel|bigger|wider|cleaner|dustier|glue|polish)\b/;

export function routeAsk(text: string): Lane {
  const t = text.toLowerCase().trim();
  if (!t) return "single";
  if (SEQUENTIAL.test(t)) return "loop";
  if (CREATIVE_VERB.test(t) && CREATIVE_OBJECT.test(t)) return "loop";
  if (VAGUE_TASTE.test(t)) return "loop";
  // several conjoined asks ("drop the drums and pan the keys and…")
  if ((t.match(/\band\b/g) ?? []).length >= 2) return "loop";
  if (t.length > 90) return "loop";
  return "single";
}
