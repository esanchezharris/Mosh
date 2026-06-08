/**
 * App.tsx — Stage 2 conventional DAW arrangement.
 *
 * Layout (03 §3):
 *   topbar       — brand + backend badge
 *   TransportBar — play/stop/record/loop, tempo, position
 *   body         — TrackList (left) | Timeline (center)
 *   Mixer        — bottom strip
 *   statusbar    — connection readout
 *
 * Every mutation goes through executeCommand (inside the components); every
 * visual reflects the snapshot + applied events from the store. Selection,
 * zoom, and scroll are UI-local view state. No Tracktion/audio concepts here.
 */

import { useEffect } from "react";
import { connectFeed, useStore } from "./store";
import { executeCommand } from "./bridge";
import TransportBar from "./components/TransportBar";
import TrackList from "./components/TrackList";
import Timeline from "./components/Timeline";
import Mixer from "./components/Mixer";

export default function App() {
  const backend = useStore((s) => s.backend);
  const snapshot = useStore((s) => s.snapshot);
  const loading = useStore((s) => s.loading);
  const error = useStore((s) => s.error);

  // Start the snapshot+events feed once.
  useEffect(() => connectFeed(), []);

  // Global undo/redo — the ONE undo system (Tracktion's UndoManager under
  // MoshOps). These are commands like any other; the backend emits
  // snapshot_invalidated, so the store resyncs the mirror. Ctrl/Cmd+Z = undo,
  // Ctrl/Cmd+Shift+Z or Ctrl+Y = redo. Ignored while typing in a field.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.ctrlKey || e.metaKey)) return;
      const target = e.target as HTMLElement | null;
      if (target && /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName)) return;
      const k = e.key.toLowerCase();
      if (k === "z" && !e.shiftKey) {
        e.preventDefault();
        void executeCommand("undo");
      } else if ((k === "z" && e.shiftKey) || k === "y") {
        e.preventDefault();
        void executeCommand("redo");
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const isJuce = backend === "juce";

  let stateLabel: string;
  if (loading) stateLabel = "connecting…";
  else if (error) stateLabel = "error";
  else stateLabel = "ready";

  return (
    <div className="shell daw">
      <header className="topbar">
        <span className="brand">
          Mosh<span className="dot">.</span>
        </span>
        <span className="topbar-sub">arrangement</span>
        <span className="spacer" />
        <div className="undo-group">
          <button
            className="undo-btn"
            title="Undo (Ctrl+Z)"
            onClick={() => void executeCommand("undo")}
          >
            ↶
          </button>
          <button
            className="undo-btn"
            title="Redo (Ctrl+Shift+Z)"
            onClick={() => void executeCommand("redo")}
          >
            ↷
          </button>
        </div>
        <span className={`badge ${isJuce ? "live" : "mock"}`}>
          backend: {backend}
        </span>
      </header>

      <TransportBar />

      <main className="daw-body">
        <TrackList />
        <Timeline />
      </main>

      <Mixer />

      <footer className="statusbar">
        <span>
          bridge <span className="ok">{isJuce ? "JUCE" : "mock"}</span>
        </span>
        <span>state {stateLabel}</span>
        <span>tracks {snapshot?.tracks.length ?? 0}</span>
        <span>
          {snapshot
            ? `${snapshot.tempo.bpm.toFixed(0)} bpm · ${snapshot.tempo.sig}`
            : "—"}
        </span>
        {error && <span className="err-text">{error}</span>}
      </footer>
    </div>
  );
}
