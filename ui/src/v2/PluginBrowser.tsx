// v2 plugin picker — ONE source of truth (usePluginPicker + PluginList), rendered two ways:
//   • PluginBrowser — the wide MODAL ("+ Plugin"): a left collection rail + the list.
//   • PluginDock    — the COMPACT dock (left browser, Plugins tab): the same collections as
//                     a horizontal chip row + the same list. A 218px rail won't fit a 336px
//                     dock, so the rail collapses to chips — same organization, narrow form.
// Both share collections/grouping (pluginPicker) + the windowed list, so they can't drift.
// Same command seam either way (load_builtin / load_plugin); the classic shell keeps its own.

import { useEffect, useMemo, useRef, useState } from "react";
import { useStore } from "../store";
import { useEscapeToClose } from "../hooks/useEscapeToClose";
import {
  builtinEntry, installedEntry, visibleRange,
  loadFavorites, toggleFavorite, loadPluginRecents, addPluginRecent,
  type PluginEntry,
} from "../ui/pluginBrowserUtil";
import { buildCollections, rowsForCollection, type CollectionId } from "./pluginPicker";

const ROW_H = 48; // uniform row/header height — drives the windowing math
const railIcon = (id: CollectionId) =>
  (id === "fav" ? "★" : id === "recent" ? "↻" : id === "inst" ? "♪" : id === "fx" ? "∿" : id === "all" ? "▦" : "");

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
    if (!selectedTrackId) return;
    if (e.loadKind === "builtin") void exec("load_builtin", { trackId: selectedTrackId, type: e.loadKey });
    else void exec("load_plugin", { trackId: selectedTrackId, pluginId: e.loadKey });
    addPluginRecent(e.uid);
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
  const [viewportH, setViewportH] = useState(420);
  const listRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = listRef.current; if (!el) return;
    const update = () => setViewportH(el.clientHeight);
    update();
    if (typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(update); ro.observe(el);
    return () => ro.disconnect();
  }, []);
  // Never land mid-list when the view changes (collection / query).
  useEffect(() => { setScrollTop(0); if (listRef.current) listRef.current.scrollTop = 0; }, [resetKey]);

  const { start, end } = visibleRange(scrollTop, viewportH, ROW_H, rows.length);
  return (
    <div className="v2-pb-list" ref={listRef} onScroll={(e) => setScrollTop(e.currentTarget.scrollTop)} data-testid="v2-pb-list">
      <div className="v2-pb-listhead">{activeLabel} <span>{rows.filter((r) => r.kind === "plugin").length}</span></div>
      {rows.length === 0 ? (
        <div className="v2-pb-empty">{emptyLabel}</div>
      ) : (
        <div className="v2-pb-vlist" style={{ height: rows.length * ROW_H, position: "relative" }}>
          {rows.slice(start, end).map((row, i) => {
            const idx = start + i;
            const style = { top: idx * ROW_H, height: ROW_H } as const;
            if (row.kind === "header")
              return (
                <div key={row.key} className="v2-pb-group" style={style}>
                  {row.label}<span className="v2-pb-group-count">{row.count}</span>
                </div>
              );
            const e = row.entry;
            const fav = favSet.has(e.uid);
            return (
              <div key={row.key} className="v2-pb-row" style={style}>
                <button className="v2-pb-add" data-testid="v2-pb-row" onClick={() => onLoad(e)} disabled={!selectedTrackId} title={selectedTrackId ? `Add ${e.name}` : "Select a track first"}>
                  <span className={`v2-pb-kind ${e.isInstrument ? "inst" : "fx"}`}>{e.isInstrument ? "INST" : "FX"}</span>
                  <span className="v2-pb-name">{e.name}</span>
                  <span className="v2-pb-meta">{e.meta}</span>
                </button>
                <button className={`v2-pb-star${fav ? " on" : ""}`} aria-pressed={fav}
                  title={fav ? "Remove from favorites" : "Add to favorites"}
                  aria-label={fav ? `Unfavorite ${e.name}` : `Favorite ${e.name}`}
                  onClick={() => onToggleFav(e.uid)}>{fav ? "★" : "☆"}</button>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

// ── COMPACT dock variant — collections as a chip row, then the shared list. ──
export function PluginDock() {
  const pk = usePluginPicker(); // no onLoaded → the dock stays open after adding (it's a dock)
  return (
    <div className="v2-pdock" data-testid="v2-plugin-dock">
      <div className="v2-pb-search v2-pdock-search">
        <span className="v2-pb-search-icon" aria-hidden>⌕</span>
        <input data-testid="v2-pb-search" placeholder="Search by name or vendor…" value={pk.q} onChange={(e) => pk.setQ(e.target.value)} />
      </div>
      <div className="v2-pdock-chips" role="tablist" aria-label="Plugin collections">
        {pk.collections.map((c) => (
          <button key={c.id} role="tab" aria-selected={pk.collection === c.id}
            className={`v2-pdock-chip${pk.collection === c.id ? " on" : ""}`}
            data-testid="v2-pb-collection" data-collection={c.id} onClick={() => pk.setCollection(c.id)}>
            {railIcon(c.id) && <span aria-hidden>{railIcon(c.id)}</span>}
            <span className="v2-pdock-chip-label">{c.label}</span>
            <span className="v2-pdock-chip-count">{c.count}</span>
          </button>
        ))}
      </div>
      <PluginList rows={pk.rows} favSet={pk.favSet} activeLabel={pk.activeLabel}
        emptyLabel={pk.q ? `Nothing matches “${pk.q}”.` : "No plugins here yet."}
        selectedTrackId={pk.selectedTrackId} onLoad={pk.load} onToggleFav={pk.toggleFav}
        resetKey={`${pk.collection}:${pk.q}`} />
    </div>
  );
}

// ── WIDE modal variant — a left collection rail + the shared list. ──
export function PluginBrowser() {
  const open = useStore((s) => s.browserOpen);
  const close = useStore((s) => s.closeBrowser);
  const counts = useStore((s) => s.pluginCounts);
  const plugins = useStore((s) => s.availablePlugins);
  const rescan = useStore((s) => s.rescanPlugins);
  const scanProgress = useStore((s) => s.scanProgress);
  const pk = usePluginPicker(close);

  useEscapeToClose(open, close);
  if (!open) return null;

  let prevGroup = "";
  return (
    <div className="v2-pb-backdrop" onClick={close} data-testid="plugin-browser">
      <div className="v2-pb" role="dialog" aria-modal="true" aria-label="Add plugin" data-testid="v2-pb" onClick={(e) => e.stopPropagation()}>
        <header className="v2-pb-head">
          <span className="v2-pb-title">Add plugin</span>
          <div className="v2-pb-search">
            <span className="v2-pb-search-icon" aria-hidden>⌕</span>
            <input autoFocus data-testid="v2-pb-search" placeholder="Search by name or vendor…" value={pk.q} onChange={(e) => pk.setQ(e.target.value)} />
          </div>
          <span className="v2-pb-count">{counts ? `${counts.vst3} VST3 · ${counts.au} AU` : `${plugins.length} installed`}</span>
          <button className="v2-pb-rescan" disabled={!!scanProgress}
            title="Re-scan installed VST3 plugins (out-of-process; hung plugins are quarantined)"
            onClick={() => void rescan("vst3")}>{scanProgress ? "Scanning…" : "Rescan"}</button>
          <button className="v2-pb-x" onClick={close} aria-label="Close">✕</button>
        </header>

        {scanProgress && (
          <div className="v2-pb-scan" role="status" aria-live="polite">
            Scanning {scanProgress.format}… out-of-process — hung plugins (e.g. WaveShell) are quarantined, not loaded.
          </div>
        )}
        {!pk.selectedTrackId && <div className="v2-pb-warn" role="note">Select a track first, then pick a plugin to add.</div>}

        <div className="v2-pb-body">
          <nav className="v2-pb-rail" role="tablist" aria-label="Plugin collections">
            {pk.collections.map((c) => {
              const sep = prevGroup && prevGroup !== c.group; prevGroup = c.group;
              return (
                <div key={c.id} className={sep ? "v2-pb-railsep" : undefined}>
                  <button
                    role="tab" aria-selected={pk.collection === c.id}
                    className={`v2-pb-coll${pk.collection === c.id ? " on" : ""} g-${c.group}`}
                    data-testid="v2-pb-collection" data-collection={c.id}
                    onClick={() => pk.setCollection(c.id)}
                  >
                    {railIcon(c.id) && <span className="v2-pb-coll-icon" aria-hidden>{railIcon(c.id)}</span>}
                    <span className="v2-pb-coll-label">{c.label}</span>
                    <span className="v2-pb-coll-count">{c.count}</span>
                  </button>
                </div>
              );
            })}
          </nav>

          <PluginList rows={pk.rows} favSet={pk.favSet} activeLabel={pk.activeLabel}
            emptyLabel={pk.q ? `Nothing matches “${pk.q}”.` : "No plugins here yet."}
            selectedTrackId={pk.selectedTrackId} onLoad={pk.load} onToggleFav={pk.toggleFav}
            resetKey={`${pk.collection}:${pk.q}`} />
        </div>
      </div>
    </div>
  );
}
