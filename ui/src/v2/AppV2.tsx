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
import { PianoRoll } from "../ui/PianoRoll";
import { AutomationPanel } from "../ui/AutomationPanel";
import { DrumWindow } from "../ui/DrumWindow";
import { ChangeToast } from "./ChangeToast";
import "./shell.css";

export function AppV2() {
  const snapshot = useStore((s) => s.snapshot);
  const lastError = useStore((s) => s.lastError);

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

      {/* compact 3-zone body: a center column (section-nav · arrangement · prompt bar)
          and an ALWAYS-ON right rail (maximized agent · collaborators · inspector). */}
      <div className="v2-body">
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

      {/* left browser — a CONFINED pull-tab overlay: its tab rides the screen edge and the
          panel ends above the prompt bar, so it never covers the agent (samples + PLUGINS;
          "+ Plugin" opens it on the Plugins tab — the one plugin surface, no modal). */}
      <LeftDrawer />

      {/* floating / modal surfaces — opened via disclosure */}
      <PianoRoll />
      <AutomationPanel />
      <DrumWindow />
      <ChangeToast />
    </div>
  );
}
