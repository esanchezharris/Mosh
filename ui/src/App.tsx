/**
 * App.tsx — Stage 0 placeholder.
 *
 * Proves the WebView host works: shows the "Mosh" title and a status line that
 * reflects getSnapshot() called on mount (via the store's feed) and reports
 * whether the live backend is the JUCE bridge or the dev mock. No real DAW UI
 * yet — that is Stage 2.
 */

import { useEffect } from "react";
import { connectFeed, useStore } from "./store";

export default function App() {
  const backend = useStore((s) => s.backend);
  const snapshot = useStore((s) => s.snapshot);
  const loading = useStore((s) => s.loading);
  const error = useStore((s) => s.error);

  // Start the snapshot+events feed once.
  useEffect(() => connectFeed(), []);

  const isJuce = backend === "juce";
  const dotClass = error ? "err" : isJuce ? "" : "mock";

  let stateLabel: string;
  if (loading) stateLabel = "connecting…";
  else if (error) stateLabel = "error";
  else stateLabel = "ready";

  return (
    <div className="shell">
      <header className="topbar">
        <span className="brand">
          Mosh<span className="dot">.</span>
        </span>
        <span className="spacer" />
        <span className={`badge ${isJuce ? "live" : "mock"}`}>
          backend: {backend}
        </span>
      </header>

      <main className="stage">
        <div className="card">
          <h1 className="title">Mosh</h1>
          <p className="subtitle">native hybrid DAW — WebView shell</p>

          <div className="status">
            <span className={`dotpulse ${dotClass}`} />
            <span className="key">backend</span>
            <span className="val">{backend}</span>
            <span className="key">·</span>
            <span className="key">state</span>
            <span className="val">{stateLabel}</span>
          </div>

          <div className="meta">
            {error ? (
              <span className="pill">snapshot error: {error}</span>
            ) : snapshot ? (
              <>
                <span className="pill">tracks: {snapshot.tracks.length}</span>
                {"  ·  "}
                <span className="pill">tempo: {snapshot.tempo.bpm} bpm</span>
                {"  ·  "}
                <span className="pill">sig: {snapshot.tempo.sig}</span>
              </>
            ) : (
              <span className="pill">awaiting snapshot…</span>
            )}
            <br />
            Stage 0 skeleton · seam = executeCommand + snapshot/events
          </div>
        </div>
      </main>

      <footer className="statusbar">
        <span>
          bridge <span className="ok">{isJuce ? "JUCE" : "mock"}</span>
        </span>
        <span>snapshot {snapshot ? "loaded" : loading ? "…" : "—"}</span>
        <span>events subscribed</span>
      </footer>
    </div>
  );
}
