// Sample browser (the 🗀 popover body). Reworked from the old FilesTool:
// type-to-filter, a recents row, and draggable rows (drag onto an Arrange lane to
// import at a position — see Arrange's lane drop handler). Still command-only:
// list_directory to browse, import_clip to land. Thumbnails + audition layer on
// top via file_peaks / audition_file once the backend ships them.

import { useEffect, useRef, useState } from "react";
import { pickFiles } from "../bridge";
import { useStore } from "../store";
import type { DirListing } from "../types";
import { filterEntries, loadRecents, addRecentSample, SAMPLE_DND_MIME } from "./sampleBrowserUtil";
import { IconArrowUp, IconDrum, IconFolder, IconWaveform } from "./icons";
import { SketchBeatboxDialog } from "./SketchBeatboxDialog";

const baseName = (p: string) => p.split("/").pop() ?? p;

// Tiny waveform overview for an un-imported file (backend file_peaks). Drawn on a
// canvas, themed via the canvas's CSS color so dark/light both look right.
function SampleThumb({ path }: { path: string }) {
  const exec = useStore((s) => s.exec);
  const ref = useRef<HTMLCanvasElement>(null);
  const [peaks, setPeaks] = useState<[number, number][] | null>(null);
  useEffect(() => {
    let cancel = false;
    void exec("file_peaks", { path, buckets: 60 }).then((r) => {
      if (!cancel && r.ok && r.data) setPeaks((r.data as { peaks: [number, number][] }).peaks);
    });
    return () => { cancel = true; };
  }, [path, exec]);
  useEffect(() => {
    const c = ref.current; if (!c || !peaks) return;
    const ctx = c.getContext("2d"); if (!ctx) return;
    const w = c.width, h = c.height, mid = h / 2;
    ctx.clearRect(0, 0, w, h);
    ctx.fillStyle = getComputedStyle(c).color || "#ccff23";
    const bw = w / Math.max(1, peaks.length);
    peaks.forEach((p, i) => {
      const top = mid - p[1] * mid, bot = mid - p[0] * mid;
      ctx.fillRect(i * bw, top, Math.max(1, bw - 0.5), Math.max(1, bot - top));
    });
  }, [peaks]);
  return <canvas ref={ref} className="sb-thumb" width={56} height={22} aria-hidden="true" />;
}

