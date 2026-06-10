import { useEffect, useState } from "react";
import { useStore } from "./store";
import { isNative } from "./bridge";
import { Arrangement } from "./components/Arrangement";
import { Transport, AudioOut } from "./components/Transport";
import { Rack } from "./components/Rack";
import { PluginBrowser } from "./components/PluginBrowser";
import { TutorialBar } from "./components/TutorialBar";
import { CollabPanel } from "./components/CollabPanel";
import { AgentPanel } from "./components/AgentPanel";

// Stage 1 UI: renders the MoshOps snapshot cold, drives every mutation through
// execute_command, and reacts to the snapshot+events feed. Deliberately thin and
// conventional — Stage 2 grows this into the full arrangement (drag/trim/split,
// zoom/snap, marquee). The backend has zero knowledge of any of it (swappable seam).
// Global DAW keyboard (Stage 15). Same input-guard as the TutorialBar hotkey:
// never fire while typing.
function useGlobalKeys() {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement;
      if (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.tagName === "SELECT" || t.isContentEditable)
        return;
      const s = useStore.getState();
      if (e.code === "Space") {
        e.preventDefault();
        void s.exec("set_transport", { action: "toggle" });
      } else if (e.key === "Backspace" || e.key === "Delete") {
        if (s.editingClipId) return;          // the piano roll owns delete while open
        if (s.selection.size === 0) return;
        e.preventDefault();
        for (const id of s.selection) void s.exec("remove_clip", { clipId: id });
        s.clearSelection();
      } else if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "z") {
        e.preventDefault();
        void s.exec(e.shiftKey ? "redo" : "undo", {});
      } else if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "d") {
        if (s.editingClipId || s.selection.size === 0) return;
        e.preventDefault();
        for (const id of s.selection) void s.exec("duplicate_clip", { clipId: id });
      } else if (e.key === "=" || e.key === "+") {
        s.setPxPerSec(s.pxPerSec * 1.4);
      } else if (e.key === "-") {
        s.setPxPerSec(s.pxPerSec / 1.4);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
}

export function App() {
  const init = useStore((s) => s.init);
  const snapshot = useStore((s) => s.snapshot);
  const lastError = useStore((s) => s.lastError);
  const exec = useStore((s) => s.exec);
  const theme = useStore((s) => s.theme);
  const toggleTheme = useStore((s) => s.toggleTheme);
  const [warningDismissed, setWarningDismissed] = useState(false);

  useEffect(() => {
    init();
  }, [init]);
  useGlobalKeys();

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
          {/* B-5 / Monster — the producer agent (Stage 11, phase0 s10). */}
          <AgentPanel />
          {/* Audio-output truth (Stage 14): show + switch the device. */}
          <AudioOut />
          <button className="tool-btn" onClick={() => exec("export_audio", {})} title="Export the mix to WAV">
            ⤓ Export
          </button>
          <button className="tool-btn" onClick={toggleTheme} title="Toggle theme">
            {theme === "dark" ? "☾" : "☀"}
          </button>
        </div>
      </header>

      {lastError && <div className="error-bar">⚠ {lastError}</div>}
      {snapshot?.session.audioWarning && !warningDismissed && (
        <div className="warn-bar">
          ⚠ {snapshot.session.audioWarning}
          <button className="mini" onClick={() => setWarningDismissed(true)}>✕</button>
        </div>
      )}

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
