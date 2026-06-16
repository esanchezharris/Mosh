// Prompt engineering for Stable Audio 3 (text-to-audio). SA3 was trained on audio
// paired with free-text + metadata captions, so it responds best to prompts that name
// GENRE, INSTRUMENTS, MOOD, TEMPO (BPM), KEY and PRODUCTION character — not vague vibes.
// This module turns a structured Brief into SA3-optimized prompt strings in several
// named STYLES, so we can audition which phrasing the model actually renders best
// (the genbench arena) and then bake the winner into the product (generate_audio + the
// agent strategies). Pure module — no bridge/DOM — so tests, the bench, and the agent
// can all import it.

export type Brief = {
  genre: string;            // "lo-fi hip-hop", "drum & bass", "ambient"
  bpm?: number;             // tempo in BPM — SA3 keys rhythm off this
  key?: string;             // "A minor"
  instruments?: string[];   // ["dusty boom-bap drums", "warm Rhodes chords", "mellow sub bass"]
  mood?: string[];          // ["nostalgic", "mellow", "hazy"]
  production?: string[];    // ["vinyl crackle", "tape saturation", "MPC swing", "sidechained"]
  era?: string;             // "90s", "early 2000s"
  refs?: string[];          // gear / artist-adjacent cues — "SP-1200", "J Dilla swing", "Madlib"
  // For stem renders: name the ONE element to isolate (the others are dropped).
  stem?: string;            // "drums" | "bass" | "chords" — when set, prompt asks for that alone
};

export type PromptStyle = "terse" | "descriptive" | "tag" | "reference";

export const PROMPT_STYLES: PromptStyle[] = ["terse", "descriptive", "tag", "reference"];

const clean = (s: string) => s.replace(/\s+/g, " ").trim().replace(/\s+,/g, ",").replace(/,\s*,/g, ", ");

/** Tempo/key clause shared by several styles — SA3 reliably honours an explicit BPM. */
function tempoKey(b: Brief): string {
  const bits: string[] = [];
  if (b.bpm) bits.push(`${b.bpm} BPM`);
  if (b.key) bits.push(b.key);
  return bits.join(", ");
}

/** What the render should contain, given the stem focus (full mix vs one isolated element). */
function bodyInstruments(b: Brief): string[] {
  if (b.stem) {
    const named = (b.instruments || []).find((i) => i.toLowerCase().includes(b.stem!.toLowerCase()));
    return [named || `${b.stem} only`];
  }
  return b.instruments || [];
}

/** terse — the minimal control prompt (the kind the agent writes off-the-cuff today). */
function terse(b: Brief): string {
  const inst = bodyInstruments(b);
  const lead = b.stem ? `just the ${inst[0]}` : `${b.genre} beat`;
  const head = b.stem ? lead : `${lead}${inst[0] ? ` with ${inst[0]}` : ""}`;
  return clean(`${head}${b.bpm ? `, ${b.bpm} BPM` : ""}`);
}

/** descriptive — flowing natural language: mood + full instrumentation + tempo/key. */
function descriptive(b: Brief): string {
  const inst = bodyInstruments(b);
  const moodWord = (b.mood || []).slice(0, 2).join(", ");
  const tk = tempoKey(b);
  const what = b.stem ? `an isolated ${b.stem} part` : `a ${b.genre} loop`;
  const instText = inst.length ? ` featuring ${inst.join(", ")}` : "";
  const prod = (b.production || []).length ? `, with ${(b.production || []).slice(0, 3).join(", ")}` : "";
  return clean(`${moodWord ? `${moodWord.charAt(0).toUpperCase()}${moodWord.slice(1)}, ` : ""}${what}${tk ? ` at ${tk}` : ""}${instText}${prod}.`);
}

/** tag — the canonical Stable-Audio metadata style: comma-separated descriptors. */
function tag(b: Brief): string {
  const parts = [
    b.genre,
    b.era ? `${b.era}` : "",
    ...bodyInstruments(b),
    tempoKey(b),
    ...(b.mood || []),
    ...(b.production || []),
  ].filter(Boolean);
  return clean(parts.join(", "));
}

/** reference — evocative era + gear/artist references + feel; leans on cultural priors. */
function reference(b: Brief): string {
  const inst = bodyInstruments(b);
  const era = b.era ? `${b.era} ` : "";
  const refs = (b.refs || []).slice(0, 3).join(", ");
  const tk = tempoKey(b);
  const what = b.stem ? `${b.stem}` : `${b.genre} instrumental`;
  return clean(
    `${era}${what}${refs ? ` in the style of ${refs}` : ""}` +
      `${inst.length ? `: ${inst.join(", ")}` : ""}${tk ? `, ${tk}` : ""}` +
      `${(b.production || []).length ? `, ${(b.production || []).slice(0, 2).join(", ")}` : ""}`,
  );
}

const BUILDERS: Record<PromptStyle, (b: Brief) => string> = { terse, descriptive, tag, reference };

/** Build an SA3 prompt for a brief in the given style. */
export function craftPrompt(brief: Brief, style: PromptStyle = "tag"): string {
  return BUILDERS[style](brief);
}

/** All four styles for a brief — used by the bench to audition phrasing side-by-side. */
export function allStyles(brief: Brief): { style: PromptStyle; prompt: string }[] {
  return PROMPT_STYLES.map((style) => ({ style, prompt: craftPrompt(brief, style) }));
}
