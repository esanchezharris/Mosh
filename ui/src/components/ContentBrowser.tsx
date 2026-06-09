import { useCallback, useState } from "react";
import { useStore } from "../store";
import { executeCommand } from "../bridge";
import type { CommandResult, DirListing } from "../types";

// BRW-001 — content/file browser popover. Modeled on Settings.tsx — reuses
// .remote-pop / .modal-list / .plugin-row styling, no new visual language. It
// navigates the filesystem via the READ-ONLY list_directory command and imports a
// chosen audio file via the EXISTING import_clip command (no new mutation path).
//
// Navigation/listing is PURE VIEW STATE, so it lives in local component state (like
// zoom/selection) and never touches the global store or the bridge except through
// the two commands (list_directory + import_clip). Both go through exec(...)/the
// typed executeCommand seam.
function fmtSize(bytes: number | null): string {
  if (bytes == null) return "";
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let v = bytes / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v < 10 ? v.toFixed(1) : Math.round(v)} ${units[i]}`;
}

export function ContentBrowser() {
  const exec = useStore((s) => s.exec);
  const refresh = useStore((s) => s.refresh);
  const selectedTrackId = useStore((s) => s.selectedTrackId);

  const [open, setOpen] = useState(false);
  const [listing, setListing] = useState<DirListing | null>(null);
  const [loading, setLoading] = useState(false);

  // Navigate via list_directory (read-only). path omitted -> backend defaults to Home.
  const navigate = useCallback(async (path?: string) => {
    setLoading(true);
    const res = await executeCommand<CommandResult<DirListing>>({
      command: "list_directory",
      args: path ? { path } : {},
    });
    setLoading(false);
    if (res.ok && res.data) setListing(res.data);
  }, []);

  const toggle = () => {
    const next = !open;
    setOpen(next);
    if (next && !listing) void navigate(); // lazy-load on first open (-> Home)
  };

  const onImport = async (filePath: string) => {
    await exec("import_clip", { file: filePath, trackId: selectedTrackId ?? undefined });
    await refresh();
  };

  const dirs = listing?.entries.filter((e) => e.isDir) ?? [];
  const files = listing?.entries.filter((e) => !e.isDir) ?? [];

  return (
    <div className="remote-companion">
      <button
        className={`tool-btn ${open ? "on" : ""}`}
        onClick={toggle}
        title="Browse audio files"
      >
        🗀
      </button>
      {open && (
        <div className="remote-pop settings-pop">
          <div className="remote-head">
            <strong>Files</strong>
            <button className="mini" onClick={() => setOpen(false)}>x</button>
          </div>

          {/* Current path + Up */}
          <div className="cb-bar">
            <button
              className="mini"
              title="Up one level"
              disabled={!listing?.parent}
              onClick={() => void navigate(listing?.parent ?? undefined)}
            >
              ↑ Up
            </button>
            <span className="cb-path" title={listing?.path}>{listing?.path ?? "…"}</span>
          </div>

          {listing && !listing.exists && listing.error && (
            <div className="error-bar settings-gate">{listing.error}</div>
          )}

          <div className="modal-list">
            {/* Well-known roots (Places) */}
            {(listing?.roots.length ?? 0) > 0 && (
              <div className="plugin-group">
                <div className="pg-label">Places</div>
                {listing!.roots.map((r) => (
                  <button key={r.path} className="plugin-row" onClick={() => void navigate(r.path)}>
                    <span className="pr-name">{r.name}</span>
                    <span className="pr-meta">{r.path}</span>
                  </button>
                ))}
              </div>
            )}

            {/* Folders — click to descend */}
            {dirs.length > 0 && (
              <div className="plugin-group">
                <div className="pg-label">Folders</div>
                {dirs.map((d) => (
                  <button key={d.path} className="plugin-row" onClick={() => void navigate(d.path)}>
                    <span className="pr-name">🗀 {d.name}</span>
                  </button>
                ))}
              </div>
            )}

            {/* Audio files — Import button (the headless-provable on-style primitive) */}
            {files.length > 0 && (
              <div className="plugin-group">
                <div className="pg-label">Audio files</div>
                {files.map((f) => (
                  <div key={f.path} className="plugin-row cb-file">
                    <span className="pr-name">{f.name}</span>
                    <span className="pr-meta">{fmtSize(f.size)}</span>
                    <button className="mini-action cb-import" onClick={() => void onImport(f.path)}>
                      Import
                    </button>
                  </div>
                ))}
              </div>
            )}

            {listing && listing.exists && dirs.length === 0 && files.length === 0 && (
              <div className="rack-empty">{loading ? "Loading…" : "no folders or audio files here"}</div>
            )}
          </div>

          <div className="settings-hint">
            Imports the chosen file onto the selected track via the existing import path.
          </div>
        </div>
      )}
    </div>
  );
}
