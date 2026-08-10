import { useEffect, useRef, useState } from "react";
import { isNative } from "../bridge";
import { MoshTipProvider } from "../chrome/Tooltip";
import { pushEscapeHandler } from "../hooks/escapeStack";
import { useFileDrop } from "../hooks/useFileDrop";
import { useKeyboardShortcuts } from "../hooks/useKeyboardShortcuts";
import { useQwertyMidi } from "../hooks/useQwertyMidi";
import { formatPeerError } from "../multiplayer/peerErrors";
import { SettingsPanel } from "../settings/SettingsPanel";
import { useStore } from "../store";
import { AudioDeviceNotice } from "../ui/AudioDeviceNotice";
import { RecoveryNotice } from "../ui/RecoveryNotice";
import { ProToolsArrangement } from "./ProToolsArrangement";
import { ProToolsDetailDock } from "./ProToolsDetailDock";
import { ProToolsMoshiDrawer } from "./ProToolsMoshiDrawer";
import { ProToolsStatusBar } from "./ProToolsStatusBar";
import { ProToolsToolbar } from "./ProToolsToolbar";
import { useProTools } from "./proToolsState";
import { useProToolsKeys } from "./useProToolsKeys";
import "./protools.css";

export function AppProTools() {
  const snapshot = useStore((s) => s.snapshot);
  const projectEpoch = useStore((s) => s.projectEpoch);
  const lastError = useStore((s) => s.lastError);
  const peers = useStore((s) => s.peers);
  const setRipple = useStore((s) => s.setRipple);
  const setSnap = useStore((s) => s.setSnap);
  const editMode = useProTools((s) => s.editMode);
  const classicTheme = useProTools((s) => s.classicTheme);
  const resetForProject = useProTools((s) => s.resetForProject);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [moshiOpen, setMoshiOpen] = useState(false);
  const moshiButtonRef = useRef<HTMLButtonElement>(null);
  const dragging = useFileDrop();

  useKeyboardShortcuts();
  useProToolsKeys();
  useQwertyMidi();

  useEffect(() => resetForProject(projectEpoch), [projectEpoch, resetForProject]);
  useEffect(() => {
    setRipple(editMode === "shuffle");
    setSnap(editMode === "grid");
  }, [editMode, setRipple, setSnap]);

  if (!isNative()) return (
    <div className="protools-shell" data-testid="protools-shell">
      <div className="pt-boot">
        <h2>MOSH — PRO TOOLS</h2>
        <p>Running outside the engine. Launch Mosh to drive this editing surface.</p>
      </div>
    </div>
  );

  const displayError = lastError ? formatPeerError(lastError, peers) : null;
  return (
    <MoshTipProvider delay={300}>
      <div className="protools-shell" data-testid="protools-shell"
        data-pt-theme={classicTheme ? "classic" : "dark"}
        data-edit-mode={editMode}>
        {snapshot && <ProToolsToolbar snapshot={snapshot} onOpenSettings={() => setSettingsOpen(true)}
          moshiOpen={moshiOpen} onToggleMoshi={() => setMoshiOpen((open) => !open)}
          moshiButtonRef={moshiButtonRef} />}
        {displayError && <div className="pt-error-bar" role="alert" data-testid="pt-error">⚠ {displayError}</div>}
        <RecoveryNotice />
        <AudioDeviceNotice />
        <main className="pt-shell-main">
          {snapshot
            ? <ProToolsArrangement snapshot={snapshot} />
            : <div className="pt-loading" role="status">Loading Edit Window…</div>}
          {dragging && <div className="pt-drop-overlay" role="status">Drop audio to import at the playhead</div>}
        </main>
        <ProToolsDetailDock />
        <ProToolsStatusBar snapshot={snapshot} />
        <ProToolsMoshiDrawer open={moshiOpen} onClose={() => setMoshiOpen(false)}
          returnFocusRef={moshiButtonRef} />
        {settingsOpen && snapshot && (
          <SettingsOverlay onClose={() => setSettingsOpen(false)} />
        )}
      </div>
    </MoshTipProvider>
  );
}

const SETTINGS_FOCUSABLE = "button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [href], [tabindex]:not([tabindex='-1'])";

export function SettingsOverlay({ onClose }: { readonly onClose: () => void }) {
  const snapshot = useStore((s) => s.snapshot)!;
  const dialogRef = useRef<HTMLElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const restoreFocusRef = useRef<HTMLElement | null>(null);

  useEffect(() => pushEscapeHandler(onClose), [onClose]);
  useEffect(() => {
    restoreFocusRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    closeRef.current?.focus();
    return () => restoreFocusRef.current?.focus();
  }, []);

  const trapFocus = (event: React.KeyboardEvent<HTMLElement>) => {
    if (event.key !== "Tab") return;
    const dialog = dialogRef.current;
    if (!dialog) return;
    const controls = Array.from(dialog.querySelectorAll<HTMLElement>(SETTINGS_FOCUSABLE))
      .filter((control) => !control.hasAttribute("hidden"));
    const first = controls[0];
    const last = controls.at(-1);
    if (!first || !last) {
      event.preventDefault();
      dialog.focus();
      return;
    }
    const activeElement = document.activeElement;
    if (event.shiftKey && (activeElement === first || !dialog.contains(activeElement))) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && (activeElement === last || !dialog.contains(activeElement))) {
      event.preventDefault();
      first.focus();
    }
  };

  return (
    <div className="pt-settings-backdrop" data-testid="pt-settings-backdrop" role="presentation" onClick={onClose}>
      <section ref={dialogRef} className="pt-settings-dialog" data-testid="pt-settings-dialog"
        role="dialog" aria-modal="true" aria-labelledby="pt-settings-title" tabIndex={-1}
        onClick={(e) => e.stopPropagation()} onKeyDown={trapFocus}>
        <header className="pt-settings-head">
          <h2 id="pt-settings-title">Settings</h2>
          <button ref={closeRef} type="button" className="pt-settings-close"
            data-testid="pt-settings-close" onClick={onClose}>Close</button>
        </header>
        <div className="pt-settings-content"><SettingsPanel snapshot={snapshot} /></div>
      </section>
    </div>
  );
}