export function SampleBrowser() {
  const exec = useStore((s) => s.exec);
  const refresh = useStore((s) => s.refresh);
  const selectedTrackId = useStore((s) => s.selectedTrackId);
  const sketching = useStore((s) => s.sketchingBeatbox);
  const [listing, setListing] = useState<DirListing | null>(null);
  const [query, setQuery] = useState("");
  const [recents, setRecents] = useState<string[]>(() => loadRecents());
  const [auditioning, setAuditioning] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const navigationId = useRef(0);
  // UI-REACH (sketch_beatbox) — cmdSketchBeatbox takes an absolute path, not a clipId, so
  // this file browser (where a real path already exists, from list_directory) is the entry
  // point rather than the clipId-based clip menu. Holds the target path while the bpm/bars
  // dialog is open; null when closed.
  const [sketchTarget, setSketchTarget] = useState<string | null>(null);

  const navigate = async (path?: string) => {
    const requestId = ++navigationId.current;
    setLoading(true);
    try {
      const r = await exec("list_directory", path ? { path } : {});
      if (requestId !== navigationId.current) return;
      if (r.ok && r.data) { setListing(r.data as DirListing); setQuery(""); }
    } finally {
      if (requestId === navigationId.current) setLoading(false);
    }
  };
  useEffect(() => {
    void navigate(); // initial load on open
    return () => { ++navigationId.current; }; // discard an obsolete worker result after Close
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  // Stop any preview when the browser closes (unmounts).
  useEffect(() => () => { void exec("stop_audition"); }, [exec]);

  const onImport = async (file: string) => {
    await exec("import_clip", { file, trackId: selectedTrackId ?? undefined });
    setRecents(addRecentSample(file));
    await refresh();
  };

  const chooseFiles = async () => {
    const picked = await pickFiles({
      multiple: true,
      filters: "*.wav;*.aif;*.aiff;*.flac;*.mp3;*.ogg",
      title: "Choose audio files",
    });
    if (!picked.ok) return;
    for (const file of picked.files) await onImport(file);
  };

  const toggleAudition = (path: string) => async () => {
    if (auditioning === path) { await exec("stop_audition"); setAuditioning(null); }
    else { const r = await exec("audition_file", { path }); if (r.ok) setAuditioning(path); }
  };

  const onDragStart = (path: string) => (e: React.DragEvent) => {
    e.dataTransfer.setData(SAMPLE_DND_MIME, path);
    e.dataTransfer.setData("text/plain", path);
    e.dataTransfer.effectAllowed = "copy";
  };
  const auditionBtn = (path: string) => (
    <button
      className="sb-audition"
      style={{ width: auditioning === path ? 40 : 34 }}
      onClick={toggleAudition(path)}
      aria-pressed={auditioning === path}
      aria-label={auditioning === path ? "Stop preview" : "Audition sample"}
      title={auditioning === path ? "Stop preview" : "Audition sample"}
    >
      <span className="sb-audition-label">{auditioning === path ? "Stop" : "Cue"}</span>
    </button>
  );
  // The sketch_beatbox entry point (UI-REACH): a real absolute path already exists on this
  // row (list_directory gave it to us), so there is no pickFiles round-trip to make —
  // opening the dialog is all that is left to do. While a transduction for THIS path is in
  // flight, swap the button for a status pill so a second click can't double-dispatch.
  const sketchBtn = (path: string) =>
    sketching[path] ? (
      <span className="sb-row-status" role="status" aria-live="polite" data-testid="sample-sketching">
        sketching…
      </span>
    ) : (
      <button
        type="button"
        className="btn cb-sketch"
        data-testid="sample-sketch-beatbox"
        title="Turn this beatbox recording into an editable drum clip"
        aria-label={`Turn ${baseName(path)} into a drum clip`}
        onClick={() => setSketchTarget(path)}
      >
        <IconDrum size={12} />
      </button>
    );

  const entries = filterEntries(listing?.entries ?? [], query);
  const dirs = entries.filter((e) => e.isDir);
  const files = entries.filter((e) => !e.isDir);

  return (
    <div className="sb-browser">
      <div className="pop-head">
        <div className="sb-heading">
          <span className="sb-title">Sounds</span>
          <span className="sb-subtitle">Browse folders, recent imports, and audio files.</span>
        </div>
      </div>
      <div className="pop-row sb-location">
        <button className="btn" disabled={loading || !listing?.parent} onClick={() => void navigate(listing?.parent ?? undefined)}>
          <IconArrowUp size={14} />
          <span>Up</span>
        </button>
        <div className="sb-location-copy">
          <span className="sb-location-label">Current folder</span>
          <span className="pop-note sb-path" title={listing?.path}>
            {loading ? "Loading sounds..." : (listing?.path ?? "Loading sounds...")}
          </span>
        </div>
        <button className="btn" type="button" data-testid="sample-browser-choose-files"
          onClick={() => void chooseFiles()}>Choose files…</button>
      </div>
      <label className="sb-search-field">
        <span className="sb-search-label">Search sounds</span>
        <input
          className="sb-search"
          type="search"
          placeholder="Filter samples by name..."
          aria-label="Filter samples"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
      </label>
      {recents.length > 0 && query === "" && (
        <section className="plugin-group sb-section" aria-label="Recent imports">
          <div className="pg-label">
            <span>Recent imports</span>
            <span className="sb-section-count">{Math.min(recents.length, 6)}</span>
          </div>
          {recents.slice(0, 6).map((p) => (
            <div key={p} className="plugin-row cb-file" draggable onDragStart={onDragStart(p)} title={p}>
              {auditionBtn(p)}
              <span className="sb-row-icon" aria-hidden><IconWaveform size={14} /></span>
              <div className="pr-name sb-row-copy">
                <span className="sb-row-title">{baseName(p)}</span>
                <span className="sb-row-meta">{p}</span>
              </div>
              {sketchBtn(p)}
              <button className="btn cb-import" onClick={() => void onImport(p)}>Import</button>
            </div>
          ))}
        </section>
      )}
      <div className="modal-list sb-list" data-testid="content-browser">
        {listing?.truncated && (
          <div className="rack-empty sb-limit-note" role="status" data-testid="sample-browser-limit">
            Showing the first {listing.limit ?? entries.length} items. Open a narrower folder to see more.
          </div>
        )}
        {dirs.length > 0 && (
          <section className="plugin-group sb-section" aria-label="Folders">
            <div className="pg-label">
              <span>Folders</span>
              <span className="sb-section-count">{dirs.length}</span>
            </div>
            {dirs.map((d) => (
              <button key={d.path} className="plugin-row" disabled={loading} onClick={() => void navigate(d.path)} title={d.path}>
                <span className="sb-row-icon" aria-hidden><IconFolder size={14} /></span>
                <div className="pr-name sb-row-copy">
                  <span className="sb-row-title">{d.name}</span>
                  <span className="sb-row-meta">{d.path}</span>
                </div>
                <span className="pr-folder sb-row-affordance" aria-hidden="true">Open</span>
              </button>
            ))}
          </section>
        )}
        {files.length > 0 && (
          <section className="plugin-group sb-section" aria-label="Audio files">
            <div className="pg-label">
              <span>Audio files</span>
              <span className="sb-section-count">{files.length}</span>
            </div>
            {files.map((f) => (
              <div
                key={f.path}
                className="plugin-row cb-file"
                data-testid="sample-row"
                draggable
                onDragStart={onDragStart(f.path)}
                title="Drag onto a track, or import it directly."
              >
                {auditionBtn(f.path)}
                <SampleThumb path={f.path} />
                <div className="pr-name sb-row-copy">
                  <span className="sb-row-title">{f.name}</span>
                  <span className="sb-row-meta">{f.path}</span>
                </div>
                {sketchBtn(f.path)}
                <button className="btn cb-import" onClick={() => void onImport(f.path)}>Import</button>
              </div>
            ))}
          </section>
        )}
        {listing && entries.length === 0 && (
          <div className="rack-empty">{query ? "No sounds match this search." : "This folder is empty."}</div>
        )}
      </div>
      {sketchTarget && (
        <SketchBeatboxDialog file={sketchTarget} onClose={() => setSketchTarget(null)} />
      )}
    </div>
  );
}
