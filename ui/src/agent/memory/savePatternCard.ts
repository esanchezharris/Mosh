// M4 (Phase-B memory lane, item 3) — the write+confirm path for the two "save to
// memory" affordances (drum clip menu / LyricPanel), mirroring writePreference.ts's
// shape (write -> invalidate -> read back for the new record's ts, so the caller's
// confirm toast can offer a true Undo via agent_memory_delete{ts}).

import { invalidateMemoryHydration } from "./hydrate";
import type { DrumPatternCard, LyricFrameworkCard } from "./patternCards";
import { validateNoLyricText } from "./patternCards";

export type ExecFn = (command: string, args?: Record<string, unknown>) => Promise<{
  ok: boolean;
  data?: unknown;
  error?: string;
}>;

export type SaveCardResult = { ok: true; ts: number } | { ok: false; error: string };

type ReadItemsData = { items?: { ts: number }[] };

async function writeAndConfirm(exec: ExecFn, kind: "drum_pattern" | "lyric_framework", item: unknown): Promise<SaveCardResult> {
  const w = await exec("agent_memory_write", { scope: "global", kind, explicit: true, item });
  if (!w.ok) return { ok: false, error: w.error ?? "agent_memory_write failed" };
  invalidateMemoryHydration();
  const r = await exec("agent_memory_read", { scope: "global", kind, limit: 1 });
  const ts = (r.data as ReadItemsData | undefined)?.items?.[0]?.ts;
  if (typeof ts !== "number") return { ok: false, error: "saved it but couldn't confirm it" };
  return { ok: true, ts };
}

export async function saveDrumPatternCard(exec: ExecFn, card: DrumPatternCard): Promise<SaveCardResult> {
  return writeAndConfirm(exec, "drum_pattern", card);
}

/** Runs the style-corpus safety wall (validateNoLyricText) BEFORE writing — a
 *  LyricFrameworkCard that somehow carries a `text`/`lines` field never reaches
 *  agent_memory_write at all. */
export async function saveLyricFrameworkCard(exec: ExecFn, card: LyricFrameworkCard): Promise<SaveCardResult> {
  const v = validateNoLyricText(card);
  if (!v.ok) return { ok: false, error: v.error };
  return writeAndConfirm(exec, "lyric_framework", card);
}
