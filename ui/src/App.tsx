// THE MOSH UI — rebuilt shell. A thin client of the command/snapshot seam:
// init() subscribes to the snapshot+events feed and loads the cold snapshot;
// every mutation goes through store.exec() -> executeCommand(). The backend
// (Tracktion via MoshOps) has zero knowledge of any of this — and in Vite dev
// the same code drives the in-memory mock (bridge.mock), so this view is fully
// iterable in a plain browser with real DOM introspection.
//
// This is the from-scratch rebuild: one canonical grid, ink+lime register,
// observable state. Mixer / plugin racks / generative drawer / Moshi GL
// are staged back in next (the legacy components remain on disk to port from).

import { useEffect, useRef } from "react";
import { useStore } from "./store";
import { useSettings } from "./settings/store";
import { isNative } from "./bridge";
import { useKeyboardShortcuts } from "./hooks/useKeyboardShortcuts";
import { useFileDrop } from "./hooks/useFileDrop";
import { Topbar, Toolbar } from "./ui/Topbar";
import { Arrange } from "./ui/Arrange";
import { Dock } from "./ui/Dock";
import { DockShell } from "./ui/dock/DockShell";
import { useDrumWindow } from "./ui/dock/useFloatingWindow";
import { SampleBrowser } from "./ui/SampleBrowser";
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
  const dragging = useFileDrop(); // BRW-007 drag-and-drop audio import (bytes-over-bridge)

  // Layout = a template value (Phase 6). The FL layout pops the drum sequencer into
  // its floating window: when the layout becomes "fl", open it for the first drum
  // track that has a clip. Only on the transition (never auto-closes), so a manual
  // open in another layout is untouched.
  const layout = useSettings((s) => (s.values.layout ?? "mosh") as string);
  const prevLayout = useRef<string | null>(null);
  useEffect(() => {
    if (!snapshot) return;
    if (layout === "fl" && prevLayout.current !== "fl") {
      const clip = snapshot.tracks.find((t) => t.type === "drum")?.clips.find((c) => c.type === "midi");
      if (clip) useDrumWindow.getState().open(clip.id);
    }
    prevLayout.current = layout;
  }, [layout, snapshot]);

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
          <DockShell left={<SampleBrowser />} bottom={<Dock snapshot={snapshot} />}>
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
      {dragging && (
        <div className="drop-overlay" role="status" aria-live="polite" data-testid="drop-overlay">
          <span>Drop audio to import</span>
        </div>
      )}
    </div>
  );
}
