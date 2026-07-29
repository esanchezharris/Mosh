// v2 plugin picker — ONE surface. There is no plugin MODAL in v2: the left browser
// drawer's Plugins tab IS the plugin browser, and "+ Plugin" (the FX rack) opens it via
// shellState.openBrowserTab("plugins"). This file exports that compact dock plus the
// shared picker internals it's built from:
//   • usePluginPicker — collections/grouping (pluginPicker) + search + favorites + load.
//   • PluginList      — the windowed, vendor-grouped list.
//   • PluginDock      — the dock: collection CHIPS over the shared list (a 336px dock
//                       can't fit a wide rail, so collections collapse to a chip row).
// Same command seam as ever (load_builtin / load_plugin); the classic shell keeps its
// own modal (ui/PluginBrowser.tsx) — untouched.

import { useEffect, useMemo, useState } from "react";
import { useStore } from "../store";
import { useSettings } from "../settings/store";
import { useElementHeight } from "../hooks/useElementHeight";
import {
  builtinEntry, installedEntry, visibleRange,
  loadFavorites, toggleFavorite, loadPluginRecents, loadPluginEntry,
  type PluginEntry,
} from "../ui/pluginBrowserUtil";
import { buildCollections, rowsForCollection, type CollectionGroup, type CollectionId } from "./pluginPicker";

const ROW_H = 48; // uniform row/header height — drives the windowing math
const collectionGroupOrder: CollectionGroup[] = ["top", "kind", "vendor"];
const collectionGroupLabel: Record<CollectionGroup, string> = {
  top: "Browse",
  kind: "Type",
  vendor: "Maker",
};

type Rows = ReturnType<typeof rowsForCollection>;

// Shared state/logic — collections, search, rows, favorites, loading. The modal + the dock
// each get their own instance (separate surfaces) but identical behavior.
function usePluginPicker(onLoaded?: () => void) {
  const plugins = useStore((s) => s.availablePlugins);
  const builtins = useStore((s) => s.availableBuiltins);
  const selectedTrackId = useStore((s) => s.selectedTrackId);
  const exec = useStore((s) => s.exec);
  const ensureCatalog = useStore((s) => s.ensurePluginCatalog);

  const [q, setQ] = useState("");
  const [collection, setCollection] = useState<CollectionId>("all");
  const [favorites, setFavorites] = useState<string[]>(() => loadFavorites());
  const [recents, setRecents] = useState<string[]>(() => loadPluginRecents());

  useEffect(() => { ensureCatalog(); }, [ensureCatalog]); // lazy-load the catalog on first mount

  // Built-ins ship their category as "vendor"; collapse them under one "Built-in" maker so
  // they don't collide with the Instruments/Effects kind collections.
  const bEntries = useMemo(() => builtins.map((b) => ({ ...builtinEntry(b), vendor: "Built-in" })), [builtins]);
  const iEntries = useMemo(() => plugins.map(installedEntry), [plugins]);
  const collections = useMemo(
    () => buildCollections({ builtins: bEntries, installed: iEntries, favorites, recents }),
    [bEntries, iEntries, favorites, recents],
  );
  const activeId = collections.some((c) => c.id === collection) ? collection : "all";
  const rows = useMemo(
    () => rowsForCollection({ builtins: bEntries, installed: iEntries, favorites, recents, collection: activeId, q }),
    [bEntries, iEntries, favorites, recents, activeId, q],
  );
  const favSet = useMemo(() => new Set(favorites), [favorites]);
  const activeLabel = collections.find((c) => c.id === activeId)?.label ?? "All Plugins";

  const load = (e: PluginEntry) => {
    if (!loadPluginEntry(e, selectedTrackId, exec)) return;
    setRecents(loadPluginRecents());
    onLoaded?.();
  };
  const toggleFav = (uid: string) => setFavorites(toggleFavorite(uid));

  return { q, setQ, collection: activeId, setCollection, collections, rows, favSet, activeLabel, load, toggleFav, selectedTrackId };
}

