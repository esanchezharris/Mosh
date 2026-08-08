// AppLive — the Live 12 Arrangement-View clone shell (docs/live-clone/SPEC.md).
// ADDITIVE: a third pure client of the same store/seam as classic and v2; the App
// router mounts it when uiShell === "live" (or ?shell=live in dev/e2e). Nothing here
// modifies either existing shell.
//
// Zone model (SPEC §1): control bar (28pt) · browser (left, ~338pt) · arrangement
// (lanes with RIGHT-side track headers) · detail dock (bottom, resizable) · status
// bar (15pt). The dock hosts the docked MIDI editor (Phase 2), the devices view and
// the Moshi stub drawer.
//
// Reuse, deliberately: ClipView + the shared clip canvas renderers are re-skinned
// (never forked) so gestures, snap, drag commit/revert and undo semantics stay
// byte-identical with the other shells; the interaction layer reads the user's
// gesture table through liveGestureTable() — nothing is hardcoded to Ableton. (The
// bar ruler IS a live-specific component — LiveRuler — because Live's vertical
// drag-zoom collides with v2's ruler scrub; see PARITY.md.)

import { useEffect, useRef, useState } from "react";
import { useStore } from "../store";
import { useSettings } from "../settings/store";
import { isNative } from "../bridge";
import { useKeyboardShortcuts } from "../hooks/useKeyboardShortcuts";
import { useQwertyMidi } from "../hooks/useQwertyMidi";
import { useFileDrop } from "../hooks/useFileDrop";
import { isEditableTarget } from "../interaction/keymap";
import { formatPeerError } from "../multiplayer/peerErrors";
import { MoshTipProvider } from "../chrome/Tooltip";
import { RecoveryNotice } from "../ui/RecoveryNotice";
import { AudioDeviceNotice } from "../ui/AudioDeviceNotice";
import { ControlBar } from "./ControlBar";
import { Browser } from "./Browser";
import { OverviewStrip } from "./OverviewStrip";
import { Arrangement } from "./Arrangement";
import { DetailDock } from "./DetailDock";
import { StatusBar } from "./StatusBar";
import { SettingsPanel } from "../settings/SettingsPanel";
import { pushEscapeHandler } from "../hooks/escapeStack";
import { useLive } from "./liveState";
import { useLiveKeys } from "./useLiveKeys";
import { useSelectionFollow } from "./selectionFollow";
import "./live.css";

export function AppLive() {
  const snapshot = useStore((s) => s.snapshot);
  const lastError = useStore((s) => s.lastError);
  const peers = useStore((s) => s.peers);
  // Same peer-name mapping as v2's error bar (#40) — lock denials name people, not UUIDs.
  const displayError = lastError ? formatPeerError(lastError, peers) : null;

  useKeyboardShortcuts(); // the single keyboard layer (keymap setting honoured, ableton by template)
  useLiveKeys();          // live-only keymap surfaces (⌘R clip rename, ⌘F, X) — mount AFTER the app layer
  useSelectionFollow();   // the dock's clip view follows the CLIP SELECTION (Live 12's rule)
  useQwertyMidi();        // the computer keyboard as a MIDI controller
  const dragging = useFileDrop(); // drag-and-drop audio import (bytes over the bridge)

  // Draw mode (B) — Live's pencil toggle. Plain bubble-phase listener: the qwerty
  // instrument never claims B (it owns A..K/WETYU/ZXCV), and the app keymap has no
  // bare-B binding to fight. Editable targets keep their typing, modifiers keep
  // their chords.
  const drawMode = useLive((s) => s.drawMode);
  const settingsOpen = useLive((s) => s.settingsOpen);
  // Expanded Clip View (⌥⌘E) — the attribute hides the browser + arrangement (CSS
  // in live.css); only meaningful while a clip is open in the dock.
  const expandedSetting = useSettings((s) => Boolean(s.get("liveClipExpanded")));
  const editingClipId = useStore((s) => s.editingClipId);
  const clipExpanded = expandedSetting && editingClipId != null;
  // Browser width/hidden (WIDGETS §1: the divider drags 165–331+, and dragging far
  // left hides the browser ENTIRELY, remembering the width; the ▸ strip reopens it).
  const browserHidden = useLive((s) => s.browserHidden);
  const browserWidth = useLive((s) => s.browserWidth);
  const browserW = browserHidden ? 0 : (browserWidth ?? 331);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "b" && e.key !== "B") return;
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (isEditableTarget(e.target) || isEditableTarget(document.activeElement)) return;
      useLive.getState().toggleDrawMode();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // ⌥ held → the copy-drag cursor (RESOURCES.md §cursor). CSS paints the affordance
  // off this attribute; the modifier itself can only be tracked from JS. Cleared on
  // blur so a ⌘-tab away never leaves a stuck copy cursor (the qwerty stuck-note lesson).
  const [altHeld, setAltHeld] = useState(false);
  useEffect(() => {
    const down = (e: KeyboardEvent) => { if (e.key === "Alt") setAltHeld(true); };
    const up = (e: KeyboardEvent) => { if (e.key === "Alt") setAltHeld(false); };
    const clear = () => setAltHeld(false);
    window.addEventListener("keydown", down);
    window.addEventListener("keyup", up);
    window.addEventListener("blur", clear);
    return () => {
      window.removeEventListener("keydown", down);
      window.removeEventListener("keyup", up);
      window.removeEventListener("blur", clear);
    };
  }, []);

  // Opened outside a backend (production build, no JUCE WebView + no dev mock).
  if (!isNative()) {
    return (
      <div className="live-shell" data-testid="live-shell">
        <div className="live-boot">
          <h2>MOSH — LIVE</h2>
          <p>Running outside the engine. Launch the Mosh app to drive the backend.</p>
        </div>
      </div>
    );
  }

  return (
    <MoshTipProvider delay={350}>
      <div className="live-shell" data-testid="live-shell"
        data-draw={drawMode} data-alt={altHeld}
        data-clip-expanded={clipExpanded}>
        {snapshot && <ControlBar snapshot={snapshot} />}
        {displayError && <div className="live-errbar" role="alert" data-testid="live-error">⚠ {displayError}</div>}
        <RecoveryNotice />
        <AudioDeviceNotice />
        {snapshot && <OverviewStrip snapshot={snapshot} />}

        <div className="live-body" style={{ gridTemplateColumns: `${browserW}px minmax(0, 1fr)` }}>
          {!browserHidden && <Browser />}
          {!browserHidden && <BrowserDivider width={browserW} />}
          {browserHidden && (
            <button
              className="live-browser-reopen"
              data-testid="live-browser-reopen"
              aria-label="Show the browser"
              title="Show the browser (it reopens at the width you left it)"
              onClick={() => useLive.getState().setBrowserHidden(false)}
            >▸</button>
          )}
          {snapshot
            ? <Arrangement snapshot={snapshot} dragging={dragging} />
            : <div className="live-arr-loading">Loading session…</div>}
        </div>

        <DetailDock />
        <StatusBar snapshot={snapshot} />
        {/* ⌘, — Live's Preferences: the shared SettingsPanel as a modal overlay
            (same panel as classic/v2, never forked; only the classic visual `skin`
            descriptor is hidden here — settings/shellVisibility.ts). */}
        {settingsOpen && snapshot && <LiveSettingsOverlay />}
      </div>
    </MoshTipProvider>
  );
}

