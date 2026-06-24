// The redesign's bottom-left "+" control: one expanding entry point for file / options
// / export, consolidating what the classic topbar split across the File menu and the
// Export popover. Project actions run through the SAME runAction dispatcher the keyboard
// layer and native menu use; Export reuses the shared ExportControls; Settings/Samples
// open inline as sub-panels. Opens UPWARD (it lives in the bottom prompt bar). UI-local
// view state only — every mutation is still a command on the seam.

import { useEffect, useRef, useState } from "react";
import { useStore } from "../store";
import { pickFiles, pickSaveFile } from "../bridge";
import { runAction, FILE_MENU, type ActionId } from "../menuActions";
import type { Snapshot } from "../types";
import { SampleBrowser } from "./SampleBrowser";
import { SettingsPanel } from "../settings/SettingsPanel";
import { ExportControls } from "./ExportControls";

function FoPanel({ title, onBack, children }: { title: string; onBack: () => void; children: React.ReactNode }) {
  return (
    <>
      <div className="pop-head fo-sub-head">
        <button className="btn icon fo-back" aria-label="Back" title="Back" onClick={onBack}>‹</button>
        <span>{title}</span>
      </div>
      <div className="fo-sub-body">{children}</div>
    </>
  );
}

export function FileOptions({ snapshot }: { snapshot: Snapshot }) {
  const [open, setOpen] = useState(false);
  const [panel, setPanel] = useState<null | "settings" | "samples">(null);
  const ref = useRef<HTMLDivElement>(null);
  const s = snapshot.session;
  const audioEnabled = s.audioEnabled ?? true;
  const recents = (s.recentProjects ?? []).slice(0, 8);
  const run = (id: ActionId, opts?: { file?: string; index?: number }) =>
    void runAction(id, { store: useStore.getState(), pickFiles, pickSaveFile }, opts);

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) { setOpen(false); setPanel(null); } };
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") { setOpen(false); setPanel(null); } };
    document.addEventListener("mousedown", onDoc); document.addEventListener("keydown", onKey);
    return () => { document.removeEventListener("mousedown", onDoc); document.removeEventListener("keydown", onKey); };
  }, [open]);

  const close = () => { setOpen(false); setPanel(null); };
  // Export has its own group (with format/depth) — drop the plain File-menu export item.
  const fileActions = FILE_MENU.filter((m) => m.id !== "export_audio");

  return (
    <div className="file-options" ref={ref}>
      <button className="btn fo-trigger" data-testid="file-options" title="File · options · export"
        aria-label="File, options, and export" aria-expanded={open} aria-haspopup="menu" onClick={() => setOpen((v) => !v)}>
        <span aria-hidden="true">＋</span>
      </button>
      {open && (
        <div className="pop fo-pop" role="dialog" aria-label="File and options">
          {panel === "settings" ? (
            <FoPanel title="Settings" onBack={() => setPanel(null)}><SettingsPanel snapshot={snapshot} /></FoPanel>
          ) : panel === "samples" ? (
            <FoPanel title="Samples" onBack={() => setPanel(null)}><SampleBrowser /></FoPanel>
          ) : (
            <>
              <div className="pop-head">Project</div>
              <div className="menu-list" role="menu" data-testid="file-options-menu">
                {fileActions.map((m) => (
                  <button key={m.id} className="menu-item" role="menuitem" data-action={m.id}
                    onClick={() => { run(m.id); close(); }}>
                    <span className="menu-label">{m.label}</span>
                    <span className="menu-accel tc">{m.accel}</span>
                  </button>
                ))}
                {recents.length > 0 && (
                  <div className="menu-sub" data-testid="fo-recent">
                    <div className="menu-sub-head">Open Recent</div>
                    {recents.map((p, i) => (
                      <button key={p.path} className="menu-item sub" role="menuitem" title={p.path}
                        disabled={p.path === s.editFile}
                        onClick={() => { run("open_recent", { index: i }); close(); }}>
                        <span className="menu-label">{p.path === s.editFile ? "● " : ""}{p.name}</span>
                      </button>
                    ))}
                  </div>
                )}
              </div>
              <ExportControls audioEnabled={audioEnabled} />
              <div className="pop-actions fo-options">
                <button className="btn" data-testid="fo-settings" onClick={() => setPanel("settings")}>⚙ Settings</button>
                <button className="btn" data-testid="fo-samples" onClick={() => setPanel("samples")}>🗀 Samples</button>
              </div>
              {s.dirty ? <div className="pop-note">• unsaved changes (auto-saved)</div> : null}
            </>
          )}
        </div>
      )}
    </div>
  );
}
