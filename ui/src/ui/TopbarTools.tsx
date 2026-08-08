// Topbar utility cluster: theme toggle + Settings / Export / Command-log /
// iPhone-companion popovers. Ported from the legacy components into the ink+lime
// register; every mutation stays a command on the seam (native file dialogs only
// resolve paths). In Vite dev the mock drives Settings/Export/Log; the iPhone
// companion is real-backend only (the mock reports it unavailable).

import { Fragment, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import * as QRCode from "qrcode";
import { useStore } from "../store";
import { useSettings } from "../settings/store";
import { pickFiles, pickSaveFile, brainChat } from "../bridge";
import { runAction, FILE_MENU, type ActionId } from "../menuActions";
import { RecentProjectList } from "./RecentProjectList";
import { historyRows, historyRowHint } from "./commandLogHistory";
import type { Snapshot, CommandLog as CommandLogData, TrainingState } from "../types";
import { SampleBrowser } from "./SampleBrowser";
import { SettingsPanel } from "../settings/SettingsPanel";
import { trainingPreviewLabel } from "../capabilities";
import { MultiplayerPanel } from "./MultiplayerPanel";
import { ExportControls } from "./ExportControls";
import { deriveTrainingJob } from "./trainingJobView";
import { ConfirmDialog } from "./ConfirmDialog";
import { isInModalLayer } from "../hooks/modalLayer";
import { copyText } from "../clipboard";
import type { MemoryRecord } from "../agent/memory/retrieveContext";
import {
  isDrumPatternCard, isLyricFrameworkCard, summarizeDrumPatternCard, summarizeLyricFrameworkCard,
} from "../agent/memory/patternCards";
import { invalidateMemoryHydration } from "../agent/memory/hydrate";
import { projectMemoryPath } from "../agent/memory/projectMemoryPath";
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
  onOpen,
}: {
  label: React.ReactNode;
  title: string;
  on?: boolean;
  className?: string;
  buttonClassName?: string;
  ariaLabel?: string;
  testId?: string;
  children: (close: () => void) => React.ReactNode;
  // Fires on the open transition only (not on close, not on mount) — the hook for a
  // lazy per-popover data fetch (e.g. TrainingTool's guest-degradation capability
  // load) that must wait for the user to actually open the popover rather than firing
  // as soon as the always-mounted topbar tool renders.
  onOpen?: () => void;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    // isInModalLayer: a ConfirmDialog opened from inside this popover is portaled to
    // document.body, so it is not a DOM descendant and a click in it would otherwise
    // read as "outside" and close the popover out from under its own dialog.
    const onDoc = (e: MouseEvent) => {
      const t = e.target as Node;
      if (ref.current && !ref.current.contains(t) && !isInModalLayer(t)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setOpen(false); };
    document.addEventListener("mousedown", onDoc); document.addEventListener("keydown", onKey);
    return () => { document.removeEventListener("mousedown", onDoc); document.removeEventListener("keydown", onKey); };
  }, [open]);
  const toggle = () => setOpen((v) => {
    const next = !v;
    if (next) onOpen?.();
    return next;
  });
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
        onClick={toggle}
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
export function FileMenu({ snapshot }: { snapshot: Snapshot }) {
  const s = snapshot.session;
  const run = (id: ActionId, opts?: { file?: string; index?: number }) =>
    void runAction(id, { store: useStore.getState(), pickFiles, pickSaveFile, chat: brainChat }, opts);
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
                  <RecentProjectList snapshot={snapshot} variant="sub" emptyLabel="no recent projects"
                    onPick={(i) => { run("open_recent", { index: i }); close(); }} />
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
  // Guest degradation: the trainer is a deterministic-stub scaffold everywhere until the
  // owner points MOSH_TRAINING_REMOTE_URL at a rented GPU box — label it so a tester
  // doesn't mistake a completed "training run" for a real fine-tune. loadCapabilities is
  // triggered lazily via Pop's onOpen below (see that prop's comment for why not here).
  const previewLabel = useStore((s) => trainingPreviewLabel(s.capabilities));
  const loadCapabilities = useStore((s) => s.loadCapabilities);
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
      // Guest degradation: TrainingTool itself is always mounted (part of the topbar/
      // overflow tools), so a plain useEffect here would fire at app load — the same
      // eager-spawn bug this pass fixed elsewhere. onOpen only fires on the actual
      // open transition (a user click), the correct lazy trigger point.
      onOpen={loadCapabilities}
    >
      {() => (
        <>
          <div className="pop-head">Type-Beat Training{previewLabel && (
            <span className="pop-head-badge" data-testid="training-preview-badge"
              title="This trains a deterministic placeholder LoRA stub on this Mac — no GPU, no real fine-tune">{previewLabel}</span>
          )}</div>
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
    ["⇧⌘R", "Export audio"],
    ["⌘Z · ⇧⌘Z", "Undo · Redo"],
    ["⌘X · ⌘C · ⌘V", "Cut · Copy · Paste clip"],
    ["Space", "Play / pause"],
    ["Delete  ⌫", "Remove selected clip"],
    ["Drag clip", "Move · drag an edge to trim"],
    ["⌥-drag", "Temporarily bypass Snap"],
    ["Click ruler", "Seek · ⇧-drag selects a range"],
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
          <div className="pop-note">Tools (Move / Split / Range) &amp; Snap live in the toolbar. Hold Option during a drag for free placement.</div>
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

// The popover body loads the command log from an effect on mount. Because Pop only
// renders its children while open, mounting == opening, so the mount effect replaces
// the former render-time `void load()` (which set state during Pop's render). State
// lives in the parent so the fetched log survives close/reopen (load-once caching).
function CommandLogBody({
  log,
  loading,
  load,
  jump,
}: {
  log: CommandLogData | null;
  loading: boolean;
  load: () => void;
  // CAP-PRJ-005 — restore the session to a row's history point. Null while a jump is in
  // flight is not modelled: the jump is synchronous from the UI's point of view (one
  // command, then a reload of the log), so the only state it needs is the error.
  jump: (txn: string) => void;
}) {
  useEffect(() => {
    if (!log && !loading) load();
    // Load once on open; the guard keeps a cached log from re-fetching on reopen.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const entries = log?.entries ?? [];
  const rows = historyRows(log);
  return (
    <>
      <div className="pop-head">Command log <button className="btn icon" title="Refresh" aria-label="Refresh command log" onClick={load}><IconRefresh size={14} /></button></div>
      <div className="pop-note">{loading ? "Loading…" : `${entries.length} of ${log?.total ?? 0} · newest first · click a step to go back to it`}</div>
      <div className="cmdlog-list" data-testid="command-log">
        {entries.length === 0 && !loading ? <div className="rack-empty">no commands yet</div> :
          rows.map((row, i) => {
            const e = row.entry;
            const cls = `cmdlog-row${e.ok ? "" : " err"} cmdlog-${row.kind}${row.isCurrent ? " cmdlog-current" : ""}`;
            const body = (
              <>
                <span className={`cmdlog-dot${e.ok ? " ok" : " err"}`}>{e.ok ? <IconCheck size={12} /> : <IconX size={12} />}</span>
                <span className="cmdlog-name tc" title={e.error ?? e.command}>{e.command}</span>
                {row.isCurrent && <span className="cmdlog-badge cmdlog-here">here</span>}
                {!row.isCurrent && e.undoable && <span className="cmdlog-badge">undo</span>}
              </>
            );
            // Only a reachable point you are not already standing on is a control. The
            // other two kinds stay visible — the log is useful BECAUSE it shows
            // everything — but they are plain rows, so nothing offers a restore it
            // cannot deliver.
            return row.txn && !row.isCurrent ? (
              <button
                type="button"
                className={cls}
                key={i}
                data-testid="command-log-restore"
                title={`${e.error ?? e.command} — ${historyRowHint(row)}`}
                onClick={() => jump(row.txn!)}
              >
                {body}
              </button>
            ) : (
              <div className={cls} key={i} title={`${e.error ?? e.command} — ${historyRowHint(row)}`}>
                {body}
              </div>
            );
          })}
      </div>
    </>
  );
}

export function CommandLogTool({ label, title, className, ariaLabel, testId }: ToolChromeProps = {}) {
  const exec = useStore((s) => s.exec);
  const [log, setLog] = useState<CommandLogData | null>(null);
  const [loading, setLoading] = useState(false);
  const load = async () => { setLoading(true); const r = await exec("get_command_log", { limit: 50 }); if (r.ok && r.data) setLog(r.data as CommandLogData); setLoading(false); };
  // CAP-PRJ-005 — the click. Reload afterwards either way: on success the "here" marker
  // and the reachable set both moved, and on refusal (a point overwritten since this
  // window was fetched) the fresh log is what shows the producer why.
  const jump = async (txn: string) => {
    await exec("jump_to_history", { txn });
    await load();
  };
  return (
    <Pop
      label={label ?? "☰"}
      title={title ?? "Command log"}
      className={className}
      ariaLabel={ariaLabel ?? "Command log"}
      testId={testId}
    >
      {() => <CommandLogBody log={log} loading={loading} load={() => void load()} jump={(txn) => void jump(txn)} />}
    </Pop>
  );
}

// AGT-MEM (M3) — the memory panel: what Moshi has stored, per tier, with per-item
// forget + per-tier clear + a path-to-clipboard "reveal" (no native reveal-in-finder
// bridge command exists — see exportPath.ts/ExportControls.tsx's identical posture,
// reused verbatim here). Fully reloads on every open (no cross-open cache like
// CommandLogBody's — a delete/clear/remember made since the last open must show up
// immediately, and a manual Refresh is also offered for mid-session changes from chat).
type MemoryTierId = "preference" | "drum_pattern" | "lyric_framework" | "project";
type MemoryTierDef = { id: MemoryTierId; label: string; scope: "global" | "project"; kind?: string };
const MEMORY_TIERS: readonly MemoryTierDef[] = [
  { id: "preference", label: "Preferences", scope: "global", kind: "preference" },
  { id: "drum_pattern", label: "Drum patterns", scope: "global", kind: "drum_pattern" },
  { id: "lyric_framework", label: "Lyric frameworks", scope: "global", kind: "lyric_framework" },
  { id: "project", label: "This project", scope: "project" },
];

function formatMemoryItem(item: unknown): string {
  if (typeof item === "string") return item;
  // AGT-MEM (M4) — a DrumPatternCard/LyricFrameworkCard gets its own compact, human-
  // readable summary (verbatim pattern string / grid+rhyme+role breakdown) instead of
  // falling through to raw JSON — this panel predates those card shapes (M3), so
  // without this check any saved/seed pattern card would otherwise show as an
  // unreadable JSON blob (caught by pattern-library.spec.ts's e2e read of this panel).
  if (isDrumPatternCard(item)) return `"${item.name}" — ${summarizeDrumPatternCard(item)}`;
  if (isLyricFrameworkCard(item)) return `"${item.name}" — ${summarizeLyricFrameworkCard(item)}`;
  try { return JSON.stringify(item); } catch { return String(item); }
}

function MemoryBody({ editFile }: { editFile: string }) {
  const exec = useStore((s) => s.exec);
  const [tiers, setTiers] = useState<Record<MemoryTierId, MemoryRecord[]> | null>(null);
  const [loading, setLoading] = useState(false);
  const [copied, setCopied] = useState<"global" | "project" | null>(null);
  const [pendingClear, setPendingClear] = useState<MemoryTierId | null>(null);

  const load = async () => {
    setLoading(true);
    const results = await Promise.all(
      MEMORY_TIERS.map((t) => exec("agent_memory_read", t.kind ? { scope: t.scope, kind: t.kind } : { scope: t.scope })),
    );
    const next = {} as Record<MemoryTierId, MemoryRecord[]>;
    MEMORY_TIERS.forEach((t, i) => {
      const r = results[i];
      const items = r.ok ? (r.data as { items?: MemoryRecord[] } | undefined)?.items : undefined;
      next[t.id] = Array.isArray(items) ? items : [];
    });
    setTiers(next);
    setLoading(false);
  };

  useEffect(() => {
    if (!tiers && !loading) void load();
    // Load once on open; the panel fully remounts on close (Pop unmounts its render-
    // prop children), so reopening always re-runs this — that IS the "fully reloads on
    // every open" behavior described above, not a bug in the dep array.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const remove = async (t: MemoryTierDef, rec: MemoryRecord) => {
    const r = await exec("agent_memory_delete", t.kind ? { scope: t.scope, kind: t.kind, ts: rec.ts } : { scope: t.scope, ts: rec.ts });
    if (r.ok) { invalidateMemoryHydration(); await load(); }
  };

  const clearTier = async (t: MemoryTierDef) => {
    const r = await exec("agent_memory_clear", t.kind ? { scope: t.scope, kind: t.kind } : { scope: t.scope });
    setPendingClear(null);
    if (r.ok) { invalidateMemoryHydration(); await load(); }
  };

  const copyPath = async (which: "global" | "project") => {
    const path = which === "global" ? "~/Library/Mosh/agent" : projectMemoryPath(editFile);
    if (!path) return;
    const ok = await copyText(path);
    if (ok) { setCopied(which); window.setTimeout(() => setCopied(null), 1600); }
  };

  const pendingTier = pendingClear ? MEMORY_TIERS.find((t) => t.id === pendingClear) : undefined;

  return (
    <>
      <div className="pop-head">
        <span>What Moshi remembers</span>
        <button className="btn icon" title="Refresh" aria-label="Refresh memory" onClick={() => void load()}><IconRefresh size={14} /></button>
      </div>
      <div className="pop-note">{loading ? "Loading…" : "newest first · pruned locally, folded into a few prompts each turn"}</div>
      {MEMORY_TIERS.map((t) => {
        const items = tiers?.[t.id] ?? [];
        return (
          <div className="mem-tier" key={t.id} data-testid={`memory-tier-${t.id}`}>
            <div className="mem-tier-head">
              <span className="mem-tier-label">{t.label}</span>
              <span className="mem-tier-count">{items.length}</span>
              {items.length > 0 && (
                <button className="btn mem-clear" onClick={() => setPendingClear(t.id)}>Clear</button>
              )}
            </div>
            {items.length === 0 && !loading ? (
              <div className="rack-empty">nothing yet</div>
            ) : (
              <div className="mem-item-list">
                {items.map((rec) => (
                  <div className="mem-item-row" key={rec.ts}>
                    {rec.explicit && <span className="mem-badge" title="You asked Moshi to remember this">★</span>}
                    {t.id === "project" && rec.kind !== "preference" && <span className="mem-kind" title="kind">{rec.kind}</span>}
                    <span className="mem-item-text" title={formatMemoryItem(rec.item)}>{formatMemoryItem(rec.item)}</span>
                    <button className="btn icon mem-del" title="Forget this" aria-label="Forget this" onClick={() => void remove(t, rec)}><IconX size={11} /></button>
                  </div>
                ))}
              </div>
            )}
          </div>
        );
      })}
      <div className="pop-group">
        <div className="pop-actions">
          <button className="btn" onClick={() => void copyPath("global")}>{copied === "global" ? "Copied ✓" : "Copy global memory path"}</button>
          {editFile && <button className="btn" onClick={() => void copyPath("project")}>{copied === "project" ? "Copied ✓" : "Copy this project's memory path"}</button>}
        </div>
        <div className="pop-note">Folder hidden by default — in Finder press ⌘⇧G (Go to Folder) and paste it.</div>
      </div>
      {/* Portaled to <body> (same precedent as TrackLaneList's delete-track confirm).
          `.v2-menu-panel` carries `backdrop-filter`, which makes it the containing block
          for `position: fixed` descendants — so rendered in place, `.modal-backdrop`'s
          `inset: 0` resolved to the 248px panel instead of the viewport, and this 374px
          dialog overflowed it. It was only ever reachable because the shell happened to
          be scrolled right; measured at a 1280px viewport, "Cancel" sat at x=1304. */}
      {pendingTier && createPortal(
        <ConfirmDialog
          title={`Clear ${pendingTier.label}?`}
          body="This removes everything Moshi has stored here, including anything you explicitly asked it to remember. This can't be undone."
          confirmLabel="Clear"
          danger
          onConfirm={() => void clearTier(pendingTier)}
          onCancel={() => setPendingClear(null)}
          testId="memory-clear-confirm"
        />,
        document.body,
      )}
    </>
  );
}

export function MemoryTool({ label, title, className, ariaLabel, testId }: ToolChromeProps = {}) {
  // Respect the agentMemory flag: with recall off there's nothing to show or prune, so
  // the tool doesn't render at all (mirrors the flag's "no recall" framing in
  // settings/schema.ts rather than showing an always-empty panel).
  const memoryOn = useSettings((s) => s.get("agentMemory") !== false);
  const editFile = useStore((s) => s.snapshot?.session.editFile ?? "");
  if (!memoryOn) return null;
  return (
    <Pop
      label={label ?? "✶"}
      title={title ?? "What Moshi remembers"}
      className={className}
      ariaLabel={ariaLabel ?? "What Moshi remembers"}
      testId={testId}
    >
      {() => <MemoryBody editFile={editFile} />}
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