// The windowed, vendor-grouped list — shared verbatim by the modal + the dock.
function PluginList({ rows, favSet, activeLabel, emptyLabel, selectedTrackId, onLoad, onToggleFav, resetKey }: {
  rows: Rows; favSet: Set<string>; activeLabel: string; emptyLabel: string;
  selectedTrackId: string | null; onLoad: (e: PluginEntry) => void; onToggleFav: (uid: string) => void; resetKey: string;
}) {
  const [scrollTop, setScrollTop] = useState(0);
  // Scroll-viewport height, tracked so the window math stays accurate on resize.
  const { ref: listRef, height: viewportH } = useElementHeight<HTMLDivElement>(420);
  // Never land mid-list when the view changes (collection / query).
  useEffect(() => { setScrollTop(0); if (listRef.current) listRef.current.scrollTop = 0; }, [resetKey]);

  const { start, end } = visibleRange(scrollTop, viewportH, ROW_H, rows.length);
  return (
    <div className="v2-pb-list" ref={listRef} onScroll={(e) => setScrollTop(e.currentTarget.scrollTop)} data-testid="v2-pb-list">
      <div className="v2-pb-listhead">
        <div className="v2-pb-listhead-copy" style={{ display: "flex", flex: "1 1 auto", flexDirection: "column", minWidth: 0, gap: 2 }}>
          <strong className="v2-pb-listhead-label">{activeLabel}</strong>
          <span className="v2-pb-listhead-note">
            {selectedTrackId ? "Load onto the selected track." : "Select a track to load a plugin."}
          </span>
        </div>
        <span className="v2-pb-listhead-count">{rows.filter((r) => r.kind === "plugin").length} results</span>
      </div>
      {rows.length === 0 ? (
        <div className="v2-pb-empty" role="status" aria-live="polite">{emptyLabel}</div>
      ) : (
        <div className="v2-pb-vlist" style={{ height: rows.length * ROW_H, position: "relative" }}>
          {rows.slice(start, end).map((row, i) => {
            const idx = start + i;
            const style = { top: idx * ROW_H, height: ROW_H } as const;
            if (row.kind === "header")
              return (
                <div key={row.key} className="v2-pb-group" style={style}>
                  <span className="v2-pb-group-label">{row.label}</span>
                  <span className="v2-pb-group-count">{row.count}</span>
                </div>
              );
            const e = row.entry;
            const fav = favSet.has(e.uid);
            return (
              <div key={row.key} className="v2-pb-row" style={style}>
                <button
                  className="v2-pb-add"
                  data-testid="v2-pb-row"
                  onClick={() => onLoad(e)}
                  disabled={!selectedTrackId}
                  title={selectedTrackId ? `Add ${e.name}` : "Select a track first"}
                >
                  <span className={`v2-pb-kind ${e.isInstrument ? "inst" : "fx"}`}>{e.isInstrument ? "INST" : "FX"}</span>
                  <span className="v2-pb-copy" style={{ display: "flex", flex: "1 1 auto", flexDirection: "column", minWidth: 0, gap: 2 }}>
                    <span className="v2-pb-name">{e.name}</span>
                    <span className="v2-pb-meta">{e.meta}</span>
                  </span>
                  <span className="v2-pb-action-label">{selectedTrackId ? "Load" : "Track first"}</span>
                </button>
                <button
                  className={`v2-pb-star${fav ? " on" : ""}`}
                  style={{ width: fav ? 52 : 44 }}
                  aria-pressed={fav}
                  title={fav ? "Remove from favorites" : "Add to favorites"}
                  aria-label={fav ? `Unfavorite ${e.name}` : `Favorite ${e.name}`}
                  onClick={() => onToggleFav(e.uid)}
                >
                  <span className="v2-pb-star-label">{fav ? "Saved" : "Save"}</span>
                </button>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

// ── The dock — collections as a chip row, then the shared list. The one v2 plugin surface. ──
export function PluginDock() {
  const pk = usePluginPicker(); // no onLoaded → the dock stays open after adding (it's a dock)
  // FIT-003 — v2 previously had ZERO rescan control and no progress UI at all (the
  // classic modal already had both). This brings the default shell to parity: a
  // compact Rescan button + a live indeterminate progress line while scanning.
  //
  // AUD-SCAN — that Rescan was VST3-only and AU was reachable ONLY via the MOSH_SCAN_AU
  // env var, which nothing in the shipped app ever sets. So on a Mac, where plenty of
  // instruments ship AU-only, the browser could never show them and gave no hint why.
  // The checkbox is the opt-in (persisted, off by default so first scan stays fast);
  // ticking it widens the sweep to "all" and passes the backend's `allowAU` gate.
  const rescan = useStore((s) => s.rescanPlugins);
  const scanProgress = useStore((s) => s.scanProgress);
  const scanAU = useSettings((s) => s.get("scanAudioUnits")) as boolean;
  const setSetting = useSettings((s) => s.set);
  const collectionSections = useMemo(
    () =>
      collectionGroupOrder
        .map((group) => ({ group, items: pk.collections.filter((c) => c.group === group) }))
        .filter((section) => section.items.length > 0),
    [pk.collections],
  );

  return (
    <div className="v2-pdock" data-testid="v2-plugin-dock">
      <div className="v2-pdock-intro">
        <div className="v2-pdock-copy">
          <strong className="v2-pdock-title">Plugins</strong>
          <span className="v2-pdock-subtitle">Search collections and load onto the selected track.</span>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 6, flex: "0 0 auto" }}>
          <label className="v2-pdock-au" title="Include AudioUnit plugins in the scan. Slower than VST3; a hung component is killed and quarantined automatically.">
            <input
              type="checkbox"
              data-testid="v2-pb-scan-au"
              checked={scanAU}
              disabled={!!scanProgress}
              onChange={(e) => setSetting("scanAudioUnits", e.target.checked)}
            />
            <span>Audio Units</span>
          </label>
          <button
            className="btn"
            data-testid="v2-pb-rescan"
            disabled={!!scanProgress}
            title={scanAU
              ? "Re-scan installed VST3 and AudioUnit plugins (out-of-process; hung plugins are quarantined)"
              : "Re-scan installed VST3 plugins (out-of-process; hung plugins are quarantined)"}
            onClick={() => void rescan(scanAU ? "all" : "vst3", scanAU)}
          >
            {scanProgress ? "Scanning…" : "Rescan"}
          </button>
          <span className="v2-pdock-selected">{pk.selectedTrackId ? "Track ready" : "Select a track first"}</span>
        </div>
      </div>
      {scanProgress && (
        <div className="v2-pdock-scan-status" data-testid="v2-pb-scan-status" role="status" aria-live="polite">
          Scanning {scanProgress.format}
          {typeof scanProgress.count === "number" ? ` — ${scanProgress.count} found` : ""}
          {typeof scanProgress.elapsedMs === "number" ? ` · ${(scanProgress.elapsedMs / 1000).toFixed(1)}s` : ""}
        </div>
      )}
      <label className="v2-pb-search v2-pdock-search">
        <span className="v2-pb-search-label">Search</span>
        <input
          data-testid="v2-pb-search"
          aria-label="Search plugins"
          placeholder="Search by name or vendor..."
          value={pk.q}
          onChange={(e) => pk.setQ(e.target.value)}
        />
      </label>
      <div className="v2-pdock-chips" role="tablist" aria-label="Plugin collections">
        {collectionSections.map((section) => (
          <div key={section.group} className="v2-pdock-chip-group" style={{ display: "flex", alignItems: "center", gap: 6 }}>
            <span className="v2-pdock-chip-group-label">{collectionGroupLabel[section.group]}</span>
            {section.items.map((c) => (
              <button
                key={c.id}
                role="tab"
                aria-selected={pk.collection === c.id}
                className={`v2-pdock-chip${pk.collection === c.id ? " on" : ""}`}
                data-testid="v2-pb-collection"
                data-collection={c.id}
                onClick={() => pk.setCollection(c.id)}
              >
                <span className="v2-pdock-chip-label">{c.label}</span>
                <span className="v2-pdock-chip-count">{c.count}</span>
              </button>
            ))}
          </div>
        ))}
      </div>
      <PluginList rows={pk.rows} favSet={pk.favSet} activeLabel={pk.activeLabel}
        emptyLabel={pk.q ? `Nothing matches "${pk.q}".` : "No plugins here yet."}
        selectedTrackId={pk.selectedTrackId} onLoad={pk.load} onToggleFav={pk.toggleFav}
        resetKey={`${pk.collection}:${pk.q}`} />
    </div>
  );
}
