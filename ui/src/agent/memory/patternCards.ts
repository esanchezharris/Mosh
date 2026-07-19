// M4 (Phase-B memory lane) — the pattern-library card shapes: DrumPatternCard and
// LyricFrameworkCard, the `item` shape a memory record carries for M1's two "pattern"
// kinds (global scope, kind: "drum_pattern" | "lyric_framework"). Write one via
// agent_memory_write{scope:"global", kind, item: card, explicit:true} and it round-
// trips back out of agent_memory_read unchanged (the store is just JSONL — whatever
// object gets written is what comes back).
//
// LyricFrameworkCard is FLOW STRUCTURE ONLY — the owner's own framing: memory stores
// must not become a lyrics corpus (the same safety wall style_corpus.py's opt-in-only
// posture already enforces for the §7 flywheel). validateNoLyricText() is the
// enforcement point: it rejects any candidate item carrying a `text` or `lines` key —
// the exact shape a raw LyricSheet/LyricLine[] carries — before it's ever handed to
// agent_memory_write. A legitimate LyricFrameworkCard never collides with this: its
// structural array is named `frame` (not `lines`), and its per-line entries carry only
// role/syllables/stress/rhyme — never a `text` field.

import type { LyricSheet } from "../../types";
import { serializeDrumPattern, type SerializableDrumPattern } from "../../ui/drumPatternUtil";

export type PatternCardSource = "saved" | "seed" | "agent";

export type DrumPatternCard = {
  name: string;
  /** Flat "lane: steps; lane: steps" string — verbatim add_drum_pattern-ready (see
   *  drumPatternUtil.ts's serializeDrumPattern/drumPatternFromNotes). */
  pattern: string;
  stepsPerBar: number;
  bars: number;
  tags: string[];
  bpmRange?: [number, number];
  source: PatternCardSource;
  uses: number;
};

export type LyricFrameworkLine = {
  role: string; // "verse" | "hook" | "bridge" | "adlib" | ... — mirrors LyricLine.role
  syllables: number; // 0 == free/unspecified — mirrors LyricLine.syllableTarget
  stress: string; // contour, e.g. "xXxxxX" ('?' == free) — mirrors LyricLine.stress
  rhyme: string; // rhyme-SCHEME LETTER (A, B, C, ...) — never the raw rhymeGroup id/name
};

export type LyricFrameworkCard = {
  name: string;
  grid: string; // "1/4" | "1/8" | "1/16" — mirrors LyricSheet.grid
  rhymeStrictness: string; // "perfect" | "slant" | "free" — mirrors LyricSheet.rhymeStrictness
  frame: LyricFrameworkLine[]; // deliberately NOT "lines" — see file header
  tags: string[];
  source: PatternCardSource;
  uses: number;
};

export function isDrumPatternCard(item: unknown): item is DrumPatternCard {
  return !!item && typeof item === "object" && !Array.isArray(item)
    && typeof (item as DrumPatternCard).pattern === "string"
    && typeof (item as DrumPatternCard).stepsPerBar === "number";
}

export function isLyricFrameworkCard(item: unknown): item is LyricFrameworkCard {
  return !!item && typeof item === "object" && !Array.isArray(item)
    && Array.isArray((item as LyricFrameworkCard).frame)
    && typeof (item as LyricFrameworkCard).grid === "string";
}

/** The style-corpus safety wall. Rejects a candidate LyricFrameworkCard (or any nested
 *  array entry within it) that carries a `text` or `lines` key — the exact fields a raw
 *  LyricSheet/LyricLine[] carries, which a properly-derived framework card never does
 *  (see buildLyricFrameworkCard: it reads sheet.lines but only copies structural fields
 *  out). One level of array-nesting is checked (covers `frame` and any future array
 *  field) — deliberately not a full recursive scanner; the goal is to catch "a raw
 *  sheet/line object got passed through by mistake", not to sandbox arbitrary JSON. */
