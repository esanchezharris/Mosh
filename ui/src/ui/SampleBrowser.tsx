// Sample browser (the 🗀 popover body). Reworked from the old FilesTool:
// type-to-filter, a recents row, and draggable rows (drag onto an Arrange lane to
// import at a position — see Arrange's lane drop handler). Still command-only:
// list_directory to browse, import_clip to land. Thumbnails + audition layer on
// top via file_peaks / audition_file once the backend ships them.

import { useEffect, useState } from "react";
import { useStore } from "../store";
import type { DirListing } from "../types";
import { filterEntries, loadRecents, addRecentSample, SAMPLE_DND_MIME } from "./sampleBrowserUtil";

const baseName = (p: string) => p.split("/").pop() ?? p;

export function SampleBrowser() {
  const exec = useStore((s) => s.exec);
  const refresh = useStore((s) => s.refresh);
  const selectedTrackId = useStore((s) => s.selectedTrackId);
  const [listing, setListing] = useState<DirListing | null>(null);
  const [query, setQuery] = useState("");
  const [recents, setRecents] = useState<string[]>(() => loadRecents());

  const navigate = async (path?: string) => {
    const r = await exec("list_directory", path ? { path } : {});
    if (r.ok && r.data) { setListing(r.data as DirListing); setQuery(""); }
  };
  useEffect(() => { void navigate(); /* initial load on open */ }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const onImport = async (file: string) => {
    await exec("import_clip", { file, trackId: selectedTrackId ?? undefined });
    setRecents(addRecentSample(file));
    await refresh();
  };

  const onDragStart = (path: string) => (e: React.DragEvent) => {
    e.dataTransfer.setData(SAMPLE_DND_MIME, path);
    e.dataTransfer.setData("text/plain", path);
    e.dataTransfer.effectAllowed = "copy";
  };

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
              <span className="pr-name">↩ {baseName(p)}</span>
              <button className="btn cb-import" onClick={() => void onImport(p)}>Import</button>
            </div>
          ))}
        </div>
      )}
      <div className="modal-list" data-testid="content-browser" style={{ maxHeight: 240 }}>
        {dirs.length > 0 && (
          <div className="plugin-group"><div className="pg-label">Folders</div>
            {dirs.map((d) => <button key={d.path} className="plugin-row" onClick={() => void navigate(d.path)}><span className="pr-name">🗀 {d.name}</span></button>)}
          </div>
        )}
        {files.length > 0 && (
          <div className="plugin-group"><div className="pg-label">Audio files</div>
            {files.map((f) => (
              <div key={f.path} className="plugin-row cb-file" data-testid="sample-row" draggable onDragStart={onDragStart(f.path)}
                title="Drag onto a track, or Import">
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
