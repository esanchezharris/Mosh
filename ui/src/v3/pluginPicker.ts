// Pure data layer for the v2 two-pane plugin picker. Turns the unified plugin entries
// (built-ins + scanned VST3/AU, from the shared pluginBrowserUtil) into:
//   • a LEFT-RAIL collection list — All / Favorites / Recent / Instruments / Effects /
//     one row per vendor, each with a live count; and
//   • the RIGHT-PANE rows for whichever collection is selected (vendor-grouped for the
//     broad collections, flat-and-order-preserving for Favorites/Recent/a single vendor).
// All pure + unit-tested (pluginPicker.test.ts); the component is just glue + windowing.

import { type PluginEntry, type PluginRow, matchEntry, OTHER_VENDOR } from "../ui/pluginBrowserUtil";

export type CollectionId = string; // "all" | "fav" | "recent" | "inst" | "fx" | "v:<vendor>"
export type CollectionGroup = "top" | "kind" | "vendor";
export type Collection = { id: CollectionId; label: string; count: number; group: CollectionGroup };

const byName = (a: PluginEntry, b: PluginEntry) => a.name.localeCompare(b.name);
const vendorOrder = (a: string, b: string) =>
  a === b ? 0 : a === OTHER_VENDOR ? 1 : b === OTHER_VENDOR ? -1 : a.localeCompare(b);

/** The left-rail collections, in display order, each with a count (zero-count
 *  Favorites/Recent are omitted; All/Instruments/Effects always shown). */
export function buildCollections(a: {
  builtins: PluginEntry[]; installed: PluginEntry[]; favorites: string[]; recents: string[];
}): Collection[] {
  const all = [...a.builtins, ...a.installed];
  const present = new Set(all.map((e) => e.uid));
  const favSet = new Set(a.favorites);
  const favCount = a.favorites.filter((u) => present.has(u)).length;
  const recentCount = a.recents.filter((u) => !favSet.has(u) && present.has(u)).length;
  const inst = all.filter((e) => e.isInstrument).length;
  const fx = all.filter((e) => !e.isInstrument).length;

  const vmap = new Map<string, number>();
  for (const e of all) vmap.set(e.vendor, (vmap.get(e.vendor) ?? 0) + 1);
  const vendors: Collection[] = [...vmap.entries()]
    .sort((x, y) => vendorOrder(x[0], y[0]))
    .map(([v, c]) => ({ id: `v:${v}`, label: v, count: c, group: "vendor" }));

  const cols: Collection[] = [{ id: "all", label: "All Plugins", count: all.length, group: "top" }];
  if (favCount) cols.push({ id: "fav", label: "Favorites", count: favCount, group: "top" });
  if (recentCount) cols.push({ id: "recent", label: "Recent", count: recentCount, group: "top" });
  cols.push({ id: "inst", label: "Instruments", count: inst, group: "kind" });
  cols.push({ id: "fx", label: "Effects", count: fx, group: "kind" });
  cols.push(...vendors);
  return cols;
}

const flat = (list: PluginEntry[]): PluginRow[] =>
  list.map((e) => ({ kind: "plugin", key: `f:${e.uid}`, entry: e }));

function grouped(entries: PluginEntry[]): PluginRow[] {
  const m = new Map<string, PluginEntry[]>();
  for (const e of entries) { const a = m.get(e.vendor) ?? []; a.push(e); m.set(e.vendor, a); }
  const rows: PluginRow[] = [];
  for (const v of [...m.keys()].sort(vendorOrder)) {
    const list = [...m.get(v)!].sort(byName);
    rows.push({ kind: "header", key: `h:${v}`, label: v, count: list.length });
    for (const e of list) rows.push({ kind: "plugin", key: `${v}:${e.uid}`, entry: e });
  }
  return rows;
}

/** The right-pane rows for the selected collection, filtered by the search query.
 *  all/inst/fx → vendor-grouped (headers); fav/recent → order-preserving flat;
 *  v:<vendor> → that vendor, name-sorted flat. */
export function rowsForCollection(a: {
  builtins: PluginEntry[]; installed: PluginEntry[]; favorites: string[]; recents: string[];
  collection: CollectionId; q: string;
}): PluginRow[] {
  const all = [...a.builtins, ...a.installed];
  const byUid = new Map(all.map((e) => [e.uid, e]));
  const favSet = new Set(a.favorites);
  const c = a.collection;

  if (c === "fav")
    return flat(a.favorites.map((u) => byUid.get(u)).filter((e): e is PluginEntry => !!e && matchEntry(e, a.q, "all")));
  if (c === "recent")
    return flat(a.recents.filter((u) => !favSet.has(u)).map((u) => byUid.get(u)).filter((e): e is PluginEntry => !!e && matchEntry(e, a.q, "all")));
  if (c.startsWith("v:")) {
    const vendor = c.slice(2);
    return flat(all.filter((e) => e.vendor === vendor && matchEntry(e, a.q, "all")).sort(byName));
  }
  const kind = c === "inst" ? "inst" : c === "fx" ? "fx" : "all";
  return grouped(all.filter((e) => matchEntry(e, a.q, kind)));
}
