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
import { Topbar, Toolbar } from "./ui/Topbar";
import { Arrange } from "./ui/Arrange";

export function App() {
  const init = useStore((s) => s.init);
  const snapshot = useStore((s) => s.snapshot);
  const lastError = useStore((s) => s.lastError);

  useEffect(() => { init(); }, [init]);

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
        <div className="error-bar">⚠ No audio device — playback/record/export disabled.</div>
      )}
      {lastError && <div className="error-bar" data-testid="error">⚠ {lastError}</div>}

      {snapshot ? (
        <div className="arrange" data-testid="view" data-view="arrange">
          <Arrange snapshot={snapshot} />
        </div>
      ) : (
        <div className="boot"><p>Loading snapshot…</p></div>
      )}
    </div>
  );
}
