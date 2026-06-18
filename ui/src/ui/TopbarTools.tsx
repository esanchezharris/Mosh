// Topbar utility cluster: theme toggle + Settings / Export / Command-log /
// iPhone-companion popovers. Ported from the legacy components into the ink+lime
// register; every mutation stays a command on the seam (native file dialogs only
// resolve paths). In Vite dev the mock drives Settings/Export/Log; the iPhone
// companion is real-backend only (the mock reports it unavailable).

import { useEffect, useRef, useState } from "react";
import * as QRCode from "qrcode";
import { useStore } from "../store";
import { pickFiles, pickSaveFile } from "../bridge";
import type { Snapshot, ExportFormat, CommandLog as CommandLogData } from "../types";
import { SampleBrowser } from "./SampleBrowser";

// Small popover anchored under its trigger; closes on outside click / Esc.
function Pop({ label, title, on, children }: { label: string; title: string; on?: boolean; children: (close: () => void) => React.ReactNode }) {
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
    <div className="pop-wrap" ref={ref}>
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
      <Pop label="🗀" title="Browse audio samples">{() => <SampleBrowser />}</Pop>
      <SettingsTool snapshot={snapshot} />
      <ExportTool audioEnabled={audioEnabled} />
      <CommandLogTool />
      <RemoteTool />
      <HelpTool />
      <button className="btn icon" title="Toggle theme" aria-label="Toggle light/dark theme" onClick={toggleTheme}>{theme === "dark" ? "☾" : "☀"}</button>
    </div>
  );
}

// Keyboard-shortcut help — the bindings live in Arrange's keydown handler + the
// ruler/clip pointer handlers; surfaced here so they're discoverable.
function HelpTool() {
  const SHORTCUTS: [string, string][] = [
    ["Space", "Play / pause"],
    ["Delete  ⌫", "Remove selected clip"],
    ["⌘/Ctrl + Z", "Undo"],
    ["⌘/Ctrl + ⇧ + Z", "Redo"],
    ["Drag clip", "Move · drag an edge to trim"],
    ["Click ruler", "Seek · ⇧-drag sets the loop"],
  ];
  return (
    <Pop label="?" title="Keyboard shortcuts">
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

function SettingsTool({ snapshot }: { snapshot: Snapshot }) {
  const exec = useStore((s) => s.exec);
  const refresh = useStore((s) => s.refresh);
  const uiScale = useStore((s) => s.uiScale);
  const setUiScale = useStore((s) => s.setUiScale);
  const s = snapshot.session;
  return (
    <Pop label="⚙" title="Settings">
      {() => (
        <>
          <div className="pop-head">Settings</div>
          <div className="pop-group">
            <div className="pop-label">Audio</div>
            <div className="pop-row"><span>Device</span><span className="tc">{s.audioDeviceName ?? (s.audioEnabled ? "default" : "—")}</span></div>
            <div className="pop-row"><span>Sample rate</span><span className="tc">{s.sampleRate} Hz</span></div>
            <label className="pop-row"><span>Buffer</span>
              <select value={String(s.bufferSize ?? 512)} onChange={(e) => void exec("set_buffer_size", { bufferSize: Number(e.target.value) }).then(() => refresh())}>
                {[128, 256, 512, 1024].map((b) => <option key={b} value={b}>{b}</option>)}
              </select>
            </label>
            <label className="pop-row"><span>Threads</span>
              <select value={String(s.audioThreads ?? s.availableCores ?? 8)} onChange={(e) => void exec("set_audio_threads", { threads: Number(e.target.value) }).then(() => refresh())}>
                {Array.from({ length: s.availableCores ?? 8 }, (_, i) => i + 1).map((n) => <option key={n} value={n}>{n}{s.audioThreadsAuto && n === (s.audioThreads ?? n) ? " (auto)" : ""}</option>)}
              </select>
            </label>
          </div>
          <div className="pop-group">
            <div className="pop-label">Interface</div>
            <div className="pop-row"><span>UI scale</span>
              <span className="scale-ctl">
                <button className="btn" disabled={uiScale <= 0.8} onClick={() => setUiScale(Math.round((uiScale - 0.1) * 10) / 10)}>−</button>
                <span className="tc">{Math.round(uiScale * 100)}%</span>
                <button className="btn" disabled={uiScale >= 1.4} onClick={() => setUiScale(Math.round((uiScale + 0.1) * 10) / 10)}>+</button>
              </span>
            </div>
          </div>
          <div className="pop-group">
            <div className="pop-label">Project{s.dirty ? <span className="pop-note" title="Unsaved changes (auto-saved)"> • unsaved</span> : null}</div>
            <div className="pop-actions">
              <button className="btn" onClick={() => void exec("new_project", {}).then(() => refresh())}>New</button>
              <button className="btn" onClick={() => void exec("save", {})}>Save</button>
              <button className="btn" onClick={async () => { const r = await pickSaveFile({ title: "Save project as" }); if (r.ok && r.file) void exec("save_as", { file: r.file }).then(() => refresh()); }}>Save As…</button>
              <button className="btn" onClick={async () => { const r = await pickFiles({ title: "Open project" }); if (r.ok && r.files[0]) void exec("open_project", { file: r.files[0] }).then(() => refresh()); }}>Open…</button>
            </div>
            {(s.recentProjects?.length ?? 0) > 0 && (
              <>
                <div className="pop-label">Recent</div>
                <div className="modal-list" data-testid="recent-projects" style={{ maxHeight: 160 }}>
                  {s.recentProjects!.slice(0, 8).map((p) => (
                    <button key={p.path} className="plugin-row" title={p.path} disabled={p.path === s.editFile}
                            onClick={() => void exec("open_project", { file: p.path }).then(() => refresh())}>
                      <span className="pr-name">{p.path === s.editFile ? "● " : ""}{p.name}</span>
                    </button>
                  ))}
                </div>
              </>
            )}
          </div>
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

function RemoteTool() {
  const remote = useStore((s) => s.remoteStatus);
  const start = useStore((s) => s.startRemotePairing);
  const stop = useStore((s) => s.stopRemote);
  const lastError = useStore((s) => s.lastError);
  const pairing = remote?.pairing;
  const running = remote?.running ?? false;
  return (
    <Pop label="iPhone" title="Pair iPhone companion" on={running}>
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
