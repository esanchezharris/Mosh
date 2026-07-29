// Plugin browser: engine built-ins (load_builtin) + scanned VST3/AU (load_plugin)
// onto the selected track. Filter + kind tabs, plus Favorites / Recent sections and
// vendor grouping. The list is windowed (only the visible rows are mounted) so an 800+
// AU machine stays smooth. All sectioning/grouping lives in the pure pluginBrowserUtil
// (unit-tested); this component is just glue.
//
// The list/filters are factored into PluginBrowserContent, which backs ONLY this
// classic modal — the v2 shell has its own picker surface (v2/PluginBrowser.tsx).
// What the two shells actually share lives in pluginBrowserUtil (entry shapes,
// sectioning/windowing, favorites/recents, loadPluginEntry) — that's the one
// place the load/filter behavior can drift.

import { useEffect, useMemo, useState } from "react";
import { useStore } from "../store";
import { useEscapeToClose } from "../hooks/useEscapeToClose";
import { useElementHeight } from "../hooks/useElementHeight";
import {
  builtinEntry, installedEntry, buildPluginRows, visibleRange,
  loadFavorites, toggleFavorite, loadPluginRecents, loadPluginEntry,
  type PluginEntry, type PluginKind,
} from "./pluginBrowserUtil";

const ROW_H = 46; // uniform height for headers + plugin rows (drives the windowing)

// The reusable inner surface: search + kind tabs + the windowed, sectioned list. Loads
// the catalog lazily on mount. `onLoaded` fires after a plugin lands (the modal closes;
// the drawer stays open).
export function PluginBrowserContent({ onLoaded }: { onLoaded?: () => void }) {
  const plugins = useStore((s) => s.availablePlugins);
  const builtins = useStore((s) => s.availableBuiltins);
  const selectedTrackId = useStore((s) => s.selectedTrackId);
  const exec = useStore((s) => s.exec);
  const ensureCatalog = useStore((s) => s.ensurePluginCatalog);

  const [q, setQ] = useState("");
  const [kind, setKind] = useState<PluginKind>("all");
  const [favorites, setFavorites] = useState<string[]>(() => loadFavorites());
  const [recents, setRecents] = useState<string[]>(() => loadPluginRecents());
  const [scrollTop, setScrollTop] = useState(0);
  // Scroll-viewport height, tracked so the window math stays accurate on resize.
  const { ref: listRef, height: viewportH } = useElementHeight<HTMLDivElement>(420);

  useEffect(() => { ensureCatalog(); }, [ensureCatalog]);

  const bEntries = useMemo(() => builtins.map(builtinEntry), [builtins]);
  const iEntries = useMemo(() => plugins.map(installedEntry), [plugins]);
  const rows = useMemo(
    () => buildPluginRows({ builtins: bEntries, installed: iEntries, favorites, recents, q, kind }),
    [bEntries, iEntries, favorites, recents, q, kind],
  );

  const { start, end } = visibleRange(scrollTop, viewportH, ROW_H, rows.length);
  const favSet = new Set(favorites);

  const load = (e: PluginEntry) => {
    if (!loadPluginEntry(e, selectedTrackId, exec)) return;
    setRecents(loadPluginRecents());
    onLoaded?.();
  };
  const toggleFav = (uid: string) => setFavorites(toggleFavorite(uid));

  return (
    <>
      <div className="modal-filters">
        <input autoFocus placeholder="Filter by name or vendor…" value={q} onChange={(e) => setQ(e.target.value)} />
        {(["all", "inst", "fx"] as const).map((k) => (
          <button key={k} className={`btn${kind === k ? " on" : ""}`} onClick={() => setKind(k)}>{k === "all" ? "All" : k === "inst" ? "Instruments" : "Effects"}</button>
        ))}
      </div>
      <div className="modal-list" ref={listRef} onScroll={(e) => setScrollTop(e.currentTarget.scrollTop)}>
        {rows.length === 0 ? (
          <div className="rack-empty">nothing matches “{q}”</div>
        ) : (
          <div className="vlist" style={{ height: rows.length * ROW_H, position: "relative" }}>
            {rows.slice(start, end).map((row, i) => {
              const idx = start + i;
              const style = { top: idx * ROW_H, height: ROW_H } as const;
              if (row.kind === "header")
                return (
                  <div key={row.key} className="pg-label vrow" style={style}>
                    {row.label} <span className="pg-count">{row.count}</span>
                  </div>
                );
              const e = row.entry;
              const fav = favSet.has(e.uid);
              return (
                <div key={row.key} className="plugin-row vrow" style={style}>
                  <button className="prow-load" onClick={() => load(e)} title={`Add ${e.name} to the selected track`}>
                    <span className="pr-name">{e.name}</span>
                    <span className="pr-meta">{e.meta}</span>
                  </button>
                  <button className={`pf-star${fav ? " on" : ""}`} aria-pressed={fav}
                    title={fav ? "Remove from favorites" : "Add to favorites"}
                    aria-label={fav ? `Unfavorite ${e.name}` : `Favorite ${e.name}`}
                    onClick={() => toggleFav(e.uid)}>{fav ? "★" : "☆"}</button>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </>
  );
}

export function PluginBrowser() {
  const open = useStore((s) => s.browserOpen);
  const close = useStore((s) => s.closeBrowser);
  const plugins = useStore((s) => s.availablePlugins);
  const counts = useStore((s) => s.pluginCounts);
  const rescan = useStore((s) => s.rescanPlugins);
  const scanProgress = useStore((s) => s.scanProgress);

  useEscapeToClose(open, close); // Esc dismisses, like the piano roll / popovers

  if (!open) return null;

  return (
    <div className="modal-backdrop" onClick={close} data-testid="plugin-browser">
      <div className="modal" role="dialog" aria-modal="true" aria-label="Add plugin" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <strong className="display">Add plugin</strong>
          <span className="pr-meta tc">{counts ? `${counts.vst3} VST3 · ${counts.au} AU` : `${plugins.length} installed`}</span>
          <button className="btn ghost" disabled={!!scanProgress}
            title="Re-scan installed VST3 plugins (out-of-process; hung plugins are quarantined)"
            onClick={() => void rescan("vst3")}>{scanProgress ? "Scanning…" : "Rescan"}</button>
          <button className="btn x" onClick={close}>✕</button>
        </div>
        {scanProgress && (
          <div className="scan-status" role="status" aria-live="polite">
            Scanning {scanProgress.format}…
            {typeof scanProgress.count === "number" ? ` ${scanProgress.count} found ·` : ""} out-of-process — hung
            plugins (e.g. WaveShell) are quarantined, not loaded.
          </div>
        )}
        <PluginBrowserContent onLoaded={close} />
      </div>
    </div>
  );
}
