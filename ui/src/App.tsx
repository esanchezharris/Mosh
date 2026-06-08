import { useEffect } from "react";
import { useStore } from "./store";
import { isNative } from "./bridge";
import { Arrangement } from "./components/Arrangement";
import { Transport } from "./components/Transport";

// Stage 1 UI: renders the MoshOps snapshot cold, drives every mutation through
// execute_command, and reacts to the snapshot+events feed. Deliberately thin and
// conventional — Stage 2 grows this into the full arrangement (drag/trim/split,
// zoom/snap, marquee). The backend has zero knowledge of any of it (swappable seam).
export function App() {
  const init = useStore((s) => s.init);
  const snapshot = useStore((s) => s.snapshot);
  const lastError = useStore((s) => s.lastError);

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
      </header>

      {lastError && <div className="error-bar">⚠ {lastError}</div>}

      {snapshot ? (
        <Arrangement snapshot={snapshot} />
      ) : (
        <div className="boot"><p>Loading snapshot…</p></div>
      )}
    </div>
  );
}
