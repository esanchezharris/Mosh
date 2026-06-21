// Topbar utility cluster: theme toggle + Settings / Export / Command-log /
// iPhone-companion popovers. Ported from the legacy components into the ink+lime
// register; every mutation stays a command on the seam (native file dialogs only
// resolve paths). In Vite dev the mock drives Settings/Export/Log; the iPhone
// companion is real-backend only (the mock reports it unavailable).

import { Fragment, useEffect, useRef, useState } from "react";
import * as QRCode from "qrcode";
import { useStore } from "../store";
import { pickFiles, pickSaveFile } from "../bridge";
import { runAction, FILE_MENU, type ActionId } from "../menuActions";
import type { Snapshot, ExportFormat, CommandLog as CommandLogData, TrainingState } from "../types";
import { SampleBrowser } from "./SampleBrowser";
import { SettingsPanel } from "../settings/SettingsPanel";
import { MultiplayerPanel } from "./MultiplayerPanel";

// Small popover anchored under its trigger; closes on outside click / Esc.
function Pop({ label, title, on, className, children }: { label: string; title: string; on?: boolean; className?: string; children: (close: () => void) => React.ReactNode }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false); };
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setOpen(false); };
    document.addEventListener("mousedown", onDoc); document.addEventListener("keydown", onKey);
    return () => { document.removeEventListener("mousedown", onDoc); document.removeEventListener("keydown", onKey); };
  }, [open]);
  return (
    <div className={`pop-wrap${className ? " " + className : ""}`} ref={ref}>
      <button className={`btn${open || on ? " on" : ""}`} title={title} aria-expanded={open} onClick={() => setOpen((v) => !v)}>{label}</button>
      {open && <div className="pop" role="dialog">{children(() => setOpen(false))}</div>}
    </div>
  );
}

export function TopbarTools({ snapshot }: { snapshot: Snapshot }) {
  const theme = useStore((s) => s.theme);
  const toggleTheme = useStore((s) => s.toggleTheme);
  const audioEnabled = snapshot.session.audioEnabled ?? true;
  return (
    <div className="topbar-tools">
      <FileMenu snapshot={snapshot} />
      <Pop label="🗀" title="Browse audio samples">{() => <SampleBrowser />}</Pop>
      <Pop label="⚙" title="Settings" className="settings-pop">{() => <SettingsPanel snapshot={snapshot} />}</Pop>
      <ExportTool audioEnabled={audioEnabled} />
      <TrainingTool training={snapshot.training ?? null} />
      <CommandLogTool />
      <RemoteTool />
      <MultiplayerTool />
      <HelpTool />
      <button className="btn icon" title="Toggle theme" aria-label="Toggle light/dark theme" onClick={toggleTheme}>{theme === "dark" ? "☾" : "☀"}</button>
    </div>
  );
}

// The WebView File menu — mirrors the native macOS File menu for users who live in
// the WebView. Every item runs through the SAME runAction dispatcher the keyboard
// layer and the native menu use, so there is one definition of each command. The
// scattered New/Save/Save As/Open buttons that used to live in Settings are folded
// in here (with Open Recent from session.recentProjects).
function FileMenu({ snapshot }: { snapshot: Snapshot }) {
  const s = snapshot.session;
  const recents = (s.recentProjects ?? []).slice(0, 8);
  const run = (id: ActionId, opts?: { file?: string }) =>
    void runAction(id, { store: useStore.getState(), pickFiles, pickSaveFile }, opts);
  return (
    <Pop label="File" title="File menu" className="menu-pop">
      {(close) => (
        <div className="menu-list" role="menu" data-testid="file-menu">
          {FILE_MENU.map((m) => (
            <Fragment key={m.id}>
              <button className="menu-item" role="menuitem" data-action={m.id}
                      onClick={() => { run(m.id); close(); }}>
                <span className="menu-label">{m.label}</span>
                <span className="menu-accel tc">{m.accel}</span>
              </button>
              {m.id === "open_project" && (
                <div className="menu-sub" data-testid="recent-projects">
                  <div className="menu-sub-head">Open Recent</div>
                  {recents.length === 0
                    ? <div className="rack-empty">no recent projects</div>
                    : recents.map((p) => (
                        <button key={p.path} className="menu-item sub" role="menuitem" title={p.path}
                                disabled={p.path === s.editFile}
                                onClick={() => { run("open_project", { file: p.path }); close(); }}>
                          <span className="menu-label">{p.path === s.editFile ? "● " : ""}{p.name}</span>
                        </button>
                      ))}
                </div>
              )}
            </Fragment>
          ))}
          {s.dirty ? <div className="menu-foot pop-note">• unsaved changes (auto-saved)</div> : null}
        </div>
      )}
    </Pop>
  );
}

