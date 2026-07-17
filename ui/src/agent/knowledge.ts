// Producer knowledge base — the "why/when" the command catalog (commands.ts) lacks.
// The catalog tells Moshi's brain WHAT each command does; these cards tell it, in
// plain producer terms, WHY/WHEN to reach for a control and what a param really means.
// A few relevant cards are retrieved per turn and injected next to the catalog by
// buildSystemPrompt() (brainCore.ts).
//
// The store is committed JSONL (one card per line) held as a string constant so it is
// bundle-safe under BOTH Vite (the app) AND tsx (the offline brain scripts) with zero
// bundler magic — no ?raw import, no fs read. Retrieval is deterministic tag/keyword
// match behind a swappable `retrieveCards` seam (mirrors the lyric style_corpus.retrieve
// posture: a lexical scorer now, a real embedding backend a parked upgrade behind the
// same seam). Cards are OWNER/ASSISTANT-authored — never auto-extracted (see
// docs/bench/FX_KB_PILOT.md for why VLM auto-extraction was a NO-GO).
//
// Schema note: `maps_to` is the control/param/command a card explains — the join key a
// future UI can use to surface the same card as an inline hint on the matching control.

export type KnowledgeCard = {
  /** Stable unique id — one card is one fact. */
  readonly id: string;
  /** Short human topic (for authoring/index; not shown to the model). */
  readonly topic: string;
  /** The control/param/command this card is about — the UI-hint join key. */
  readonly maps_to: string;
  /** What it does, in one layman sentence. */
  readonly plain: string;
  /** When to reach for it. */
  readonly when: string;
  /** Keyword tags — the primary retrieval signal. */
  readonly tags: readonly string[];
};

// ── the committed store (JSONL, one card per line) ────────────────────────────────
// Append a card = add a line. Keep it valid JSON with double-quoted keys/strings.
export const PRODUCER_KNOWLEDGE_JSONL = `
{"id":"sa3-onset-steering","topic":"Opening energy fades across the clip","maps_to":"colors / neural steering","plain":"SA3 makes a stronger statement in the first ~1 second then settles; the steering/colors nudge the model's 'brain' in a direction, and a time-scheduled steer can KEEP that opening energy going across the whole clip instead of letting it fade.","when":"the generation starts strong then thins out and you want it to stay full.","tags":["energy","intro","opening","arrangement","steering","colors","fade","settles"]}
{"id":"reimagine-noise-amount","topic":"How far a re-imagine departs from your beat","maps_to":"nl / init_noise_level (re-imagine)","plain":"The re-imagine 'noise' is how much of YOUR original beat to keep vs how much Moshi reinvents — low (<=0.5) keeps your groove and stays clean over long clips, high (>=0.7) reinvents more but can make each section restart its intro.","when":"deciding how far to push a re-imagine, or if a long re-imagine pulses every few bars.","tags":["reimagine","noise","amount","nl","init_noise_level","whole-clip","groove","pulse"]}
`.trim();

function parseKnowledge(jsonl: string): KnowledgeCard[] {
  const out: KnowledgeCard[] = [];
  for (const raw of jsonl.split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("//")) continue;
    const o = JSON.parse(line) as KnowledgeCard;
    out.push({
      id: String(o.id),
      topic: String(o.topic),
      maps_to: String(o.maps_to),
      plain: String(o.plain),
      when: String(o.when),
      tags: Array.isArray(o.tags) ? o.tags.map(String) : [],
    });
  }
  return out;
}

/** The parsed producer-knowledge store. */
export const PRODUCER_KNOWLEDGE: readonly KnowledgeCard[] = parseKnowledge(PRODUCER_KNOWLEDGE_JSONL);

// ── deterministic tag/keyword retrieval (swappable seam) ──────────────────────────

const TOKEN_RE = /[a-z0-9]+/g;
// Very common / low-signal words carry no "which control" signal — exclude them.
const STOP = new Set([
  "the", "a", "an", "and", "or", "but", "to", "of", "in", "on", "at", "for", "with",
  "i", "me", "my", "you", "your", "it", "its", "is", "are", "be", "am", "as", "so",
  "that", "this", "do", "does", "did", "how", "should", "can", "could", "would",
  "will", "if", "then", "than", "out", "up", "down", "more", "less", "not", "no",
  "yes", "just", "now", "when", "why", "what", "some", "any", "get", "got",
]);

function tokenize(text: string): string[] {
  const out: string[] = [];
  for (const m of (text || "").toLowerCase().matchAll(TOKEN_RE)) {
    const t = m[0];
    if (t.length >= 2 && !STOP.has(t)) out.push(t);
  }
  return out;
}

// A card's token → weight bag. Tags are the primary signal (3); topic/maps_to next
// (2); the prose (plain/when) lowest (1) so a producer's natural phrasing still hits.
function cardWeights(card: KnowledgeCard): Map<string, number> {
  const w = new Map<string, number>();
  const add = (text: string, weight: number) => {
    for (const t of tokenize(text)) if ((w.get(t) ?? 0) < weight) w.set(t, weight);
  };
  add(`${card.plain} ${card.when}`, 1);
  add(`${card.topic} ${card.maps_to}`, 2);
  add(card.tags.join(" "), 3);
  return w;
}

export type RetrieveOptions = {
  /** Max cards to return (default 3). */
  readonly limit?: number;
  /** The pool to score against (default: the committed store). */
  readonly cards?: readonly KnowledgeCard[];
};

/** The few cards most relevant to `query`, by weighted tag/keyword overlap.
 *  Deterministic: rank by score, ties break by id. Zero-overlap cards are dropped
 *  (an irrelevant card in the prompt is worse than none — the style_corpus principle). */
export function retrieveCards(query: string, opts: RetrieveOptions = {}): KnowledgeCard[] {
  const cards = opts.cards ?? PRODUCER_KNOWLEDGE;
  const limit = opts.limit ?? 3;
  const qTokens = Array.from(new Set(tokenize(query)));
  if (qTokens.length === 0) return [];
  const scored = cards
    .map((card) => {
      const w = cardWeights(card);
      let score = 0;
      for (const t of qTokens) score += w.get(t) ?? 0;
      return { card, score };
    })
    .filter((s) => s.score > 0);
  scored.sort((a, b) => b.score - a.score || a.card.id.localeCompare(b.card.id));
  return scored.slice(0, limit).map((s) => s.card);
}

/** Render retrieved cards into a compact system-prompt block. Empty ⇒ "" (so the
 *  prompt is byte-unchanged when nothing is relevant). */
export function knowledgePromptSection(cards: readonly KnowledgeCard[]): string {
  if (cards.length === 0) return "";
  return [
    "Producer knowledge — plain-language notes on the controls this request may touch. Use them to choose and explain moves; speak them in your own voice, never quote verbatim.",
    ...cards.map((c) => `- ${c.maps_to}: ${c.plain} (when: ${c.when})`),
  ].join("\n");
}
