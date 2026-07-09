// Topbar utility cluster: theme toggle + Settings / Export / Command-log /
// iPhone-companion popovers. Ported from the legacy components into the ink+lime
// register; every mutation stays a command on the seam (native file dialogs only
// resolve paths). In Vite dev the mock drives Settings/Export/Log; the iPhone
// companion is real-backend only (the mock reports it unavailable).

import { Fragment, useEffect, useRef, useState } from "react";
import * as QRCode from "qrcode";
import { useStore } from "../store";
import { useSettings } from "../settings/store";
import { pickFiles, pickSaveFile } from "../bridge";
import { runAction, FILE_MENU, type ActionId } from "../menuActions";
import type { Snapshot, CommandLog as CommandLogData, TrainingState } from "../types";
import { SampleBrowser } from "./SampleBrowser";
import { SettingsPanel } from "../settings/SettingsPanel";
import { MultiplayerPanel } from "./MultiplayerPanel";
import { ExportControls } from "./ExportControls";
import { deriveTrainingJob } from "./trainingJobView";
import {
  IconCheck,
  IconDownload,
  IconFolder,
  IconMoon,
  IconRefresh,
  IconSettings,
  IconSun,
  IconX,
} from "./icons";

// Small popover anchored under its trigger; closes on outside click / Esc.
function Pop({
  label,
  title,
  on,
  className,
  buttonClassName,
  ariaLabel,
  testId,
  children,
}: {
  label: React.ReactNode;
  title: string;
  on?: boolean;
  className?: string;
  buttonClassName?: string;
  ariaLabel?: string;
  testId?: string;
  children: (close: () => void) => React.ReactNode;
}) {
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
      <button
        type="button"
        className={`btn${buttonClassName ? ` ${buttonClassName}` : ""}${open || on ? " on" : ""}`}
        title={title}
        aria-label={ariaLabel ?? title}
        aria-expanded={open}
        aria-haspopup="dialog"
        data-testid={testId}
        onClick={() => setOpen((v) => !v)}
      >
        {label}
      </button>
      {open && <div className="pop" role="dialog">{children(() => setOpen(false))}</div>}
    </div>
  );
}

type ToolChromeProps = {
  label?: React.ReactNode;
  title?: string;
  className?: string;
  ariaLabel?: string;
  testId?: string;
};

function ToolTrigger({
  icon,
  label,
  compact = true,
}: {
  icon: React.ReactNode;
  label: string;
  compact?: boolean;
}) {
  return (
    <span className={`tool-trigger${compact ? " compact" : ""}`}>
      <span className="tool-trigger-icon" aria-hidden="true">{icon}</span>
      {!compact && <span className="tool-trigger-copy">{label}</span>}
    </span>
  );
}

