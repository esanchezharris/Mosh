// The detail dock (WIDGETS.md §1 "Detail dock behavior" — the measured 12.4.2
// rules, which refined SPEC §7):
//
//   • The MIDI editor and Devices are mutually exclusive: selecting/opening a
//     MIDI clip gives the editor the whole detail dock; selecting a track name
//     returns the dock to Devices. Other clip/drawer postures retain the measured
//     stacked behavior until their own interaction contracts are revised.
//   • A LONG drag past the clip panel's min dismisses the view (drag-to-close —
//     dockDragDismisses in dockGeometry.ts); a short one holds at 226.
//   • EXPANDED CLIP VIEW (⌥⌘E / the editor's ⤢ control): the editor consumes the
//     whole window — browser/arrangement/headers hidden (the data-clip-expanded
//     attribute on .live-shell owns that), only control bar + editor + status bar
//     remain. Sticky across close/reopen via the liveClipExpanded setting.
//
// Content priority: Moshi stub drawer (control-bar spark) → docked MIDI editor →
// wave clip editor → device panel. The MIDI editor's own header keeps the ONE close
// (its ✕); the audio editor and the device panel have the dock's own ✕ (the device
// panel's hides it until the selection changes).

import { useEffect, useRef, useState } from "react";
import { useStore } from "../store";
import { useSettings } from "../settings/store";
import { PianoRoll } from "../ui/PianoRoll";
import { IconClose, IconSpark } from "../ui/icons";
import { useLive } from "./liveState";
import { DeviceStrip } from "./DeviceStrip";
import { AudioClipEditor } from "./AudioClipEditor";
import { clampDockHeight, dockDragDismisses, DOCK_MIN, DOCK_MAX_FRAC, DEVICE_PANEL_H } from "./dockGeometry";

