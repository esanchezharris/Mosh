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

const RECENTS_KEY = "mosh.recentSamples.v2";

export function importedFilePath(result: unknown): string | null {
  if (typeof result !== "object" || result === null || !("ok" in result)
    || result.ok !== true || !("data" in result) || typeof result.data !== "object"
    || result.data === null || !("file" in result.data) || typeof result.data.file !== "string") {
    return null;
  }
  return result.data.file;
}

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
