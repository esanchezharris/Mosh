import { useStore } from "../store";
import { useSettings } from "../settings/store";
import { isNative } from "../bridge";
import { useKeyboardShortcuts } from "../hooks/useKeyboardShortcuts";
import { useQwertyMidi } from "../hooks/useQwertyMidi";
import { useFileDrop } from "../hooks/useFileDrop";
import { formatPeerError } from "../multiplayer/peerErrors";
import { RecoveryNotice } from "../ui/RecoveryNotice";
import { AudioDeviceNotice } from "../ui/AudioDeviceNotice";
import { FeltWrongDialog } from "../ui/FeltWrongDialog";
import { MissingMediaBanner } from "../ui/MissingMediaBanner";
import { useV3 } from "./shellState";
import { colorwayAttr } from "./colorway";
import { TopBar } from "./TopBar";
import { LeftRail } from "./LeftRail";
import { Arrangement } from "./Arrangement";
import { MixInspector } from "./MixInspector";
import { MoshiDock } from "./MoshiDock";
import { HistoryFlyout } from "./HistoryFlyout";
import { SettingsModal } from "./SettingsModal";
import { BrowserPane } from "./BrowserPane";
import { PluginsPane } from "./PluginsPane";
import { BoothView } from "./BoothView";
import { ContextMenu } from "./ContextMenu";
import "./shell.css";

export function AppV3() {
  const snapshot = useStore((s) => s.snapshot);
  const lastError = useStore((s) => s.lastError);
  const peers = useStore((s) => s.peers);
  const displayError = lastError ? formatPeerError(lastError, peers) : null;
  const pane = useV3((s) => s.pane);
  const posture = useV3((s) => s.posture);
  const colorway = colorwayAttr(useSettings((s) => s.get("colorway")));

  useKeyboardShortcuts();
  useQwertyMidi();
  useFileDrop();

  if (!isNative()) {
    return (
      <div className="v3-shell" data-testid="v3-shell" data-colorway={colorway}>
        <div className="v2-boot">
          <h2>MOSH</h2>
          <p>Running outside the engine. Launch the Mosh app to drive the backend.</p>
        </div>
      </div>
    );
  }

  return (
    <div className="v3-shell" data-testid="v3-shell" data-colorway={colorway} data-posture={posture}>
      {snapshot && <TopBar snapshot={snapshot} />}
      {displayError && <div className="v2-errbar" role="alert">{displayError}</div>}
      <RecoveryNotice />
      <AudioDeviceNotice />
      <MissingMediaBanner />
      <FeltWrongDialog />
      <div className={`body${posture === "booth" ? " booth-morph" : ""}`}>
        <LeftRail />
        {pane === "browser" && <BrowserPane />}
        {pane === "plugins" && <PluginsPane />}
        <div className="col-main">
          {snapshot
            ? (posture === "booth" ? <BoothView snapshot={snapshot} /> : <Arrangement snapshot={snapshot} />)
            : <div className="main"><div className="set-hint" style={{ padding: 16 }}>Loading session…</div></div>}
          <MoshiDock />
        </div>
        {snapshot && posture === "studio" && <MixInspector snapshot={snapshot} />}
      </div>
      <HistoryFlyout />
      {snapshot && <SettingsModal snapshot={snapshot} />}
      <ContextMenu />
    </div>
  );
}
