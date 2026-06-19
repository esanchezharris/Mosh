// THE MOSH UI — rebuilt shell. A thin client of the command/snapshot seam:
// init() subscribes to the snapshot+events feed and loads the cold snapshot;
// every mutation goes through store.exec() -> executeCommand(). The backend
// (Tracktion via MoshOps) has zero knowledge of any of this — and in Vite dev
// the same code drives the in-memory mock (bridge.mock), so this view is fully
// iterable in a plain browser with real DOM introspection.
//
// This is the from-scratch rebuild: one canonical grid, ink+lime register,
// observable state. Mixer / plugin & neural racks / generative drawer / Moshi GL
// are staged back in next (the legacy components remain on disk to port from).

import { useEffect } from "react";
import { useStore } from "./store";
import { isNative } from "./bridge";
import { useKeyboardShortcuts } from "./hooks/useKeyboardShortcuts";
import { Topbar, Toolbar } from "./ui/Topbar";
import { Arrange } from "./ui/Arrange";
import { Dock } from "./ui/Dock";
import { DockShell } from "./ui/dock/DockShell";
import { Mixer } from "./ui/Mixer";
import { PluginBrowser } from "./ui/PluginBrowser";
import { PianoRoll } from "./ui/PianoRoll";
import { AutomationPanel } from "./ui/AutomationPanel";
import { DrumWindow } from "./ui/DrumWindow";
import { MonsterChanges } from "./ui/MonsterChanges";

export function App() {
  const init = useStore((s) => s.init);
  const snapshot = useStore((s) => s.snapshot);
  const lastError = useStore((s) => s.lastError);
  const view = useStore((s) => s.view);

  useEffect(() => { init(); }, [init]);
  useKeyboardShortcuts(); // the single keyboard layer + native-menu bridge (CTL-002)

  // Production build opened outside a backend (no JUCE WebView, no dev-mock).
  if (!isNative()) {
    return (
      <div className="boot">
        <h2 className="display">MOSH</h2>
        <p>Running outside the engine. Launch the Mosh app to drive the backend.</p>
      </div>
    );
  }

  const audioEnabled = snapshot?.session.audioEnabled ?? true;

  return (
    <div className="app" data-testid="app">
      {snapshot && <Topbar snapshot={snapshot} />}
      <Toolbar />
      {!audioEnabled && (
        <div className="error-bar" role="status" aria-live="polite">⚠ No audio device — playback/record/export disabled.</div>
      )}
      {lastError && <div className="error-bar" data-testid="error" role="alert">⚠ {lastError}</div>}

      {snapshot ? (
        view === "mixer" ? (
          <div className="view" data-testid="view" data-view="mixer">
            <Mixer snapshot={snapshot} />
          </div>
        ) : (
          <DockShell bottom={<Dock snapshot={snapshot} />}>
            <Arrange snapshot={snapshot} />
          </DockShell>
        )
      ) : (
        <div className="boot"><p>Loading snapshot…</p></div>
      )}

      <PluginBrowser />
      <PianoRoll />
      <AutomationPanel />
      <DrumWindow />
      <MonsterChanges />
    </div>
  );
}
