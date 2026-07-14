// AppV3 — the "Open Lanes" shell (ui/src/v3). A loop-first, inline-lane-editor arrangement:
// each track lane is its own editor, on a centered obsidian slab with calm margins, a slim
// arrangement navigator, and a prompt-bar Moshi. A pure client of the same store/seam as the
// classic + v2 shells; the backend is identical. The App router mounts this when
// uiShell === "openlanes". Built stage-by-stage toward full v2 feature parity.

import { useStore } from "../store";
import { isNative } from "../bridge";
import { useKeyboardShortcuts } from "../hooks/useKeyboardShortcuts";
import { useFileDrop } from "../hooks/useFileDrop";
import { RecoveryNotice } from "../ui/RecoveryNotice";
import { MissingMediaBanner } from "../ui/MissingMediaBanner";
import { TopBar } from "./TopBar";
import { Lanes } from "./Lanes";
import { useOpenLanes, type ZoomBars } from "./state";
import "./shell.css";

const ZOOMS: { id: ZoomBars; label: string }[] = [
  { id: 8, label: "8" },
  { id: 16, label: "16" },
  { id: "full", label: "Full" },
];

export function AppV3() {
  const snapshot = useStore((s) => s.snapshot);
  const lastError = useStore((s) => s.lastError);
  const zoom = useOpenLanes((s) => s.zoom);
  const setZoom = useOpenLanes((s) => s.setZoom);
  const leftDock = useOpenLanes((s) => s.leftDock);
  const rightDock = useOpenLanes((s) => s.rightDock);
  const setLeftDock = useOpenLanes((s) => s.setLeftDock);
  const setRightDock = useOpenLanes((s) => s.setRightDock);

  useKeyboardShortcuts();       // the single keyboard layer + native-menu bridge
  useFileDrop();                // drag-and-drop audio import over the bridge

  // Opened outside a backend (production build with no JUCE WebView + no dev mock).
  if (!isNative()) {
    return (
      <div className="v3-shell" data-testid="v3-shell">
        <div className="v3-boot">
          <h2>MOSH</h2>
          <p>Running outside the engine. Launch the Mosh app to drive the backend.</p>
        </div>
      </div>
    );
  }

  return (
    <div className="v3-shell" data-testid="v3-shell">
      {snapshot && <TopBar snapshot={snapshot} />}
      {lastError && <div className="v3-errbar" role="alert" data-testid="v3-error">⚠ {lastError}</div>}
      <RecoveryNotice />
      <MissingMediaBanner />

      {/* slim navigator band + zoom (the navigator minimap lands in a later Stage-1 slice) */}
      <div className="ol-nav-band" data-testid="v3-nav">
        <div className="ol-zoom" role="group" aria-label="Zoom">
          {ZOOMS.map((z) => (
            <button key={String(z.id)} data-on={zoom === z.id}
              onClick={() => setZoom(z.id)} aria-pressed={zoom === z.id}>{z.label}</button>
          ))}
        </div>
      </div>

      {/* left dock rail (SAMPLES / FILES) — panels wire in Stage 4 */}
      <div className="ol-dock l">
        <button className="ol-dtab" data-on={leftDock === "samples"} onClick={() => setLeftDock("samples")}>SAMPLES</button>
        <button className="ol-dtab" data-on={leftDock === "files"} onClick={() => setLeftDock("files")}>FILES</button>
      </div>

      {/* the centered work slab: ruler + inline-editor lanes */}
      <div className="ol-stage">
        <div className="ol-slab" data-testid="v3-slab">
          <div className="ol-ruler" data-testid="v3-ruler">{zoom === "full" ? "FULL ARRANGEMENT" : `${zoom}-BAR WINDOW`}</div>
          <div className="ol-lanes" data-testid="v3-lanes">
            {snapshot
              ? <Lanes snapshot={snapshot} />
              : <div className="ol-empty">Loading session…</div>}
          </div>
        </div>
      </div>

      {/* right dock rail (MIXER / INSPECT) — panels wire in Stage 4 */}
      <div className="ol-dock r">
        <button className="ol-dtab" data-on={rightDock === "mixer"} onClick={() => setRightDock("mixer")}>MIXER</button>
        <button className="ol-dtab" data-on={rightDock === "inspect"} onClick={() => setRightDock("inspect")}>INSPECT</button>
      </div>

      {/* composer pill — the real agent input + prompt-bar Moshi wire in later slices */}
      <div className="ol-composer" data-testid="v3-composer">
        <span className="kick">Ask Moshi</span>
        <input placeholder="describe what you want to make…" aria-label="Ask Moshi" readOnly />
      </div>
    </div>
  );
}