export function validateNoLyricText(item: unknown): { ok: true } | { ok: false; error: string } {
  const REASON = "lyric framework card must not carry lyric text ('text'/'lines' fields are rejected)";
  const hasBannedKey = (o: unknown): boolean =>
    !!o && typeof o === "object" && !Array.isArray(o) && ("text" in o || "lines" in o);
  if (hasBannedKey(item)) return { ok: false, error: REASON };
  if (item && typeof item === "object" && !Array.isArray(item)) {
    for (const v of Object.values(item as Record<string, unknown>)) {
      if (!Array.isArray(v)) continue;
      for (const el of v) if (hasBannedKey(el)) return { ok: false, error: REASON };
    }
  }
  return { ok: true };
}

/** Maps rhymeGroup values (in first-appearance order, per line) to scheme letters
 *  (A, B, C, …). An empty/blank group renders as "-" (no rhyme constraint on that
 *  line) rather than starting a new letter. */
function rhymeLetters(groups: readonly string[]): string[] {
  const map = new Map<string, string>();
  return groups.map((g) => {
    const key = g.trim();
    if (!key) return "-";
    if (!map.has(key)) map.set(key, String.fromCharCode(65 + map.size)); // A, B, C, ...
    return map.get(key)!;
  });
}

/** Derives a LyricFrameworkCard from a real LyricSheet — structure only. Lines are
 *  ordered by their sheet index (not insertion order, which may differ after edits). */
export function buildLyricFrameworkCard(
  sheet: Pick<LyricSheet, "grid" | "rhymeStrictness" | "lines">,
  name: string,
  tags: string[] = [],
): LyricFrameworkCard {
  const sorted = [...sheet.lines].sort((a, b) => a.index - b.index);
  const letters = rhymeLetters(sorted.map((l) => l.rhymeGroup));
  const frame: LyricFrameworkLine[] = sorted.map((l, i) => ({
    role: l.role,
    syllables: l.syllableTarget,
    stress: l.stress,
    rhyme: letters[i],
  }));
  return { name, grid: sheet.grid, rhymeStrictness: sheet.rhymeStrictness, frame, tags, source: "saved", uses: 0 };
}

/** Derives a DrumPatternCard from parsed/read step data (drumPatternUtil.ts's
 *  parseDrumPattern or drumPatternFromNotes output) — the pattern string is the
 *  verbatim serialization, always add_drum_pattern-ready. */
export function buildDrumPatternCard(
  parsed: SerializableDrumPattern,
  name: string,
  tags: string[] = [],
  bpmRange?: [number, number],
): DrumPatternCard {
  return {
    name,
    pattern: serializeDrumPattern(parsed),
    stepsPerBar: parsed.stepsPerBar,
    bars: parsed.totalSteps / parsed.stepsPerBar,
    tags,
    bpmRange,
    source: "saved",
    uses: 0,
  };
}

// AGT-MEM (M4) — compact, human-readable one-line summaries for the memory PANEL
// (TopbarTools.tsx's MemoryTool) — distinct from retrieveContext.ts's LLM-prompt-
// oriented renderers (different audience, different wording), but the same underlying
// intent: a producer browsing what Moshi remembers should never see raw JSON for a
// card-shaped item.
export function summarizeDrumPatternCard(card: DrumPatternCard): string {
  const bpm = card.bpmRange ? ` · ${card.bpmRange[0]}-${card.bpmRange[1]} bpm` : "";
  return `${card.bars} bar${card.bars === 1 ? "" : "s"} @ ${card.stepsPerBar}/bar${bpm} — ${card.pattern}`;
}
export function summarizeLyricFrameworkCard(card: LyricFrameworkCard): string {
  const grid = card.frame.map((l) => `${l.role}(${l.syllables || "free"})/${l.rhyme}`).join(" ");
  return `grid ${card.grid}, ${card.rhymeStrictness} rhyme — ${grid}`;
}
