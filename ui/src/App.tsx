import { useEffect } from "react";
import { useStore } from "./store";
import { isNative } from "./bridge";
import { Arrangement } from "./components/Arrangement";
import { Transport } from "./components/Transport";
import { Rack } from "./components/Rack";
import { PluginBrowser } from "./components/PluginBrowser";
import { TutorialBar } from "./components/TutorialBar";
import { CollabPanel } from "./components/CollabPanel";

// Stage 1 UI: renders the MoshOps snapshot cold, drives every mutation through
// execute_command, and reacts to the snapshot+events feed. Deliberately thin and
// conventional — Stage 2 grows this into the full arrangement (drag/trim/split,
// zoom/snap, marquee). The backend has zero knowledge of any of it (swappable seam).
export function App() {
  const init = useStore((s) => s.init);
  const snapshot = useStore((s) => s.snapshot);
  const lastError = useStore((s) => s.lastError);
  const exec = useStore((s) => s.exec);
  const theme = useStore((s) => s.theme);
  const toggleTheme = useStore((s) => s.toggleTheme);

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
        <div className="topbar-right">
          {/* Git-style async session sync (Stage 10). */}
          <CollabPanel />
          {/* Tutorial-replication tooling (phase0 s6): URL + markers + consent. */}
          <TutorialBar />
          {/* Reserved B-5 / Monster operator slot (Stage 11). */}
          <span className="b5-slot" title="B-5 / Monster — reserved (Stage 11)">B-5</span>
          <button className="tool-btn" onClick={() => exec("export_audio", {})} title="Export the mix to WAV">
            ⤓ Export
          </button>
          <button className="tool-btn" onClick={toggleTheme} title="Toggle theme">
            {theme === "dark" ? "☾" : "☀"}
          </button>
        </div>
      </header>

      {lastError && <div className="error-bar">⚠ {lastError}</div>}

      {snapshot ? (
        <>
          <Arrangement snapshot={snapshot} />
          <Rack snapshot={snapshot} />
        </>
      ) : (
        <div className="boot"><p>Loading snapshot…</p></div>
      )}

      <PluginBrowser />
    </div>
  );
}