/** The modal frame for the shell's Settings overlay: Esc closes via the shared
 *  escape stack (never pops an overlay beneath it); a backdrop click closes too. */
function LiveSettingsOverlay() {
  const snapshot = useStore((s) => s.snapshot)!;
  const setSettingsOpen = useLive((s) => s.setSettingsOpen);
  useEffect(() => pushEscapeHandler(() => setSettingsOpen(false)), [setSettingsOpen]);
  return (
    <div
      className="live-settings-backdrop"
      data-testid="live-settings-backdrop"
      role="presentation"
      onClick={() => setSettingsOpen(false)}
    >
      <div
        className="live-settings-overlay"
        data-testid="live-settings"
        role="dialog"
        aria-modal="true"
        aria-label="Settings"
        onClick={(e) => e.stopPropagation()}
      >
        <SettingsPanel snapshot={snapshot} />
      </div>
    </div>
  );
}

// The browser divider (WIDGETS §1): drag to resize — 165pt floor while visible, and
// pulling far left (<120pt) hides the browser ENTIRELY, remembering the last width
// for the ▸ reopen strip. Max: the fixed 279pt header column plus a usable lane
// sliver always survive. Arrow keys step it; ← at the floor hides.
function BrowserDivider({ width }: { width: number }) {
  const drag = useRef<{ pointerId: number; startX: number; startW: number } | null>(null);
  const setBrowserWidth = useLive((s) => s.setBrowserWidth);
  const setBrowserHidden = useLive((s) => s.setBrowserHidden);
  const maxW = () => {
    const shellW = document.querySelector(".live-shell")?.clientWidth ?? 1440;
    return Math.min(1163, Math.max(200, shellW - 279 - 60));
  };
  return (
    <div
      className="live-browser-divider"
      data-testid="live-browser-divider"
      role="separator"
      aria-orientation="vertical"
      aria-label="Resize the browser"
      aria-valuenow={width}
      aria-valuemin={165}
      aria-valuemax={maxW()}
      tabIndex={0}
      title="Drag to resize the browser — pull far left to hide it"
      style={{ left: width - 3 }}
      onPointerDown={(e) => {
        drag.current = { pointerId: e.pointerId, startX: e.clientX, startW: width };
        try { e.currentTarget.setPointerCapture(e.pointerId); } catch { /* no-op */ }
      }}
      onPointerMove={(e) => {
        const d = drag.current;
        if (!d || d.pointerId !== e.pointerId) return;
        const w = d.startW + (e.clientX - d.startX);
        // Hide remembers the width the pull STARTED at — a pull through the visible
        // sizes on the way to the edge must not overwrite it (WIDGETS §1: "remembering").
        if (w < 120) { setBrowserWidth(d.startW); setBrowserHidden(true); drag.current = null; return; }
        if (w >= 165) setBrowserWidth(Math.min(maxW(), Math.round(w)));
      }}
      onPointerUp={(e) => {
        drag.current = null;
        try { e.currentTarget.releasePointerCapture(e.pointerId); } catch { /* no-op */ }
      }}
      onKeyDown={(e) => {
        const delta = e.key === "ArrowRight" ? 16 : e.key === "ArrowLeft" ? -16 : 0;
        if (delta === 0) return;
        e.preventDefault();
        const w = width + delta;
        if (w < 165) setBrowserHidden(true);
        else setBrowserWidth(Math.min(maxW(), w));
      }}
    />
  );
}
