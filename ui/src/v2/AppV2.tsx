// AppV2 — the from-scratch Mosh shell (focused core, one Mosh-native design). A pure
// client of the same store/seam as the classic shell; the backend is identical. The
// App router mounts this when uiShell === "v2". Floating editors (piano-roll, drum,
// automation, plugin browser, agent change-log) are mounted once here and opened only
// via progressive disclosure (inspector / right-click) in later slices.

import { useStore } from "../store";
import { useShell } from "./shellState";
import { isNative } from "../bridge";
import { useKeyboardShortcuts } from "../hooks/useKeyboardShortcuts";
import { formatPeerError } from "../multiplayer/peerErrors";
import { useFileDrop } from "../hooks/useFileDrop";
import { TopBar } from "./TopBar";
import { TrackLaneList } from "./lanes/TrackLaneList";
import { RightRail } from "./RightRail";
import { Composer } from "./Composer";
import { LeftDrawer } from "./LeftDrawer";
import { PianoRoll } from "../ui/PianoRoll";
import { RecoveryNotice } from "../ui/RecoveryNotice";
import { AudioDeviceNotice } from "../ui/AudioDeviceNotice";
import { FeltWrongDialog } from "../ui/FeltWrongDialog";
import { MissingMediaBanner } from "../ui/MissingMediaBanner";
import { AutomationPanel } from "../ui/AutomationPanel";
import { DrumWindow } from "../ui/DrumWindow";
import { ChangeToast } from "./ChangeToast";
import { MemoryToast } from "./MemoryToast";
import "./shell.css";

export function AppV2() {
  const snapshot = useStore((s) => s.snapshot);
  const lastError = useStore((s) => s.lastError);
  const peers = useStore((s) => s.peers);
  // #40 — show peer display names, not raw UUIDs, in lock-denied errors.
  const displayError = lastError ? formatPeerError(lastError, peers) : null;
  const leftOpen = useShell((s) => s.browserOpen);  // LEFT push-dock (browser)
  const rightOpen = useShell((s) => s.rightOpen);   // RIGHT push-dock (agent rail)

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
    <div className="v2-shell" data-testid="v2-shell"
      data-left-open={leftOpen} data-right-open={rightOpen}>
      {snapshot && <TopBar snapshot={snapshot} />}
      {displayError && <div className="v2-errbar" role="alert" data-testid="v2-error">⚠ {displayError}</div>}
      <RecoveryNotice />
      <AudioDeviceNotice />
      <MissingMediaBanner />
      <FeltWrongDialog />

      {/* symmetric push-docks frame a SMALL, CENTERED work area. Both flanks are collapsible
          pull-tab docks that occupy their OWN gutter — opening one fills its side and pushes,
          it never covers the (capped, centered) arrangement. LEFT = browser (samples +
          plugins); CENTER = section-nav · arrangement · composer; RIGHT = agent rail
          (maximized Moshi · inspector · collaborators). */}
      <div className="v2-body">
        <LeftDrawer />
        <div className="v2-main">
          {snapshot
            ? <TrackLaneList snapshot={snapshot} dragging={dragging} />
            : (
              <>
                <div className="v2-nav" />
                <div className="v2-stage"><div className="v2-empty">Loading session…</div></div>
              </>
            )}
          <Composer />
        </div>
        <RightRail />
      </div>

      {/* floating / modal surfaces — opened via disclosure */}
      <PianoRoll />
      <AutomationPanel />
      <DrumWindow />
      <ChangeToast />
      <MemoryToast />
    </div>
  );
}
