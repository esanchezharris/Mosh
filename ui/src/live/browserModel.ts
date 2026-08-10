// The live browser's category model (SPEC §4): Live's left column is a fixed
// category list, the right column shows the selected category's results. Mosh's
// data sources map onto Live's categories — Sounds → built-in instrument presets,
// Drums → drum kits, Instruments → scanned instrument plugins, Audio Effects →
// effect plugins, Samples → the file listing, Places → (stub) Current Project.
//
// Pure + store-free so the mapping is unit-testable; Browser.tsx owns the fetching.

import type { AvailablePlugin, BuiltinPlugin, DirEntry } from "../types";

export type LiveBrowserCategory =
  | "sounds" | "drums" | "instruments" | "effects" | "samples" | "project";

// The two-column shape measured in SPEC §4: small-caps section headers, 17pt rows.
// "Collections"/Favorites is deliberately omitted: Mosh has no favourites store yet,
// and an empty category that can never fill is the kind of dead surface this
// programme removes. It lands with the data, not before.
export const LIVE_BROWSER_SECTIONS: {
  label: string;
  categories: { id: LiveBrowserCategory; label: string }[];
}[] = [
  {
    label: "Library",
    categories: [
      { id: "sounds", label: "Sounds" },
      { id: "drums", label: "Drums" },
      { id: "instruments", label: "Instruments" },
      { id: "effects", label: "Audio Effects" },
      { id: "samples", label: "Samples" },
    ],
  },
  {
    label: "Places",
    categories: [{ id: "project", label: "Current Project" }],
  },
];

export type LiveBrowserRowKind = "builtin" | "plugin" | "kit" | "sample" | "dir";

export type LiveBrowserRow = {
  /** Unique within a category — the kind prefix keeps a built-in and a VST3 that
   *  share a name from colliding as React keys. */
  id: string;
  name: string;
  kind: LiveBrowserRowKind;
  /** What the activation command needs: builtin type / plugin id / kit id / path. */
  payload: string;
  hint?: string;
  /** Plugin rows only: the catalog's isInstrument. Carried ON the row because the
   *  hot-swap decision (load_plugin's replaceInstrument) must not depend on a
   *  second id lookup succeeding — it drives an engine-visible semantic. */
  instrument?: boolean;
};

export type DrumKitInfo = { id: string; name: string; pads?: number; available?: boolean };

export type LiveBrowserSources = {
  builtins: BuiltinPlugin[];
  plugins: AvailablePlugin[];
  kits: DrumKitInfo[];
  entries: DirEntry[];
};

export function buildBrowserRows(
  cat: LiveBrowserCategory,
  src: LiveBrowserSources,
): LiveBrowserRow[] {
  switch (cat) {
    case "sounds":
      return src.builtins
        .filter((b) => b.isInstrument)
        .map((b) => ({ id: `builtin:${b.type}`, name: b.name, kind: "builtin" as const, payload: b.type, hint: b.category }));
    case "instruments":
      return src.plugins
        .filter((p) => p.isInstrument)
        .map((p) => ({ id: `plugin:${p.id}`, name: p.name, kind: "plugin" as const, payload: p.id, hint: p.manufacturer, instrument: true }));
    case "effects":
      return [
        ...src.builtins
          .filter((b) => !b.isInstrument)
          .map((b) => ({ id: `builtin:${b.type}`, name: b.name, kind: "builtin" as const, payload: b.type, hint: b.category })),
        ...src.plugins
          .filter((p) => !p.isInstrument)
          .map((p) => ({ id: `plugin:${p.id}`, name: p.name, kind: "plugin" as const, payload: p.id, hint: p.manufacturer, instrument: false })),
      ];
    case "drums":
      // `available !== false`: a kit the backend can't resolve stays listed but is
      // flagged unavailable — same posture as list_drum_kits' own contract.
      return src.kits
        .filter((k) => k.available !== false)
        .map((k) => ({
          id: `kit:${k.id}`, name: k.name, kind: "kit" as const, payload: k.id,
          hint: typeof k.pads === "number" ? `${k.pads} pads` : undefined,
        }));
    case "samples":
      // Directories first (they're navigation, not content), matching every file
      // browser the app already ships.
      return [...src.entries]
        .sort((a, b) => Number(b.isDir) - Number(a.isDir))
        .map((e) => ({
          id: `sample:${e.path}`, name: e.name,
          kind: (e.isDir ? "dir" : "sample") as LiveBrowserRowKind, payload: e.path,
        }));
    case "project":
      // Stub: per-project content (the current edit's own samples) has no snapshot
      // surface yet. The row list is honestly empty rather than re-listing the
      // global library under a second name.
      return [];
  }
}
