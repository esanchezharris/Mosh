// M2 (Phase-B memory lane) — the unified memory-retrieval module. Scores knowledge
// cards, preferences, and patterns together (deterministic pool weights 3/2/1) into
// ONE ranked, budget-capped prompt section; project-sidecar notes are injected
// UNSCORED whenever any exist (they're already scoped to THIS song — always relevant,
// never competing for a rank slot).
//
// Pure — no bridge/window dependency (mirrors knowledge.ts/brainCore.ts's posture).
// The bridge-coupled half (fetching the pools via agent_memory_read) lives in
// memory/hydrate.ts; callers glue hydrate() + retrieveContext() together (see
// brain.ts / loop/runTask.ts).

import { tokenize, scorePool } from "./scoring";
import { cardWeights, type KnowledgeCard } from "../knowledge";

/** Mirrors the {ts,kind,explicit,item} shape AgentMemoryStore (native) and the mock
 *  both return from agent_memory_read. `item` is whatever was written — a string or a
 *  JSON object — stored verbatim. */
export type MemoryRecord = {
  readonly ts: number;
  readonly kind: string;
  readonly explicit: boolean;
  readonly item: unknown;
};

export type MemoryPools = {
  /** Scored at pool-weight 3. Omitted ⇒ knowledge cards are NOT part of this ranking
   *  (the existing standalone knowledgePromptSection/retrieveCards path — already
   *  wired into buildSystemPrompt's `knowledge` param — keeps covering them; passing
   *  a pool here as well would duplicate that content). Present for callers/tests
   *  that DO want a single fully-unified ranking. */
  readonly knowledge?: readonly KnowledgeCard[];
  /** Scored at pool-weight 2 ("preference" kind, global scope). */
  readonly preferences?: readonly MemoryRecord[];
  /** Scored at pool-weight 1 ("drum_pattern" + "lyric_framework" kinds, global scope,
   *  already merged by the caller). */
  readonly patterns?: readonly MemoryRecord[];
  /** Injected UNSCORED, always, whenever non-empty (project scope). */
  readonly projectNotes?: readonly MemoryRecord[];
};

const POOL_WEIGHT = { knowledge: 3, preference: 2, pattern: 1 } as const;

/** ~2KB, measured in UTF-8 bytes (the actual over-the-wire prompt cost), not chars. */
export const MEMORY_BUDGET_BYTES = 2048;

const byteLength = (s: string): number => new TextEncoder().encode(s).length;

function memoryItemText(item: unknown): string {
  if (typeof item === "string") return item;
  try { return JSON.stringify(item); } catch { return String(item); }
}

// Flat per-token weight (no internal tiering — a memory item has no tags/topic/prose
// structure the way a knowledge card does), scaled by the pool weight.
function flatWeights(text: string, poolWeight: number): Map<string, number> {
  const w = new Map<string, number>();
  for (const t of tokenize(text)) w.set(t, poolWeight);
  return w;
}

export type RankedEntry = {
  readonly id: string;
  readonly pool: "knowledge" | "preference" | "pattern";
  readonly render: string;
  readonly score: number;
};

// One unified item shape scorePool() ranks across all three scored pools. Each
// carries its own pre-weighted token map (pool weight baked in — a knowledge card's
// internal 1/2/3 tag/topic/prose tiers are multiplied by 3, so its relative internal
// ranking survives while it still outranks flat-weight pattern/preference tokens).
type Candidate = { id: string; pool: RankedEntry["pool"]; render: string; weights: Map<string, number> };

function scaleWeights(base: Map<string, number>, factor: number): Map<string, number> {
  const out = new Map<string, number>();
  for (const [k, v] of base) out.set(k, v * factor);
  return out;
}

function knowledgeCandidate(card: KnowledgeCard): Candidate {
  return {
    id: `knowledge:${card.id}`,
    pool: "knowledge",
    render: `- ${card.maps_to}: ${card.plain} (when: ${card.when})`,
    weights: scaleWeights(cardWeights(card), POOL_WEIGHT.knowledge),
  };
}

function preferenceCandidate(rec: MemoryRecord, idx: number): Candidate {
  const text = memoryItemText(rec.item);
  return {
    id: `preference:${idx}:${rec.ts}`,
    pool: "preference",
    render: `- (your taste) ${text}`,
    weights: flatWeights(text, POOL_WEIGHT.preference),
  };
}

function patternCandidate(rec: MemoryRecord, idx: number): Candidate {
  const text = memoryItemText(rec.item);
  return {
    id: `pattern:${idx}:${rec.ts}`,
    pool: "pattern",
    render: `- (a pattern you use) ${text}`,
    weights: flatWeights(text, POOL_WEIGHT.pattern),
  };
}

/** Ranks knowledge + preferences + patterns together against `query`. Pure, exported
 *  for direct testing of the weighting/ordering contract (retrieveContext() is the
 *  end-to-end entry point that also folds in the unscored project notes + budget). */
export function rankMemoryEntries(query: string, pools: MemoryPools): RankedEntry[] {
  const candidates: Candidate[] = [
    ...(pools.knowledge ?? []).map(knowledgeCandidate),
    ...(pools.preferences ?? []).map(preferenceCandidate),
    ...(pools.patterns ?? []).map(patternCandidate),
  ];
  const scored = scorePool(query, candidates, (c) => c.weights, (c) => c.id);
  return scored.map((s) => ({ id: s.item.id, pool: s.item.pool, render: s.item.render, score: s.score }));
}

function renderProjectNote(rec: MemoryRecord): string {
  return `- (this project) ${memoryItemText(rec.item)}`;
}

/** Assembles the final memory prompt section: project notes FIRST (unscored, always,
 *  whenever any exist), then ranked entries in descending-score order, filling up to
 *  @p budgetBytes (a line that would overflow the budget is simply omitted, not
 *  truncated mid-line — a partial fact is worse than a missing one). Returns "" when
 *  there is nothing to show (mirrors knowledgePromptSection's empty-⇒-"" contract, so
 *  the prompt stays unchanged when memory has nothing relevant). */
export function renderMemorySection(
  projectNotes: readonly MemoryRecord[],
  ranked: readonly RankedEntry[],
  budgetBytes: number = MEMORY_BUDGET_BYTES,
): string {
  const header =
    "Memory — things you've learned, been told to remember, or notes on this project. " +
    "Use them naturally; never quote verbatim, never mention \"memory\".";
  const lines: string[] = [];
  let used = byteLength(header);

  const tryAdd = (line: string): boolean => {
    const cost = byteLength("\n" + line);
    if (used + cost > budgetBytes) return false;
    lines.push(line);
    used += cost;
    return true;
  };

  for (const n of projectNotes) tryAdd(renderProjectNote(n));
  for (const r of ranked) tryAdd(r.render);

  if (lines.length === 0) return "";
  return [header, ...lines].join("\n");
}

/** The unified entry point: hydrate the pools elsewhere (memory/hydrate.ts), then
 *  call this per-turn with the user's query. Pure/synchronous — no I/O. */
export function retrieveContext(query: string, pools: MemoryPools = {}): string {
  const ranked = rankMemoryEntries(query, pools);
  return renderMemorySection(pools.projectNotes ?? [], ranked);
}
