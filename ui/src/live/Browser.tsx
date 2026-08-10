// The live browser (SPEC §4) — Live's two-column left dock, ~338pt: a fixed category
// list (109pt) + the selected category's results. The category→data mapping lives in
// browserModel.ts (pure, unit-tested); this component owns the fetching and the
// activation commands. Everything routes through the existing catalogs slice /
// commands — ensurePluginCatalog, list_drum_kits, list_directory, load_builtin,
// load_plugin, load_drum_kit, audition_file, import_clip — so the seam stays the
// only mutation path.
//
// Rows: click activates (loads onto the selected track / auditions a sample), sample
// rows are ALSO draggable onto a lane (SAMPLE_DND_MIME — the same payload the classic
// SampleBrowser sets; the live lanes' drop handler imports at the drop point).
// Known v1 gap: no filter chips / search field inside the results column yet.

import { useEffect, useState } from "react";
import { useStore } from "../store";
import { useSettings } from "../settings/store";
import { MoshTip } from "../chrome/Tooltip";
import { SAMPLE_DND_MIME } from "../ui/sampleBrowserUtil";
import type { DirListing } from "../types";
import { IconDrum, IconFolder, IconLayers, IconWaveform } from "../ui/icons";
import {
  buildBrowserRows, LIVE_BROWSER_SECTIONS,
  type DrumKitInfo, type LiveBrowserCategory, type LiveBrowserRow,
} from "./browserModel";

