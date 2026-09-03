// The lane router: which asks deserve the multi-step loop. Pure heuristic v1 (a
// model-based router is a later upgrade behind this same seam). Precedence is decided
// by the CALLER — sectionScope and the fast path always run first, and hands-free
// voice never reaches an LLM at all.
//
// "single" no longer means "the cheap single-shot LLM path" — that lane is gone.
// AgentComposer calls routeAsk LAST, after the fast path and the studio skills have
// both declined, so a "single" verdict ends the turn as a HUH (its
// studio_skill_unsupported tail). Adding an ask class here is therefore the
// difference between serving it and refusing it, not between cheap and expensive.

export type Lane = "single" | "loop";

const SEQUENTIAL = /\bthen\b|;|\bafter that\b|\bnext\b|\bfinally\b/;
const CREATIVE_VERB = /\b(build|make|create|start|write|compose|produce|lay|sketch|give)\b/;
const CREATIVE_OBJECT = /\b(beat|track|song|sketch|groove|bassline|melody|drums|hook|loop|mix|arrangement|idea)\b/;
const VAGUE_TASTE = /\b(better|vibe|vibes|feel|bigger|wider|cleaner|dustier|glue|polish)\b/;
// Tempo is its OWN class, deliberately not folded into VAGUE_TASTE: "faster" is a
// concrete direction, not taste — loopPrompt's dosage rule already reads it that way
// ("faster ⇒ tempo +8-12%"). It routes to the loop because NO lane above the router
// owns tempo (fastPath's RULES table and session-control's anchored phrases are both
// tempo-free), so a "single" verdict on a tempo ask ends the turn as a HUH rather
// than as a cheaper route. Comparative, relative and absolute phrasings are all here
// on purpose — serving "make it faster" but refusing "set the tempo to 128" makes the
// capability a coin flip on wording.
const TEMPO_WORD = /\b(faster|slower|quicker|tempo|bpm)\b/;
const TEMPO_PHRASE = /\bspeed (?:it |this |them |things )?up\b|\bslow (?:it |this |them |things )?down\b|\bpick up the pace\b|\b(?:half|double)[- ]time\b/;

export const hasSequentialMarkers = (text: string): boolean => SEQUENTIAL.test(text.toLowerCase());

export function routeAsk(text: string): Lane {
  const t = text.toLowerCase().trim();
  if (!t) return "single";
  if (hasSequentialMarkers(t)) return "loop";
  if (CREATIVE_VERB.test(t) && CREATIVE_OBJECT.test(t)) return "loop";
  if (VAGUE_TASTE.test(t)) return "loop";
  if (TEMPO_WORD.test(t) || TEMPO_PHRASE.test(t)) return "loop";
  // several conjoined asks ("drop the drums and pan the keys and…")
  if ((t.match(/\band\b/g) ?? []).length >= 2) return "loop";
  if (t.length > 90) return "loop";
  return "single";
}
