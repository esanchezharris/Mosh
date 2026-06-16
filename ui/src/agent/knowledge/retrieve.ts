// Pick the validated technique cards relevant to a request, to inject into the agent's
// prompt. v1 retrieval is deliberately simple: token overlap between the request text
// and each card's genre/when/skill, validated-only, top-K. Pure (no bridge/fs) so the
// product, the eval harness, and the flywheel all retrieve identically.
import { type TechniqueCard, isValidated } from "./card";
import { VALIDATED_CARDS } from "./cards.data";

const STOP = new Set(["the", "and", "for", "with", "make", "give", "want", "need", "some", "that", "this", "into", "from", "beat", "song", "track", "sound"]);

function relevance(card: TechniqueCard, query: string): number {
  const ql = query.toLowerCase();
  const qDeh = ql.replace(/-/g, ""); // de-hyphenated: "lo-fi" → "lofi"
  const hay = `${card.genre_context.join(" ")} ${card.when} ${card.skill_name}`.toLowerCase();
  const tokens = new Set(ql.split(/[^a-z0-9]+/).filter((w) => w.length > 2 && !STOP.has(w)));
  let score = 0;
  for (const w of tokens) if (hay.includes(w)) score += 1;
  // genre match, robust to hyphenation: whole phrase is a strong signal; otherwise any
  // de-hyphenated genre word ("lo-fi"~"lofi", "hip-hop"~"hiphop") in the request counts.
  for (const g of card.genre_context) {
    const gl = g.toLowerCase();
    if (gl.length > 3 && ql.includes(gl)) { score += 2; continue; }
    for (const w of gl.split(/\s+/).map((x) => x.replace(/[^a-z0-9]/g, "")).filter((x) => x.length > 2)) {
      if (qDeh.includes(w)) { score += 1; break; }
    }
  }
  return score;
}

/** Top-K validated cards relevant to `query` (the user's request), best first. */
export function retrieveCards(query: string, k = 3, cards: TechniqueCard[] = VALIDATED_CARDS): TechniqueCard[] {
  if (!query?.trim()) return [];
  return cards
    .filter(isValidated)
    .map((c) => ({ c, s: relevance(c, query) }))
    .filter((x) => x.s > 0)
    .sort((a, b) => b.s - a.s || b.c.confidence - a.c.confidence)
    .slice(0, Math.max(0, k))
    .map((x) => x.c);
}
