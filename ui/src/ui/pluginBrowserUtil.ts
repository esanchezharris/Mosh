// Pure helpers for the plugin browser. Unify engine built-ins + scanned VST3/AU
// into one entry shape, then section them (Favorites · Recent · built-in category ·
// vendor), filter by query + kind, and flatten to a single uniform-height row list
// so the component can window-render only the visible slice (an 800+ AU machine
// must not mount 800 DOM nodes). Plus localStorage favorites + recents. No React,
// no store — unit-tested in isolation (pluginBrowserUtil.test.ts).

import type { AvailablePlugin, BuiltinPlugin } from "../types";

export type PluginKind = "all" | "inst" | "fx";

export type PluginEntry = {
  uid: string;                       // stable across sessions: "b:<type>" | "v:<id>"
  loadKind: "builtin" | "installed";
  loadKey: string;                   // builtin `type`, or installed plugin `id`
  name: string;
  isInstrument: boolean;
  vendor: string;                    // manufacturer (installed) | category (builtin)
  meta: string;                      // small grey descriptor line
};

export type PluginRow =
  | { kind: "header"; key: string; label: string; count: number }
  | { kind: "plugin"; key: string; entry: PluginEntry };

export const OTHER_VENDOR = "Other";

export function builtinEntry(b: BuiltinPlugin): PluginEntry {
  return {
    uid: `b:${b.type}`, loadKind: "builtin", loadKey: b.type, name: b.name,
    isInstrument: b.isInstrument, vendor: b.category || OTHER_VENDOR,
    meta: `${b.isInstrument ? "instrument" : "effect"} · built-in`,
  };
}

export function installedEntry(p: AvailablePlugin): PluginEntry {
  return {
    uid: `v:${p.id}`, loadKind: "installed", loadKey: p.id, name: p.name,
    isInstrument: p.isInstrument, vendor: (p.manufacturer || "").trim() || OTHER_VENDOR,
    meta: `${p.isInstrument ? "instrument" : "effect"} · ${p.format}${p.manufacturer ? ` · ${p.manufacturer}` : ""}`,
  };
}

/** True if the entry passes the kind tab + case-insensitive name/vendor query. */
export function matchEntry(e: PluginEntry, q: string, kind: PluginKind): boolean {
  if (kind === "inst" && !e.isInstrument) return false;
  if (kind === "fx" && e.isInstrument) return false;
  const needle = q.trim().toLowerCase();
  if (!needle) return true;
  return e.name.toLowerCase().includes(needle) || e.vendor.toLowerCase().includes(needle);
}

export type PluginMatch =
  | { readonly kind: "none" }
  | { readonly kind: "unique"; readonly entry: PluginEntry }
  | { readonly kind: "ambiguous"; readonly entries: readonly PluginEntry[] };

const normalizePluginText = (value: string): string =>
  value.normalize("NFKD").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();

function pluginMatchRank(entry: PluginEntry, query: string): number | null {
  const name = normalizePluginText(entry.name);
  const vendor = normalizePluginText(entry.vendor);
  const vendorThenName = `${vendor} ${name}`.trim();
  const nameThenVendor = `${name} ${vendor}`.trim();
  if (name === query) return 0;
  if (vendorThenName === query || nameThenVendor === query) return 1;
  if (name.startsWith(query) || vendorThenName.startsWith(query) || nameThenVendor.startsWith(query)) return 2;
  if (name.includes(query) || vendor.includes(query) || vendorThenName.includes(query)) return 3;
  return null;
}

/** Resolve producer text against the same entries the plug-in browser renders. */
export function resolvePluginMatch(entries: readonly PluginEntry[], rawQuery: string): PluginMatch {
  const query = normalizePluginText(rawQuery);
  if (!query) return { kind: "none" };

  const ranked = entries
    .map((entry) => ({ entry, rank: pluginMatchRank(entry, query) }))
    .filter((candidate): candidate is { readonly entry: PluginEntry; readonly rank: number } =>
      candidate.rank !== null)
    .sort((left, right) =>
      left.rank - right.rank
      || left.entry.name.localeCompare(right.entry.name)
      || left.entry.vendor.localeCompare(right.entry.vendor)
      || left.entry.meta.localeCompare(right.entry.meta)
      || left.entry.uid.localeCompare(right.entry.uid));
  const bestRank = ranked[0]?.rank;
  if (bestRank === undefined) return { kind: "none" };
  const best = ranked.filter((candidate) => candidate.rank === bestRank).map((candidate) => candidate.entry);
  const only = best[0];
  if (best.length === 1 && only) return { kind: "unique", entry: only };
  return { kind: "ambiguous", entries: best.slice(0, 5) };
}

const byName = (a: PluginEntry, b: PluginEntry) => a.name.localeCompare(b.name);

// "Other" always sorts last; everything else alphabetical.
function vendorOrder(a: string, b: string): number {
  if (a === b) return 0;
  if (a === OTHER_VENDOR) return 1;
  if (b === OTHER_VENDOR) return -1;
  return a.localeCompare(b);
}

function groupByVendor(entries: PluginEntry[]): Array<[string, PluginEntry[]]> {
  const m = new Map<string, PluginEntry[]>();
  for (const e of entries) { const a = m.get(e.vendor) ?? []; a.push(e); m.set(e.vendor, a); }
  return [...m.entries()]
    .map(([v, list]) => [v, [...list].sort(byName)] as [string, PluginEntry[]])
    .sort((x, y) => vendorOrder(x[0], y[0]));
}