export function TopbarTools({ snapshot }: { snapshot: Snapshot }) {
  const theme = useStore((s) => s.theme);
  const toggleTheme = useStore((s) => s.toggleTheme);
  const redesign = useSettings((s) => Boolean(s.get("redesignShell")));
  const audioEnabled = snapshot.session.audioEnabled ?? true;
  return (
    <div className="topbar-tools">
      {/* In the redesign the File menu + Export move into the bottom-left "+" control. */}
      {!redesign && <FileMenu snapshot={snapshot} />}
      <Pop label={<ToolTrigger icon={<IconFolder size={15} />} label="Browse audio samples" />} title="Browse audio samples" buttonClassName="icon">
        {() => <SampleBrowser />}
      </Pop>
      <Pop label={<ToolTrigger icon={<IconSettings size={15} />} label="Settings" />} title="Settings" className="settings-pop" buttonClassName="icon">
        {() => <SettingsPanel snapshot={snapshot} />}
      </Pop>
      {!redesign && <ExportTool audioEnabled={audioEnabled} />}
      <TrainingTool training={snapshot.training ?? null} />
      <CommandLogTool />
      <RemoteTool />
      <MultiplayerTool />
      <HelpTool />
      <button
        type="button"
        className="btn icon"
        title="Toggle theme"
        aria-label="Toggle light/dark theme"
        onClick={toggleTheme}
      >
        {theme === "dark" ? <IconSun size={15} /> : <IconMoon size={15} />}
      </button>
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
  const run = (id: ActionId, opts?: { file?: string; index?: number }) =>
    void runAction(id, { store: useStore.getState(), pickFiles, pickSaveFile }, opts);
  return (
    <Pop label="File" title="File menu" ariaLabel="File" className="menu-pop">
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
                    : recents.map((p, i) => (
                        <button key={p.path} className="menu-item sub" role="menuitem" title={p.path}
                                disabled={p.path === s.editFile}
                                onClick={() => { run("open_recent", { index: i }); close(); }}>
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

export function TrainingTool({
  training,
  label,
  title: buttonTitle,
  className,
  ariaLabel,
  testId,
}: { training: TrainingState | null } & ToolChromeProps) {
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
    <Pop
      label={label ?? "LoRA"}
      title={buttonTitle ?? "Type-beat training"}
      className={`training-pop${className ? ` ${className}` : ""}`}
      ariaLabel={ariaLabel ?? "Type-beat training"}
      testId={testId}
    >
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
              {jobs.map((j) => {
                const v = deriveTrainingJob(j);
                return (
                  <div key={j.jobId} className={`training-job phase-${v.phase}`} data-testid={`training-job-${j.jobId}`}>
                    <div className="plugin-row">
                      <span className="pr-name" title={j.jobId}>{j.jobId}</span>
                      <span className={`cmdlog-badge${v.phase === "error" ? " err" : ""}`}>{v.label}</span>
                      {v.canImport && <button className="btn" onClick={() => void exec("import_lora_adapter", { jobId: j.jobId }).then(refresh)}>Import</button>}
                    </div>
                    {v.showProgress && (
                      <div className="training-progress" role="progressbar" aria-valuenow={v.progressPct} aria-valuemin={0} aria-valuemax={100} aria-label={`Training ${j.jobId}`}>
                        <div className="training-progress-fill" style={{ width: `${v.progressPct}%` }} />
                      </div>
                    )}
                    {v.errorText && <div className="pop-note training-job-error" role="alert">{v.errorText}</div>}
                  </div>
                );
              })}
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
export function HelpTool({ label, title, className, ariaLabel, testId }: ToolChromeProps = {}) {
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
    <Pop
      label={label ?? "?"}
      title={title ?? "Keyboard shortcuts"}
      className={`help-pop${className ? ` ${className}` : ""}`}
      ariaLabel={ariaLabel ?? "Keyboard shortcuts"}
      testId={testId}
    >
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

function ExportTool({ audioEnabled }: { audioEnabled: boolean }) {
  return (
    <Pop
      label={<ToolTrigger icon={<IconDownload size={15} />} label="Export the mix" />}
      title={audioEnabled ? "Export the mix" : "No audio device — export disabled"}
      buttonClassName="icon"
    >
      {() => <ExportControls audioEnabled={audioEnabled} />}
    </Pop>
  );
}

export function CommandLogTool({ label, title, className, ariaLabel, testId }: ToolChromeProps = {}) {
  const exec = useStore((s) => s.exec);
  const [log, setLog] = useState<CommandLogData | null>(null);
  const [loading, setLoading] = useState(false);
  const load = async () => { setLoading(true); const r = await exec("get_command_log", { limit: 50 }); if (r.ok && r.data) setLog(r.data as CommandLogData); setLoading(false); };
  const entries = log?.entries ?? [];
  return (
    <Pop
      label={label ?? "☰"}
      title={title ?? "Command log"}
      className={className}
      ariaLabel={ariaLabel ?? "Command log"}
      testId={testId}
    >
      {() => {
        if (!log && !loading) void load();
        return (
          <>
            <div className="pop-head">Command log <button className="btn icon" title="Refresh" aria-label="Refresh command log" onClick={() => void load()}><IconRefresh size={14} /></button></div>
            <div className="pop-note">{loading ? "Loading…" : `${entries.length} of ${log?.total ?? 0} · newest first`}</div>
            <div className="cmdlog-list" data-testid="command-log">
              {entries.length === 0 && !loading ? <div className="rack-empty">no commands yet</div> :
                entries.map((e, i) => (
                  <div className={`cmdlog-row${e.ok ? "" : " err"}`} key={i}>
                    <span className={`cmdlog-dot${e.ok ? " ok" : " err"}`}>{e.ok ? <IconCheck size={12} /> : <IconX size={12} />}</span>
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
export function MultiplayerTool({ label, title, className, ariaLabel, testId }: ToolChromeProps = {}) {
  const active = useStore((s) => s.mp.active);
  const peerCount = useStore((s) => Object.keys(s.peers).length);
  return (
    <Pop
      label={label ?? (active ? `Live · ${peerCount}` : "Multiplayer")}
      title={title ?? "2-player session"}
      on={active}
      className={`mp-pop${className ? ` ${className}` : ""}`}
      ariaLabel={ariaLabel ?? (active ? `Multiplayer active with ${peerCount} peers` : "Open multiplayer tools")}
      testId={testId}
    >
      {() => <MultiplayerPanel />}
    </Pop>
  );
}

export function RemoteTool({ label, title, className, ariaLabel, testId }: ToolChromeProps = {}) {
  const remote = useStore((s) => s.remoteStatus);
  const start = useStore((s) => s.startRemotePairing);
  const stop = useStore((s) => s.stopRemote);
  const lastError = useStore((s) => s.lastError);
  const pairing = remote?.pairing;
  const running = remote?.running ?? false;
  return (
    <Pop
      label={label ?? "iPhone"}
      title={title ?? "Pair iPhone companion"}
      on={running}
      className={`remote-pop${className ? ` ${className}` : ""}`}
      ariaLabel={ariaLabel ?? "Pair iPhone companion"}
      testId={testId}
    >
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