export function Browser() {
  const exec = useStore((s) => s.exec);
  const refresh = useStore((s) => s.refresh);
  const selectedTrackId = useStore((s) => s.selectedTrackId);
  const setSelectedTrack = useStore((s) => s.setSelectedTrack);
  const ensurePluginCatalog = useStore((s) => s.ensurePluginCatalog);
  const builtins = useStore((s) => s.availableBuiltins);
  const plugins = useStore((s) => s.availablePlugins);
  // INS-005 / AUD-SCAN — the deep sweep's lifecycle + the AU opt-in, same store slice
  // and settings key the v2 plugin dock drives.
  const rescanPlugins = useStore((s) => s.rescanPlugins);
  const scanProgress = useStore((s) => s.scanProgress);
  const scanAU = useSettings((s) => s.get("scanAudioUnits")) as boolean;
  const setSetting = useSettings((s) => s.set);

  const [cat, setCat] = useState<LiveBrowserCategory>("sounds");
  const [kits, setKits] = useState<DrumKitInfo[]>([]);
  const [listing, setListing] = useState<DirListing | null>(null);
  const [auditioning, setAuditioning] = useState<string | null>(null);
  // Load feedback — a click used to be a silent no-op when no track was selected.
  // Every load now lands somewhere (select-then-load) and SAYS where, here.
  const [hint, setHint] = useState<string | null>(null);
  // ⌘F search (menus.json: View → Search in Browser). A non-empty query switches the
  // results column from "selected category" to a cross-category filter; Esc clears.
  const [query, setQuery] = useState("");
  // The selected row (Live's browser: single-click SELECTS — with audition for
  // samples — and DOUBLE-click loads). Loading on a bare click was how an accidental
  // bump stacked four Serums on one track.
  const [selRow, setSelRow] = useState<string | null>(null);

  // Lazy catalogs, on mount — the same first-use posture the v2 drawer takes
  // (never at app init: execute_command runs on the UI thread).
  useEffect(() => { ensurePluginCatalog(); }, [ensurePluginCatalog]);
  useEffect(() => {
    void exec("list_drum_kits").then((r) => {
      if (r.ok && r.data) setKits((r.data as { kits: DrumKitInfo[] }).kits);
    });
  }, [exec]);
  // Samples are a directory listing; fetched when the category is first opened and
  // re-fetched on navigation (dirs navigate in place, like Live's Places).
  useEffect(() => {
    if (cat !== "samples" || listing) return;
    void exec("list_directory", {}).then((r) => {
      if (r.ok && r.data) setListing(r.data as DirListing);
    });
  }, [cat, listing, exec]);
  // A playing preview never outlives the browser.
  useEffect(() => () => { void exec("stop_audition"); }, [exec]);

  const rows = buildBrowserRows(cat, { builtins, plugins, kits, entries: listing?.entries ?? [] });

  // Cross-category filter: every category's rows, name-matched case-insensitively,
  // with the hint column repurposed to name the category a hit came from. The
  // Samples category only contributes once its listing has been fetched — a search
  // triggers that fetch (the listing is lazy everywhere else in the app too).
  const q = query.trim().toLowerCase();
  const searchRows = !q ? [] : LIVE_BROWSER_SECTIONS
    .flatMap((s) => s.categories)
    .flatMap((c) => buildBrowserRows(c.id, { builtins, plugins, kits, entries: listing?.entries ?? [] })
      .filter((r) => r.name.toLowerCase().includes(q))
      .map((r) => ({ ...r, hint: c.label })));
  const shownRows = q ? searchRows : rows;
  useEffect(() => {
    if (!q || listing) return;
    void exec("list_directory", {}).then((r) => {
      if (r.ok && r.data) setListing(r.data as DirListing);
    });
  }, [q, listing, exec]);

  const navigate = async (path?: string) => {
    const r = await exec("list_directory", path ? { path } : {});
    if (r.ok && r.data) setListing(r.data as DirListing);
  };

  // The track a load lands on: the selected one, else the FIRST track (select-then-
  // load — a click that silently does nothing was the owner's #1 complaint's other
  // half). null only when the session has no tracks at all.
  const loadTarget = () => {
    const tracks = useStore.getState().snapshot?.tracks ?? [];
    const selected = tracks.find((t) => t.id === selectedTrackId);
    return selected ?? tracks[0] ?? null;
  };
  const loadOnto = async (row: LiveBrowserRow, command: string, args: Record<string, unknown>) => {
    const target = loadTarget();
    if (!target) { setHint("Add a track first — nothing to load onto."); return; }
    if (target.id !== selectedTrackId) setSelectedTrack(target.id);
    const res = await exec(command, { ...args, trackId: target.id });
    setHint(res.ok
      ? `Loaded ${row.name} onto ${target.name}.`
      : `Couldn't load ${row.name}: ${res.error ?? "unknown error"}`);
  };

  // Single-click = SELECT (samples also audition, Live's preview idiom);
  // double-click = the load gesture.
  const selectRow = (row: LiveBrowserRow) => {
    setSelRow(row.id);
    if (row.kind !== "sample") return;
    if (auditioning === row.payload) {
      void exec("stop_audition");
      setAuditioning(null);
    } else {
      void exec("audition_file", { path: row.payload }).then((r) => {
        if (r.ok) setAuditioning(row.payload);
      });
    }
  };

  const loadRow = (row: LiveBrowserRow) => {
    switch (row.kind) {
      case "builtin":
        void loadOnto(row, "load_builtin", { type: row.payload });
        return;
      case "plugin": {
        // Live's hot-swap: a double-clicked INSTRUMENT replaces the track's current
        // one (the engine swaps it into the same slot, one undo restores); effects
        // always append — a chain of effects is legal. Builtins keep their own
        // semantics (the default-instrument paths drive them). The flag rides ON the
        // row — an id re-lookup here once silently dropped it (Wave-3 follow-up).
        void loadOnto(row, "load_plugin", {
          pluginId: row.payload,
          ...(row.instrument ? { replaceInstrument: true } : {}),
        });
        return;
      }
      case "kit":
        void loadOnto(row, "load_drum_kit", { kit: row.payload });
        return;
      case "dir":
        void navigate(row.payload);
        return;
      case "sample":
        importSample(row);
        return;
    }
  };

  const importSample = (row: LiveBrowserRow) => {
    void exec("import_clip", { file: row.payload, trackId: selectedTrackId ?? undefined })
      .then(() => refresh());
  };

  return (
    <aside className="live-browser" data-testid="live-browser" aria-label="Browser">
      {/* categories — Live's fixed left column */}
      <nav className="live-bcats" aria-label="Browser categories">
        {LIVE_BROWSER_SECTIONS.map((sec) => (
          <div key={sec.label} className="live-bsec">
            <div className="live-bsec-label">{sec.label}</div>
            {sec.categories.map((c) => (
              <button
                key={c.id}
                className={`live-bcat${cat === c.id ? " sel" : ""}`}
                data-testid="live-bcat"
                data-category={c.id}
                aria-pressed={cat === c.id}
                onClick={() => setCat(c.id)}
              >{c.label}</button>
            ))}
          </div>
        ))}
      </nav>

      {/* results — the selected category's rows, or the cross-category search hits */}
      <div className="live-bresults" data-testid="live-bresults">
        <input
          className="live-bsearch"
          data-testid="live-bsearch"
          type="search"
          placeholder="Search…"
          aria-label="Search the browser"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Escape") { e.stopPropagation(); setQuery(""); e.currentTarget.blur(); }
          }}
        />
        {cat === "samples" && !q && (
          <div className="live-bnav">
            <button className="live-bnav-up" disabled={!listing?.parent}
              onClick={() => void navigate(listing?.parent ?? undefined)}>Up</button>
            <span className="live-bnav-path" title={listing?.path}>{listing?.path ?? "…"}</span>
          </div>
        )}
        {cat === "project" && !q && (
          <div className="live-bempty" role="status">
            Per-project content lands here — the current edit's own samples have no snapshot surface yet.
          </div>
        )}
        {shownRows.map((row) => (
          <div
            key={row.id}
            className={`live-brow${selRow === row.id ? " sel" : ""}${auditioning === row.payload ? " auditioning" : ""}`}
            data-testid="live-brow"
            data-kind={row.kind}
            role="button"
            tabIndex={0}
            aria-pressed={selRow === row.id}
            draggable={row.kind === "sample"}
            onDragStart={row.kind === "sample" ? (e) => {
              e.dataTransfer.setData(SAMPLE_DND_MIME, row.payload);
              e.dataTransfer.setData("text/plain", row.payload);
              e.dataTransfer.effectAllowed = "copy";
            } : undefined}
            onClick={() => selectRow(row)}
            onDoubleClick={() => loadRow(row)}
            onKeyDown={(e) => {
              if (e.key === "Enter") { e.preventDefault(); loadRow(row); }
              if (e.key === " ") { e.preventDefault(); selectRow(row); }
            }}
            title={row.kind === "sample"
              ? "Click to audition · double-click to import · drag onto a lane"
              : row.kind === "dir"
                ? "Double-click to open"
                : "Double-click to load onto the selected track"}
          >
            <span className="live-brow-icon" aria-hidden="true">
              {row.kind === "kit" ? <IconDrum size={12} />
                : row.kind === "dir" ? <IconFolder size={12} />
                : row.kind === "sample" ? <IconWaveform size={12} />
                : <IconLayers size={12} />}
            </span>
            <span className="live-brow-name">{row.name}</span>
            {row.hint && <span className="live-brow-hint">{row.hint}</span>}
            {row.kind === "sample" && (
              <MoshTip side="right" label="Import onto the selected track at the playhead">
                <button
                  className="live-brow-import"
                  data-testid="live-brow-import"
                  aria-label={`Import ${row.name}`}
                  onClick={(e) => { e.stopPropagation(); importSample(row); }}
                >+</button>
              </MoshTip>
            )}
          </div>
        ))}
        {shownRows.length === 0 && (q || cat !== "project") && (
          <div className="live-bempty" role="status">{q ? "No matches." : "Nothing here yet."}</div>
        )}
        {hint && (
          <div className="live-bhint" data-testid="live-browser-hint" role="status" aria-live="polite">{hint}</div>
        )}
        {/* AUD-SCAN — the cold-start scan only catalogs VST3 bundles carrying
            moduleinfo.json; everything else (Valhalla, Waves shells, most FabFilter…)
            needs the deep sweep. The live browser had NO rescan affordance at all —
            this is it, mirroring the v2 dock's control + the store's scan slice. */}
        {(cat === "instruments" || cat === "effects") && (
          <div className="live-bscan">
            <div className="live-bscan-row">
              <MoshTip side="top" label="Deep sweep — loads every plugin binary out-of-process (a hung one is killed and quarantined). Takes about a minute, once; the quick start-up scan only sees bundles with module metadata.">
                <button
                  className="live-bscan-btn"
                  data-testid="live-rescan"
                  disabled={!!scanProgress}
                  onClick={() => void rescanPlugins(scanAU ? "all" : "vst3", scanAU)}
                >{scanProgress ? "Scanning…" : "Rescan plugins"}</button>
              </MoshTip>
              <label className="live-bscan-au" title="Include AudioUnit plugins in the scan. Slower than VST3; a hung component is killed and quarantined automatically.">
                <input
                  type="checkbox"
                  data-testid="live-scan-au"
                  checked={scanAU}
                  disabled={!!scanProgress}
                  onChange={(e) => setSetting("scanAudioUnits", e.target.checked)}
                />
                <span>Audio Units</span>
              </label>
            </div>
            {scanProgress && (
              <div className="live-bscan-status" data-testid="live-scan-status" role="status" aria-live="polite">
                Scanning {scanProgress.format}
                {typeof scanProgress.count === "number" ? ` — ${scanProgress.count} found` : ""}
              </div>
            )}
          </div>
        )}
      </div>
    </aside>
  );
}
