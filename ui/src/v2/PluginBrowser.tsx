// v2 plugin picker — a two-pane modal that replaces the classic single-column list.
// LEFT: a collection rail (All · Favorites · Recent · Instruments · Effects · vendors),
// each with a count. RIGHT: a search box + the selected collection's plugins, vendor-
// grouped for the broad collections and windowed so an 800+ AU machine stays smooth.
// Pure sectioning/filtering lives in pluginPicker + the shared pluginBrowserUtil; this is
// glue. Same command seam as the classic browser (load_builtin / load_plugin) — the
// classic shell keeps its own component, so this is additive.

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

export function PluginBrowser() {
  const open = useStore((s) => s.browserOpen);
  const close = useStore((s) => s.closeBrowser);
  const plugins = useStore((s) => s.availablePlugins);
  const builtins = useStore((s) => s.availableBuiltins);
  const counts = useStore((s) => s.pluginCounts);
  const selectedTrackId = useStore((s) => s.selectedTrackId);
  const exec = useStore((s) => s.exec);
  const rescan = useStore((s) => s.rescanPlugins);
  const scanProgress = useStore((s) => s.scanProgress);

  const [q, setQ] = useState("");
  const [collection, setCollection] = useState<CollectionId>("all");
  const [favorites, setFavorites] = useState<string[]>([]);
  const [recents, setRecents] = useState<string[]>([]);
  const [scrollTop, setScrollTop] = useState(0);
  const [viewportH, setViewportH] = useState(480);
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    setFavorites(loadFavorites());
    setRecents(loadPluginRecents());
    setQ(""); setCollection("all"); setScrollTop(0);
  }, [open]);

  useEffect(() => {
    const el = listRef.current; if (!el) return;
    const update = () => setViewportH(el.clientHeight);
    update();
    if (typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(update); ro.observe(el);
    return () => ro.disconnect();
  }, [open]);

  // Reset the scroll when the view changes so you never land mid-list.
  useEffect(() => { setScrollTop(0); if (listRef.current) listRef.current.scrollTop = 0; }, [collection, q]);

  useEscapeToClose(open, close);

  // Built-ins ship their category as "vendor"; in the two-pane rail that collides with
  // the Instruments/Effects KIND filters, so group them all under one "Built-in" maker.
  const bEntries = useMemo(() => builtins.map((b) => ({ ...builtinEntry(b), vendor: "Built-in" })), [builtins]);
  const iEntries = useMemo(() => plugins.map(installedEntry), [plugins]);
  const collections = useMemo(
    () => buildCollections({ builtins: bEntries, installed: iEntries, favorites, recents }),
    [bEntries, iEntries, favorites, recents],
  );
  // The selected collection may vanish (e.g. a vendor filtered out after rescan) → All.
  const activeId = collections.some((c) => c.id === collection) ? collection : "all";
  const rows = useMemo(
    () => rowsForCollection({ builtins: bEntries, installed: iEntries, favorites, recents, collection: activeId, q }),
    [bEntries, iEntries, favorites, recents, activeId, q],
  );

  if (!open) return null;

  const { start, end } = visibleRange(scrollTop, viewportH, ROW_H, rows.length);
  const favSet = new Set(favorites);
  const activeLabel = collections.find((c) => c.id === activeId)?.label ?? "All Plugins";

  const load = (e: PluginEntry) => {
    if (!selectedTrackId) return;
    if (e.loadKind === "builtin") void exec("load_builtin", { trackId: selectedTrackId, type: e.loadKey });
    else void exec("load_plugin", { trackId: selectedTrackId, pluginId: e.loadKey });
    addPluginRecent(e.uid);
    close();
  };
  const toggleFav = (uid: string) => setFavorites(toggleFavorite(uid));

  const railIcon = (id: CollectionId) => (id === "fav" ? "★" : id === "recent" ? "↻" : id === "inst" ? "♪" : id === "fx" ? "∿" : id === "all" ? "▦" : "");

  let prevGroup = "";
  return (
    <div className="v2-pb-backdrop" onClick={close} data-testid="plugin-browser">
      <div className="v2-pb" role="dialog" aria-modal="true" aria-label="Add plugin" data-testid="v2-pb" onClick={(e) => e.stopPropagation()}>
        <header className="v2-pb-head">
          <span className="v2-pb-title">Add plugin</span>
          <div className="v2-pb-search">
            <span className="v2-pb-search-icon" aria-hidden>⌕</span>
            <input autoFocus data-testid="v2-pb-search" placeholder="Search by name or vendor…" value={q} onChange={(e) => setQ(e.target.value)} />
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
        {!selectedTrackId && <div className="v2-pb-warn" role="note">Select a track first, then pick a plugin to add.</div>}

        <div className="v2-pb-body">
          <nav className="v2-pb-rail" role="tablist" aria-label="Plugin collections">
            {collections.map((c) => {
              const sep = prevGroup && prevGroup !== c.group; prevGroup = c.group;
              return (
                <div key={c.id} className={sep ? "v2-pb-railsep" : undefined}>
                  <button
                    role="tab" aria-selected={activeId === c.id}
                    className={`v2-pb-coll${activeId === c.id ? " on" : ""} g-${c.group}`}
                    data-testid="v2-pb-collection" data-collection={c.id}
                    onClick={() => setCollection(c.id)}
                  >
                    {railIcon(c.id) && <span className="v2-pb-coll-icon" aria-hidden>{railIcon(c.id)}</span>}
                    <span className="v2-pb-coll-label">{c.label}</span>
                    <span className="v2-pb-coll-count">{c.count}</span>
                  </button>
                </div>
              );
            })}
          </nav>

          <div className="v2-pb-list" ref={listRef} onScroll={(e) => setScrollTop(e.currentTarget.scrollTop)} data-testid="v2-pb-list">
            <div className="v2-pb-listhead">{activeLabel} <span>{rows.filter((r) => r.kind === "plugin").length}</span></div>
            {rows.length === 0 ? (
              <div className="v2-pb-empty">{q ? `Nothing matches “${q}”.` : "No plugins here yet."}</div>
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
                      <button className="v2-pb-add" data-testid="v2-pb-row" onClick={() => load(e)} disabled={!selectedTrackId} title={selectedTrackId ? `Add ${e.name}` : "Select a track first"}>
                        <span className={`v2-pb-kind ${e.isInstrument ? "inst" : "fx"}`}>{e.isInstrument ? "INST" : "FX"}</span>
                        <span className="v2-pb-name">{e.name}</span>
                        <span className="v2-pb-meta">{e.meta}</span>
                      </button>
                      <button className={`v2-pb-star${fav ? " on" : ""}`} aria-pressed={fav}
                        title={fav ? "Remove from favorites" : "Add to favorites"}
                        aria-label={fav ? `Unfavorite ${e.name}` : `Favorite ${e.name}`}
                        onClick={() => toggleFav(e.uid)}>{fav ? "★" : "☆"}</button>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