function TrainingTool({ training }: { training: TrainingState | null }) {
  const exec = useStore((s) => s.exec);
  const refresh = useStore((s) => s.refresh);
  const [title, setTitle] = useState("");
  const [creator, setCreator] = useState("");
  const [sourceUrl, setSourceUrl] = useState("");
  const [localPath, setLocalPath] = useState("");
  const [userClaimedLicense, setUserClaimedLicense] = useState("");
  const [proofOfRights, setProofOfRights] = useState("");
  const [bundlePath, setBundlePath] = useState("");
  const [lastJobId, setLastJobId] = useState("");
  const sources = training?.sources ?? [];
  const adapters = training?.adapters ?? [];
  const jobs = training?.jobs ?? [];
  const blockedSources = sources.filter((s) => !s.eligible);
  const readyToBuild = sources.length > 0 && blockedSources.length === 0;
  const blockedReasons = blockedSources.map((s) => `${s.source_id}: ${s.blocked_reason || "Blocked"}`);
  const missingSourceInput = localPath.trim().length === 0 && sourceUrl.trim().length === 0;
  const sourceStatus = (s: TrainingState["sources"][number]) => {
    if (s.eligible) return "Ready for training";
    switch (s.blocked_reason) {
      case "not approved_for_training": return "Needs approval";
      case "missing proof_of_rights": return "Add rights proof";
      case "missing local_path": return "Add a local file";
      default: return s.blocked_reason ?? "Blocked";
    }
  };
  const blockedReasonText = (reason: string) => {
    switch (reason) {
      case "missing source_id":
        return "Missing source id";
      case "missing title":
        return "Add a title";
      case "missing creator":
        return "Add a creator";
      case "missing user_claimed_license":
        return "Add your claimed license text";
      case "missing proof_of_rights":
        return "Add rights proof";
      case "missing source_url or local_path":
      case "missing local file":
        return "Add a local file";
      default:
        return reason ? `Missing: ${reason}` : "Needs review";
    }
  };
  const canStartTraining = blockedSources.length === 0 && sources.length > 0;
  const canAddSource = title.trim().length > 0
    && creator.trim().length > 0
    && userClaimedLicense.trim().length > 0
    && proofOfRights.trim().length > 0
    && (localPath.trim().length > 0 || sourceUrl.trim().length > 0);

    const addSource = async () => {
      const r = await exec("import_training_source", {
        title,
        creator,
      sourceUrl,
      localPath,
      userClaimedLicense,
      proofOfRights,
      });
      if (r.ok) {
      setTitle(""); setCreator(""); setSourceUrl(""); setLocalPath(""); setUserClaimedLicense(""); setProofOfRights("");
        await refresh();
      }
    };
  const buildCorpus = async () => {
    const r = await exec("build_training_corpus", {});
    if (r.ok) {
      setBundlePath((r.data as { bundlePath?: string } | undefined)?.bundlePath ?? "");
      await refresh();
    }
  };
  const submitJob = async () => {
    if (!bundlePath) return;
    const r = await exec("submit_training_job", {
      corpusBundle: bundlePath,
      config: { rank: 16, steps: 2000, lr: 0.0001, base_model: "type-beat-base" },
    });
    if (r.ok) {
      const jobId = (r.data as { jobId?: string } | undefined)?.jobId ?? "";
      setLastJobId(jobId);
      await refresh();
    }
  };
  const syncAdapter = async () => {
    if (!lastJobId) return;
    await exec("import_lora_adapter", { jobId: lastJobId });
    await refresh();
  };

  return (
    <Pop label="LoRA" title="Type-beat training" className="training-pop">
      {() => (
        <>
          <div className="pop-head">Type-Beat Training</div>
          <div className="pop-note">Use only music you can legally train on. YouTube is discovery/reference. Import local files for training.</div>
          <div className="pop-group">
            <div className="pop-label">Add source</div>
            <label className="pop-row"><span>Beat title</span><input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Track/beat name" /></label>
            <label className="pop-row"><span>Creator</span><input value={creator} onChange={(e) => setCreator(e.target.value)} placeholder="Creator/artist name" /></label>
            <label className="pop-row"><span>Source URL</span><input value={sourceUrl} onChange={(e) => setSourceUrl(e.target.value)} placeholder="Discovery link (optional)" /></label>
            <label className="pop-row"><span>Audio file</span><input value={localPath} onChange={(e) => setLocalPath(e.target.value)} placeholder="Local file path" /></label>
            <div className="pop-actions">
              <button className="btn" onClick={async () => {
                const r = await pickFiles({ multiple: false, title: "Choose a source audio file" });
                if (r.ok && r.files[0]) setLocalPath(r.files[0]);
              }}>Pick file</button>
              <button className="btn" disabled={!canAddSource} onClick={addSource}>Add source</button>
            </div>
            <label className="pop-row"><span>License claim</span><input value={userClaimedLicense} onChange={(e) => setUserClaimedLicense(e.target.value)} placeholder="Paste your rights claim text" /></label>
            <label className="pop-row"><span>Rights proof</span><input value={proofOfRights} onChange={(e) => setProofOfRights(e.target.value)} placeholder="link + proof note" /></label>
            {!canAddSource && missingSourceInput && <div className="pop-note">Add a source URL or a local file.</div>}
            {!canAddSource && userClaimedLicense.trim().length === 0 && <div className="pop-note">Add your claimed license text.</div>}
            {!canAddSource && proofOfRights.trim().length === 0 && <div className="pop-note">Add rights proof text.</div>}
            {!canAddSource && title.trim().length === 0 && <div className="pop-note">Add the beat title.</div>}
            {!canAddSource && creator.trim().length === 0 && <div className="pop-note">Add the creator name.</div>}
          </div>
          <div className="pop-group">
            <div className="pop-label">Sources</div>
            <div className="training-status" role="status">{canStartTraining ? "All sources ready for training" : `${blockedSources.length} source${blockedSources.length === 1 ? "" : "s"} need review`}</div>
            <div className="modal-list training-list">
              {sources.length === 0 && <div className="rack-empty">no sources yet</div>}
              {sources.map((s) => (
                <div key={s.source_id} className="plugin-row">
                  <span className="pr-name">{s.title}</span>
                  <span className={`cmdlog-badge${s.eligible ? "" : " err"}`}>{sourceStatus(s)}</span>
                  {!s.approved_for_training && <button className="btn" onClick={() => void exec("approve_training_source", { sourceId: s.source_id, approved: true }).then(refresh)}>Approve</button>}
                </div>
              ))}
            </div>
            {blockedReasons.length > 0 && (
              <div className="pop-note">
                Blocked:
                <ul className="training-blocker-list">
                  {sources.filter((s) => !s.eligible).map((s) => (
                    <li key={`blocked-${s.source_id}`}>
                      {s.source_id}: {blockedReasonText(s.blocked_reason || "blocked")}
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </div>
          <div className="pop-group">
            <div className="pop-label">Corpus</div>
            <div className="pop-actions">
              <button className="btn" disabled={!readyToBuild} onClick={buildCorpus}>Build</button>
              <button className="btn" disabled={!bundlePath || !readyToBuild} onClick={submitJob}>Train</button>
              <button className="btn" disabled={!lastJobId} onClick={syncAdapter}>Import adapter</button>
            </div>
            <div className="pop-note tc" title={bundlePath || ""}>{bundlePath ? `bundle: ${bundlePath}` : "no bundle yet"}</div>
          </div>
          <div className="pop-group">
            <div className="pop-label">Adapters</div>
            <div className="modal-list training-list">
              {adapters.length === 0 && <div className="rack-empty">no adapters yet</div>}
              {adapters.map((a) => (
                <div key={a.adapterId} className="plugin-row">
                  <span className="pr-name">{a.adapterId}{a.active ? " · active" : ""}</span>
                  <button className="btn" onClick={() => void exec("activate_lora_adapter", { adapterId: a.adapterId }).then(refresh)}>Activate</button>
                </div>
              ))}
            </div>
          </div>
          <div className="pop-group">
            <div className="pop-label">Jobs</div>
            <div className="modal-list training-list">
              {jobs.length === 0 && <div className="rack-empty">no jobs yet</div>}
              {jobs.map((j) => (
                <div key={j.jobId} className="plugin-row">
                  <span className="pr-name">{j.jobId} · {j.status}</span>
                  {j.status === "ready" && <button className="btn" onClick={() => void exec("import_lora_adapter", { jobId: j.jobId }).then(refresh)}>Import</button>}
                </div>
              ))}
            </div>
          </div>
          <div className="pop-note tc">{training?.activeAdapterId ? `active adapter: ${training.activeAdapterId}` : "no active adapter"}</div>
        </>
      )}
    </Pop>
  );
}

// Keyboard-shortcut help — the keyboard bindings now live in ONE place (the keymap
// + useKeyboardShortcuts); the ruler/clip pointer gestures live in Arrange. Surfaced
// here so they're discoverable (and mirrored by the File/Edit menus).
function HelpTool() {
  const SHORTCUTS: [string, string][] = [
    ["⌘N · ⌘O", "New · Open project"],
    ["⌘S · ⇧⌘S", "Save · Save As"],
    ["⌘E", "Export audio"],
    ["⌘Z · ⇧⌘Z", "Undo · Redo"],
    ["⌘X · ⌘C · ⌘V", "Cut · Copy · Paste clip"],
    ["Space", "Play / pause"],
    ["Delete  ⌫", "Remove selected clip"],
    ["Drag clip", "Move · drag an edge to trim"],
    ["Click ruler", "Seek · ⇧-drag sets the loop"],
  ];
  return (
    <Pop label="?" title="Keyboard shortcuts" className="help-pop">
      {() => (
        <>
          <div className="pop-head">Shortcuts</div>
          <div className="pop-group">
            {SHORTCUTS.map(([k, d]) => (
              <div className="pop-row" key={k}><span className="tc">{k}</span><span className="pop-note">{d}</span></div>
            ))}
          </div>
          <div className="pop-note">Tools (Move / Split / Range) &amp; Snap live in the toolbar.</div>
        </>
      )}
    </Pop>
  );
}

const FORMATS: { value: ExportFormat; depths: number[] }[] = [
  { value: "wav", depths: [16, 24, 32] }, { value: "aiff", depths: [16, 24, 32] }, { value: "flac", depths: [16, 24] },
];

function ExportTool({ audioEnabled }: { audioEnabled: boolean }) {
  const exec = useStore((s) => s.exec);
  const [format, setFormat] = useState<ExportFormat>("wav");
  const [bitDepth, setBitDepth] = useState(24);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState("");
  const depths = FORMATS.find((f) => f.value === format)!.depths;
  const onExport = async () => {
    setBusy(true); setDone("");
    const r = await exec("export_audio", { format, bitDepth });
    setBusy(false);
    if (r.ok) setDone((r.data as { file?: string } | undefined)?.file ?? "exported");
  };
  return (
    <Pop label="⤓" title={audioEnabled ? "Export the mix" : "No audio device — export disabled"}>
      {() => (
        <>
          <div className="pop-head">Export</div>
          <div className="pop-group">
            <label className="pop-row"><span>Format</span>
              <select value={format} onChange={(e) => { const f = e.target.value as ExportFormat; setFormat(f); const d = FORMATS.find((x) => x.value === f)!.depths; if (!d.includes(bitDepth)) setBitDepth(d.includes(24) ? 24 : d[0]); }}>
                {FORMATS.map((f) => <option key={f.value} value={f.value}>{f.value.toUpperCase()}</option>)}
              </select>
            </label>
            <label className="pop-row"><span>Bit depth</span>
              <select value={String(bitDepth)} onChange={(e) => setBitDepth(Number(e.target.value))}>{depths.map((d) => <option key={d} value={d}>{d}-bit</option>)}</select>
            </label>
          </div>
          <div className="pop-actions">
            <button className="btn" data-testid="export-run" disabled={busy || !audioEnabled} onClick={onExport}>{busy ? "Exporting…" : "Export"}</button>
          </div>
          {done && <div className="pop-note tc" title={done}>Exported: {done}</div>}
        </>
      )}
    </Pop>
  );
}

function CommandLogTool() {
  const exec = useStore((s) => s.exec);
  const [log, setLog] = useState<CommandLogData | null>(null);
  const [loading, setLoading] = useState(false);
  const load = async () => { setLoading(true); const r = await exec("get_command_log", { limit: 50 }); if (r.ok && r.data) setLog(r.data as CommandLogData); setLoading(false); };
  const entries = log?.entries ?? [];
  return (
    <Pop label="☰" title="Command log">
      {() => {
        if (!log && !loading) void load();
        return (
          <>
            <div className="pop-head">Command log <button className="btn icon" title="Refresh" onClick={() => void load()}>↻</button></div>
            <div className="pop-note">{loading ? "Loading…" : `${entries.length} of ${log?.total ?? 0} · newest first`}</div>
            <div className="cmdlog-list" data-testid="command-log">
              {entries.length === 0 && !loading ? <div className="rack-empty">no commands yet</div> :
                entries.map((e, i) => (
                  <div className={`cmdlog-row${e.ok ? "" : " err"}`} key={i}>
                    <span className={`cmdlog-dot${e.ok ? " ok" : " err"}`}>{e.ok ? "●" : "✕"}</span>
                    <span className="cmdlog-name tc" title={e.error ?? e.command}>{e.command}</span>
                    {e.undoable && <span className="cmdlog-badge">undo</span>}
                  </div>
                ))}
            </div>
          </>
        );
      }}
    </Pop>
  );
}

// MP-001 — 2-player session entry (the reserved B-5 slot). `on` lights when a
// session is active so the topbar shows the live-collaboration state at a glance.
function MultiplayerTool() {
  const active = useStore((s) => s.mp.active);
  const peerCount = useStore((s) => Object.keys(s.peers).length);
  return (
    <Pop label={active ? `Live · ${peerCount}` : "Multiplayer"} title="2-player session" on={active} className="mp-pop">
      {() => <MultiplayerPanel />}
    </Pop>
  );
}

function RemoteTool() {
  const remote = useStore((s) => s.remoteStatus);
  const start = useStore((s) => s.startRemotePairing);
  const stop = useStore((s) => s.stopRemote);
  const lastError = useStore((s) => s.lastError);
  const pairing = remote?.pairing;
  const running = remote?.running ?? false;
  return (
    <Pop label="iPhone" title="Pair iPhone companion" on={running} className="remote-pop">
      {() => (
        <>
          <div className="pop-head">iPhone Companion</div>
          {pairing ? (
            <>
              <PairingQR url={pairing.pairingUrl} />
              <div className="remote-code tc">{pairing.token.slice(0, 6).toUpperCase()}</div>
              <div className="pop-note tc">{pairing.host}:{pairing.port}</div>
              <div className="pop-actions"><button className="btn" onClick={stop}>Stop remote</button></div>
            </>
          ) : (
            <>
              <div className="pop-note">{lastError && lastError.includes("dev") ? "Companion runs on the native app only (unavailable in web dev)." : "Pair an iPhone to control the session."}</div>
              <div className="pop-actions"><button className="btn" onClick={start}>Start pairing</button></div>
            </>
          )}
        </>
      )}
    </Pop>
  );
}

function PairingQR({ url }: { url: string }) {
  const [dataUrl, setDataUrl] = useState("");
  useEffect(() => {
    let cancelled = false;
    void QRCode.toDataURL(url, { margin: 1, width: 160, color: { dark: "#0b0b0b", light: "#ccff23" } }).then((d) => { if (!cancelled) setDataUrl(d); });
    return () => { cancelled = true; };
  }, [url]);
  return dataUrl ? <img className="remote-qr" src={dataUrl} alt="iPhone pairing QR" /> : null;
}