/**
 * Flatten built-ins + installed into a sectioned, filtered row list:
 *   Favorites → Recent → built-in categories → installed vendors.
 * Favorites/recents reference entries by uid; recents exclude anything already
 * pinned as a favorite (no duplicate rows). Returns plain data only.
 */
export function buildPluginRows(args: {
  builtins: PluginEntry[];
  installed: PluginEntry[];
  favorites: string[];
  recents: string[];
  q: string;
  kind: PluginKind;
}): PluginRow[] {
  const { builtins, installed, favorites, recents, q, kind } = args;
  const all = [...builtins, ...installed];
  const byUid = new Map(all.map((e) => [e.uid, e]));
  const pass = (e: PluginEntry) => matchEntry(e, q, kind);

  const rows: PluginRow[] = [];
  const section = (label: string, list: PluginEntry[]) => {
    if (list.length === 0) return;
    rows.push({ kind: "header", key: `h:${label}`, label, count: list.length });
    for (const e of list) rows.push({ kind: "plugin", key: `${label}:${e.uid}`, entry: e });
  };

  const favSet = new Set(favorites);
  const favList = favorites.map((u) => byUid.get(u)).filter((e): e is PluginEntry => !!e && pass(e));
  const recentList = recents
    .filter((u) => !favSet.has(u))
    .map((u) => byUid.get(u)).filter((e): e is PluginEntry => !!e && pass(e));

  section("Favorites", favList);
  section("Recent", recentList);
  for (const [cat, list] of groupByVendor(builtins.filter(pass))) section(cat, list);
  for (const [vendor, list] of groupByVendor(installed.filter(pass))) section(vendor, list);
  return rows;
}

/**
 * Dispatch the right load command for an entry — built-ins and installed plugins
 * load via different commands with different arg shapes — and record the entry in
 * the recents list. No-op (returns false) when no track is selected. Shared by the
 * classic modal (PluginBrowser.tsx) and the v2 picker (v2/PluginBrowser.tsx) so the
 * command dispatch cannot drift between shells; callers keep their own UI reactions
 * (refresh recents state, close-on-load).
 */
export function loadPluginEntry(
  entry: PluginEntry,
  trackId: string | null,
  exec: (command: string, args?: Record<string, unknown>) => unknown,
): boolean {
  if (!trackId) return false;
  if (entry.loadKind === "builtin") void exec("load_builtin", { trackId, type: entry.loadKey });
  else void exec("load_plugin", { trackId, pluginId: entry.loadKey });
  addPluginRecent(entry.uid);
  return true;
}

export async function loadPluginEntryToTracks(
  entry: PluginEntry,
  trackIds: readonly string[],
  exec: (command: string, args?: Record<string, unknown>) => Promise<{ readonly ok: boolean }>,
  isCurrent: () => boolean = () => true,
): Promise<boolean> {
  const targets = [...new Set(trackIds)];
  if (targets.length === 0) return false;
  for (const trackId of targets) {
    if (!isCurrent()) return false;
    let result: { readonly ok: boolean };
    try {
      result = entry.loadKind === "builtin"
        ? await exec("load_builtin", { trackId, type: entry.loadKey })
        : await exec("load_plugin", { trackId, pluginId: entry.loadKey });
    } catch {
      return false;
    }
    if (!result.ok || !isCurrent()) return false;
  }
  addPluginRecent(entry.uid);
  return true;
}

/** Dispatch an entry onto the session master bus and record it in recents. */
export function loadMasterPluginEntry(
  entry: PluginEntry,
  exec: (command: string, args?: Record<string, unknown>) => unknown,
): boolean {
  if (entry.loadKind === "builtin") void exec("load_master_builtin", { type: entry.loadKey });
  else void exec("load_master_plugin", { pluginId: entry.loadKey });
  addPluginRecent(entry.uid);
  return true;
}

/** Window math: which row indices to mount for a given scroll position. */
export function visibleRange(
  scrollTop: number, viewportH: number, rowH: number, count: number, overscan = 6,
): { start: number; end: number } {
  if (rowH <= 0 || count <= 0) return { start: 0, end: 0 };
  const start = Math.max(0, Math.floor(scrollTop / rowH) - overscan);
  const end = Math.min(count, Math.ceil((scrollTop + viewportH) / rowH) + overscan);
  return { start, end: Math.max(start, end) };
}

// ── localStorage: favorites (a Set of uids) + recents (newest-first uid list) ──
const FAV_KEY = "mosh.pluginFavorites";
const RECENT_KEY = "mosh.recentPlugins";

function readList(key: string): string[] {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(key) || "[]");
    return Array.isArray(value) && value.every((item) => typeof item === "string") ? value : [];
  }
  catch { return []; }
}
function writeList(key: string, v: string[]): void {
  try { localStorage.setItem(key, JSON.stringify(v)); } catch { return; }
}

export function loadFavorites(): string[] { return readList(FAV_KEY); }
export function toggleFavorite(uid: string): string[] {
  const cur = loadFavorites();
  const next = cur.includes(uid) ? cur.filter((u) => u !== uid) : [uid, ...cur];
  writeList(FAV_KEY, next);
  return next;
}

export function loadPluginRecents(): string[] { return readList(RECENT_KEY); }
export function addPluginRecent(uid: string, max = 8): string[] {
  const next = [uid, ...loadPluginRecents().filter((u) => u !== uid)].slice(0, max);
  writeList(RECENT_KEY, next);
  return next;
}
