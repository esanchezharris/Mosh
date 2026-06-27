// AppV2 — the from-scratch Mosh shell (focused core, one Mosh-native design). A pure
// client of the same store/seam as the classic shell; the backend is identical. The
// App router mounts this when uiShell === "v2". Floating editors (piano-roll, drum,
// automation, plugin browser, agent change-log) are mounted once here and opened only
// via progressive disclosure (inspector / right-click) in later slices.

import { useStore } from "../store";
import { isNative } from "../bridge";
import { useKeyboardShortcuts } from "../hooks/useKeyboardShortcuts";
import { useFileDrop } from "../hooks/useFileDrop";
import { TopBar } from "./TopBar";
import { TrackLaneList } from "./lanes/TrackLaneList";
import { RightRail } from "./RightRail";
import { Composer } from "./Composer";
import { LeftDrawer } from "./LeftDrawer";
import { RightInspectorDrawer } from "./RightInspectorDrawer";
import { useHasPeers } from "./usePresence";
import { PluginBrowser } from "./PluginBrowser";
import { PianoRoll } from "../ui/PianoRoll";
import { AutomationPanel } from "../ui/AutomationPanel";
import { DrumWindow } from "../ui/DrumWindow";
import { ChangeToast } from "./ChangeToast";
import "./shell.css";

export function AppV2() {
  const snapshot = useStore((s) => s.snapshot);
  const lastError = useStore((s) => s.lastError);
  // Two modes (see usePresence): with collaborators the right rail holds the agent +
  // their video tiles, as today; solo, the rail collapses for a full-width timeline, the
  // agent rides the prompt bar, and the Inspector lives in a right-edge drawer.
  const hasPeers = useHasPeers();

  useKeyboardShortcuts(); // the single keyboard layer + native-menu bridge
  const dragging = useFileDrop(); // drag-and-drop audio import (bytes over the bridge)

  // Opened outside a backend (production build, no JUCE WebView + no dev mock).
  if (!isNative()) {
    return (
      <div className="v2-shell" data-testid="v2-shell">
        <div className="v2-boot">
          <h2>MOSH</h2>
          <p>Running outside the engine. Launch the Mosh app to drive the backend.</p>
        </div>
      </div>
    );
  }

  return (
    <div className="v2-shell" data-testid="v2-shell">
      {snapshot && <TopBar snapshot={snapshot} />}
      {lastError && <div className="v2-errbar" role="alert" data-testid="v2-error">⚠ {lastError}</div>}

      <div className={`v2-body${hasPeers ? "" : " solo"}`}>
        <div className="v2-main">
          <div className="v2-stage">
            {snapshot
              ? <TrackLaneList snapshot={snapshot} />
              : <div className="v2-empty">Loading session…</div>}
            {/* left browser dock (samples + plugins), slides in on a pull-tab over the timeline */}
            <LeftDrawer />
            {/* solo: the Inspector docks on the right edge so the rail can disappear */}
            {!hasPeers && <RightInspectorDrawer />}
            {dragging && (
              <div className="v2-drop" role="status" aria-live="polite" data-testid="v2-drop">
                <span>Drop audio to import</span>
              </div>
            )}
          </div>
          <Composer />
        </div>
        {hasPeers && <RightRail />}
      </div>

      {/* floating / modal surfaces — opened via disclosure in later slices */}
      <PluginBrowser />
      <PianoRoll />
      <AutomationPanel />
      <DrumWindow />
      <ChangeToast />
    </div>
  );
}
