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
