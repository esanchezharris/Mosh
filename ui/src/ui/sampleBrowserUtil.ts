// Pure helpers for the sample browser: type-to-filter + a recents list.
// No React, no store — unit-tested in isolation.

import type { DirEntry } from "../types";

/** Case-insensitive substring filter over entry names. Empty query → all. */
export function filterEntries(entries: DirEntry[], query: string): DirEntry[] {
  const q = query.trim().toLowerCase();
  if (!q) return entries;
  return entries.filter((e) => e.name.toLowerCase().includes(q));
}

/** Prepend a path to the recents list, dedupe, and cap at `max`. */
export function pushRecent(prev: string[], path: string, max = 8): string[] {
  return [path, ...prev.filter((p) => p !== path)].slice(0, max);
}

// Drag-to-arrange payload key — a browser row carries its file path under this
// MIME so an Arrange lane can accept the drop (and ignore unrelated drags).
export const SAMPLE_DND_MIME = "application/x-mosh-sample";

const RECENTS_KEY = "mosh.recentSamples";

/** Read the persisted recent-sample paths (newest first). */
export function loadRecents(): string[] {
  try {
    const raw = localStorage.getItem(RECENTS_KEY);
    const v = raw ? JSON.parse(raw) : [];
    return Array.isArray(v) ? (v as string[]) : [];
  } catch {
    return [];
  }
}

/** Record a just-used sample path and return the updated list. */
export function addRecentSample(path: string, max = 8): string[] {
  const next = pushRecent(loadRecents(), path, max);
  try { localStorage.setItem(RECENTS_KEY, JSON.stringify(next)); } catch { /* noop */ }
  return next;
}

// ── find_similar_sample (§1 drum match) result shaping — pure, unit-tested ─────
export type SimilarMatch = { path: string; distance: number; role_guess?: string; kind?: string };
export type SimilarResult = { available: boolean; matches: SimilarMatch[]; reason?: string };

/** Normalize the find_similar_sample command result.data into a typed shape.
 *  `available` defaults to true when the field is absent (a real ok result); it is false
 *  only when the backend explicitly reports unavailability (service / venv / index missing). */
export function parseSimilarResult(data: unknown): SimilarResult {
  const d = (data ?? {}) as Record<string, unknown>;
  const rawMatches = Array.isArray(d.matches) ? d.matches : [];
  const matches: SimilarMatch[] = rawMatches
    .map((m) => {
      const o = (m ?? {}) as Record<string, unknown>;
      return {
        path: String(o.path ?? ""),
        distance: typeof o.distance === "number" ? o.distance : Number(o.distance ?? 0),
        role_guess: o.role_guess != null ? String(o.role_guess) : undefined,
        kind: o.kind != null ? String(o.kind) : undefined,
      };
    })
    .filter((m) => m.path !== "");
  return {
    available: d.available !== false,
    matches,
    reason: d.reason != null ? String(d.reason) : undefined,
  };
}

/** Cosine distance (0 = identical … 2 = opposite) → a 0–100 similarity %, for display. */
export function similarityPct(distance: number): number {
  const sim = 1 - (Number.isFinite(distance) ? distance : 2) / 2;
  return Math.max(0, Math.min(100, Math.round(sim * 100)));
}