export function DetailDock() {
  const snapshot = useStore((s) => s.snapshot);
  const editingClipId = useStore((s) => s.editingClipId);
  const closePianoRoll = useStore((s) => s.closePianoRoll);
  const selectedTrackId = useStore((s) => s.selectedTrackId);
  const moshiOpen = useLive((s) => s.moshiOpen);
  const setMoshiOpen = useLive((s) => s.setMoshiOpen);
  const devicesHidden = useLive((s) => s.devicesHidden);
  const setDevicesHidden = useLive((s) => s.setDevicesHidden);
  const storedHeight = useSettings((s) => s.get("liveDockHeight")) as number;
  const expandedSetting = useSettings((s) => Boolean(s.get("liveClipExpanded")));

  // Hiding the device panel is per-selection: a hide that survived into the next
  // track would look like the dock broke.
  useEffect(() => { setDevicesHidden(false); }, [selectedTrackId, setDevicesHidden]);

  const clip = editingClipId
    ? snapshot?.tracks.flatMap((t) => t.clips).find((c) => c.id === editingClipId) ?? null
    : null;
  const selectedTrack = snapshot?.tracks.find((t) => t.id === selectedTrackId) ?? null;

  const showMoshi = moshiOpen;
  const showEditor = !showMoshi && clip?.type === "midi";
  const showWaveEditor = !showMoshi && !showEditor && clip?.type === "wave";
  // The MIDI editor owns the whole detail dock. Selecting a track name clears
  // editingClipId through selection-follow, which returns this to Devices.
  const clipPanelOpen = showMoshi || showEditor || showWaveEditor;
  const showDevices = !!selectedTrack && !devicesHidden && !showEditor;
  // Expanded Clip View remains MIDI-only in this slice; the audio editor stays
  // docked until its own posture and escape behavior receive a dedicated audit.
  const expanded = expandedSetting && showEditor;

  // ── splitter (clip panel only; the device panel's edge never drags) ──
  const [dragHeight, setDragHeight] = useState<number | null>(null);
  const dragRef = useRef<{ startY: number; startH: number } | null>(null);
  const rawRef = useRef(0);
  const shellH = () => document.querySelector(".live-shell")?.clientHeight ?? 800;
  const height = clampDockHeight(dragHeight ?? storedHeight, shellH());

  const dismissClipPanel = () => {
    if (showMoshi) setMoshiOpen(false);
    else closePianoRoll();
  };
  const onSplitDown = (e: React.PointerEvent<HTMLDivElement>) => {
    dragRef.current = { startY: e.clientY, startH: height };
    rawRef.current = height;
    try { e.currentTarget.setPointerCapture(e.pointerId); } catch { /* no-op */ }
  };
  const onSplitMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const d = dragRef.current;
    if (!d) return;
    rawRef.current = d.startH + (d.startY - e.clientY);
    setDragHeight(clampDockHeight(rawRef.current, shellH()));
  };
  const onSplitUp = (e: React.PointerEvent<HTMLDivElement>) => {
    const d = dragRef.current;
    if (!d) return;
    dragRef.current = null;
    try { e.currentTarget.releasePointerCapture(e.pointerId); } catch { /* no-op */ }
    // Drag-to-close: a pull well past the floor dismisses the view; anything else
    // persists the (clamped) height.
    if (dockDragDismisses(rawRef.current)) {
      setDragHeight(null);
      dismissClipPanel();
      return;
    }
    if (dragHeight != null) useSettings.getState().set("liveDockHeight", dragHeight);
    setDragHeight(null);
  };
  const onSplitKey = (e: React.KeyboardEvent<HTMLDivElement>) => {
    const delta = e.key === "ArrowUp" ? 16 : e.key === "ArrowDown" ? -16 : 0;
    if (delta === 0) return;
    e.preventDefault();
    useSettings.getState().set("liveDockHeight", clampDockHeight(height + delta, shellH()));
  };

  if (!clipPanelOpen && !showDevices) return null;

  const splitter = (
    <div
      className="live-dock-splitter"
      data-testid="live-dock-splitter"
      role="separator"
      aria-orientation="horizontal"
      aria-label="Resize the detail view"
      aria-valuenow={height}
      aria-valuemin={DOCK_MIN}
      aria-valuemax={Math.max(DOCK_MIN, Math.floor(shellH() * DOCK_MAX_FRAC))}
      tabIndex={0}
      title="Drag to resize the clip view (pull well past the bottom to close it) · ↑/↓ also work"
      onPointerDown={onSplitDown}
      onPointerMove={onSplitMove}
      onPointerUp={onSplitUp}
      onPointerCancel={onSplitUp}
      onKeyDown={onSplitKey}
    />
  );

  // The device panel — fixed height, never resized by the clip panel's splitter.
  const devicePanel = showDevices && selectedTrack ? (
    <div className="live-devpanel" data-testid="live-devpanel">
      <div className="live-dock-head">
        <span className="live-dock-title">Devices — {selectedTrack.name}</span>
        <DockClose label="Hide the device view" onClose={() => setDevicesHidden(true)} />
      </div>
      <DeviceStrip track={selectedTrack} />
    </div>
  ) : null;

  if (!clipPanelOpen) {
    // Devices-only posture: fixed panel, no splitter (WIDGETS §1 — its top edge
    // does not drag).
    return (
      <section className="live-dock live-dock-fixed" data-testid="live-dock" aria-label="Device view">
        {devicePanel}
      </section>
    );
  }

  return (
    <section
      className={`live-dock${showEditor ? " live-dock-editor" : ""}${expanded ? " expanded" : ""}`}
      data-testid="live-dock"
      aria-label={showEditor ? "Clip view" : "Detail view"}
      // The basis is the clip panel plus a fixed device panel only for the remaining
      // stacked postures; MIDI supplies no devicePanel and receives the full height.
      style={expanded ? { flex: "1 1 auto" } : { flexBasis: height + (devicePanel ? DEVICE_PANEL_H : 0) }}
    >
      {!expanded && splitter}
      {showMoshi && (
        <>
          <div className="live-dock-head">
            <span className="live-dock-title">Moshi</span>
            <DockClose label="Close the Moshi drawer" onClose={() => setMoshiOpen(false)} />
          </div>
          <div className="live-dock-moshi" data-testid="live-moshi-panel">
            <span className="live-dock-stub-icon" aria-hidden="true"><IconSpark size={16} /></span>
            <div>
              <p className="live-dock-stub-title">Moshi</p>
              <p className="live-dock-stub-copy">
                The agent drawer is a stub in this shell — the full composer lives in the
                Mosh (new) shell today and docks here later.
              </p>
            </div>
          </div>
        </>
      )}
      {showEditor && (
        // The editor's own header is the clip panel's top strip (ONE close). The
        // expand control is the editor's ⤢ (PianoRoll renders it only when given).
        // (The MIDI loop brace lives IN the roll's header row — a separate dock row
        // would starve the fixed-height dock's grid.)
        <PianoRoll
          docked
          expandControl={{
            expanded,
            onToggle: () => useSettings.getState().set("liveClipExpanded", !expandedSetting),
          }}
        />
      )}
      {showWaveEditor && clip && <AudioClipEditor clip={clip} onClose={closePianoRoll} />}
      {devicePanel}
    </section>
  );
}

function DockClose({ label, onClose }: { label: string; onClose: () => void }) {
  return (
    <button
      className="live-dock-close"
      data-testid="live-dock-close"
      aria-label={label}
      title="Close"
      onClick={onClose}
    ><IconClose size={12} /></button>
  );
}
