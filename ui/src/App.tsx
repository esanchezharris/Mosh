import { useEffect, useState } from "react";
import * as QRCode from "qrcode";
import { useStore } from "./store";
import { isNative } from "./bridge";
import { Arrangement } from "./components/Arrangement";
import { Mixer } from "./components/Mixer";
import { Transport } from "./components/Transport";
import { Rack } from "./components/Rack";
import { PluginBrowser } from "./components/PluginBrowser";
import { PianoRoll } from "./components/PianoRoll";
import { AutomationPanel } from "./components/AutomationPanel";
import { Settings } from "./components/Settings";
import { ContentBrowser } from "./components/ContentBrowser";
import { CommandLog } from "./components/CommandLog";
import { ExportDialog } from "./components/ExportDialog";
import { useKeyboardShortcuts } from "./hooks/useKeyboardShortcuts";
import { useFileDrop } from "./hooks/useFileDrop";

// Stage 1 UI: renders the MoshOps snapshot cold, drives every mutation through
// execute_command, and reacts to the snapshot+events feed. Deliberately thin and
// conventional — Stage 2 grows this into the full arrangement (drag/trim/split,
// zoom/snap, marquee). The backend has zero knowledge of any of it (swappable seam).
export function App() {
  const init = useStore((s) => s.init);
  const snapshot = useStore((s) => s.snapshot);
  const lastError = useStore((s) => s.lastError);
  const view = useStore((s) => s.view);
  const setView = useStore((s) => s.setView);
  const theme = useStore((s) => s.theme);
  const toggleTheme = useStore((s) => s.toggleTheme);

  // Audio-engine gate (MON-007 / FLY-004): pure view logic, no command. Disables
  // Export + drives the banner; Transport reads the same field to gate play/record.
  const audioEnabled = snapshot?.session.audioEnabled ?? false;

  // Global keyboard-shortcut layer (CTL-002) — window keydown, ignores text inputs.
  useKeyboardShortcuts();

  // Drag-and-drop audio import (BRW-007) — bytes-over-bridge via import_clip_data.
  const dragging = useFileDrop();

  useEffect(() => {
    init();
  }, [init]);

  if (!isNative()) {
    return (
      <div className="boot">
        <h2>Mosh</h2>
        <p>Running outside the JUCE WebView (pure-web dev). Launch the Mosh app
        to drive the engine.</p>
      </div>
    );
  }

  return (
    <div className="daw">
      <header className="topbar">
        <div className="brand-min">
          <span className="logo-min">M</span> Mosh
        </div>
        <Transport />
        <div className="view-toggle" role="group" aria-label="View">
          <button className={view === "arrange" ? "on" : ""} onClick={() => setView("arrange")}>Arrange</button>
          <button className={view === "mixer" ? "on" : ""} onClick={() => setView("mixer")}>Mixer</button>
        </div>
        <div className="topbar-right">
          <ContentBrowser />
          <Settings />
          <CommandLog />
          <RemoteCompanion />
          {/* Reserved B-5 / Monster operator slot (deferred — empty in v0). */}
          <span className="b5-slot" title="B-5 / Monster — reserved (deferred)">B-5</span>
          <ExportDialog audioEnabled={audioEnabled} />
          <button className="tool-btn" onClick={toggleTheme} title="Toggle theme">
            {theme === "dark" ? "☾" : "☀"}
          </button>
        </div>
      </header>

      {!audioEnabled && (
        <div className="error-bar">
          ⚠ No audio device — playback, record and export are disabled. Open Settings (⚙) to choose a device.
        </div>
      )}
      {lastError && <div className="error-bar">⚠ {lastError}</div>}

      {snapshot ? (
        <>
          {view === "mixer" ? <Mixer snapshot={snapshot} /> : <Arrangement snapshot={snapshot} />}
          <Rack snapshot={snapshot} />
        </>
      ) : (
        <div className="boot"><p>Loading snapshot…</p></div>
      )}

      <PluginBrowser />
      <PianoRoll />
      <AutomationPanel />

      {dragging && (
        <div className="drop-overlay" aria-hidden="true">
          <div className="drop-overlay-inner">Drop audio to import</div>
        </div>
      )}
    </div>
  );
}

function RemoteCompanion() {
  const remote = useStore((s) => s.remoteStatus);
  const start = useStore((s) => s.startRemotePairing);
  const stop = useStore((s) => s.stopRemote);
  const [open, setOpen] = useState(false);
  const [pairingMode, setPairingMode] = useState<"native" | "web">("native");

  const pairing = remote?.pairing;
  const isRunning = remote?.running ?? false;
  const code = pairing?.token.slice(0, 6).toUpperCase() ?? "";
  const expires = pairing ? new Date(pairing.expiresAtMs).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }) : "";
  const pairingTarget = pairingMode === "web" ? pairing?.webUrl : pairing?.pairingUrl;
  const [copied, setCopied] = useState(false);

  return (
    <div className="remote-companion">
      <button
        className={`tool-btn remote-btn ${isRunning ? "on" : ""}`}
        onClick={async () => {
          if (!isRunning) await start();
          setOpen((v) => !v);
        }}
        title="Pair iPhone companion"
      >
        iPhone
      </button>
      {open && (
        <div className="remote-pop">
          <div className="remote-head">
            <strong>iPhone Companion</strong>
            <button className="mini" onClick={() => setOpen(false)}>x</button>
          </div>
          {pairing ? (
            <>
              <div className="remote-mode" role="group" aria-label="iPhone pairing mode">
                <button className={pairingMode === "native" ? "active" : ""} onClick={() => setPairingMode("native")}>Native</button>
                <button className={pairingMode === "web" ? "active" : ""} onClick={() => setPairingMode("web")}>Safari</button>
              </div>
              {pairingTarget && <PairingQRCode url={pairingTarget} />}
              <div className="remote-code">{code}</div>
              <div className="remote-meta">{pairing.host}:{pairing.port} · expires {expires}</div>
              <button
                className="remote-copy"
                onClick={async () => {
                  if (!pairingTarget) return;
                  await navigator.clipboard.writeText(pairingTarget);
                  setCopied(true);
                  window.setTimeout(() => setCopied(false), 1400);
                }}
              >
                {copied ? "Copied" : `Copy ${pairingMode === "web" ? "Safari" : "native"} link`}
              </button>
              <button className="remote-stop" onClick={stop}>Stop remote</button>
            </>
          ) : (
            <button className="remote-start" onClick={start}>Start pairing</button>
          )}
        </div>
      )}
    </div>
  );
}

function PairingQRCode({ url }: { url: string }) {
  const [dataUrl, setDataUrl] = useState("");

  useEffect(() => {
    let cancelled = false;
    void QRCode.toDataURL(url, {
      margin: 1,
      width: 180,
      color: { dark: "#111318", light: "#ffffff" },
    }).then((next) => {
      if (!cancelled) setDataUrl(next);
    });
    return () => { cancelled = true; };
  }, [url]);

  return dataUrl ? <img className="remote-qr" src={dataUrl} alt="MOSH iPhone pairing QR code" /> : null;
}
