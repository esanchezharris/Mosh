// Sample browser (the 🗀 popover body). Reworked from the old FilesTool:
// type-to-filter, a recents row, and draggable rows (drag onto an Arrange lane to
// import at a position — see Arrange's lane drop handler). Still command-only:
// list_directory to browse, import_clip to land. Thumbnails + audition layer on
// top via file_peaks / audition_file once the backend ships them.

import { useEffect, useRef, useState } from "react";
import { useStore } from "../store";
import type { DirListing } from "../types";
import { filterEntries, loadRecents, addRecentSample, SAMPLE_DND_MIME } from "./sampleBrowserUtil";

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
  const [listing, setListing] = useState<DirListing | null>(null);
  const [query, setQuery] = useState("");
  const [recents, setRecents] = useState<string[]>(() => loadRecents());
  const [auditioning, setAuditioning] = useState<string | null>(null);

  const navigate = async (path?: string) => {
    const r = await exec("list_directory", path ? { path } : {});
    if (r.ok && r.data) { setListing(r.data as DirListing); setQuery(""); }
  };
  useEffect(() => { void navigate(); /* initial load on open */ }, []); // eslint-disable-line react-hooks/exhaustive-deps
  // Stop any preview when the browser closes (unmounts).
  useEffect(() => () => { void exec("stop_audition"); }, [exec]);

  const onImport = async (file: string) => {
    await exec("import_clip", { file, trackId: selectedTrackId ?? undefined });
    setRecents(addRecentSample(file));
    await refresh();
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
    <button className="sb-audition" onClick={toggleAudition(path)} aria-pressed={auditioning === path}
      aria-label={auditioning === path ? "Stop preview" : "Audition"} title="Audition">{auditioning === path ? "⏸" : "▶"}</button>
  );

  const entries = filterEntries(listing?.entries ?? [], query);
  const dirs = entries.filter((e) => e.isDir);
  const files = entries.filter((e) => !e.isDir);

  return (
    <>
      <div className="pop-head">Samples</div>
      <div className="pop-row">
        <button className="btn" disabled={!listing?.parent} onClick={() => void navigate(listing?.parent ?? undefined)}>↑ Up</button>
        <span className="pop-note" title={listing?.path}>{listing?.path ?? "…"}</span>
      </div>
      <input className="sb-search" type="search" placeholder="Filter samples…" aria-label="Filter samples"
        value={query} onChange={(e) => setQuery(e.target.value)} />
      {recents.length > 0 && query === "" && (
        <div className="plugin-group"><div className="pg-label">Recent</div>
          {recents.slice(0, 6).map((p) => (
            <div key={p} className="plugin-row cb-file" draggable onDragStart={onDragStart(p)} title={p}>
              {auditionBtn(p)}
              <span className="pr-name">↩ {baseName(p)}</span>
              <button className="btn cb-import" onClick={() => void onImport(p)}>Import</button>
            </div>
          ))}
        </div>
      )}
      <div className="modal-list" data-testid="content-browser" style={{ maxHeight: 240 }}>
        {dirs.length > 0 && (
          <div className="plugin-group"><div className="pg-label">Folders</div>
            {dirs.map((d) => <button key={d.path} className="plugin-row" onClick={() => void navigate(d.path)}><span className="pr-name"><span className="pr-folder" aria-hidden>▸</span> {d.name}</span></button>)}
          </div>
        )}
        {files.length > 0 && (
          <div className="plugin-group"><div className="pg-label">Audio files</div>
            {files.map((f) => (
              <div key={f.path} className="plugin-row cb-file" data-testid="sample-row" draggable onDragStart={onDragStart(f.path)}
                title="Drag onto a track, or Import">
                {auditionBtn(f.path)}
                <SampleThumb path={f.path} />
                <span className="pr-name">{f.name}</span>
                <button className="btn cb-import" onClick={() => void onImport(f.path)}>Import</button>
              </div>
            ))}
          </div>
        )}
        {listing && entries.length === 0 && <div className="rack-empty">{query ? "no matches" : "empty"}</div>}
      </div>
    </>
  );
}
