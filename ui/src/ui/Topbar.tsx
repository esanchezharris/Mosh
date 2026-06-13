// Topbar (brand + transport + readout + Moshi presence) and the arrangement
// Toolbar (tools, snap, zoom, track ops). Transport carries data-state so the
// play/stop state is readable structurally — the fix for the macOS automation
// gate that couldn't tell the UI had entered a Stop state.

import { useStore } from "../store";
import { tempoMapFrom, secondsToBBSMap, SNAP_DIVISIONS } from "../time";
import type { Snapshot } from "../types";
import { Moshi } from "./Moshi";

export function Topbar({ snapshot }: { snapshot: Snapshot }) {
  const exec = useStore((s) => s.exec);
  const t = snapshot.transport;
  const map = tempoMapFrom(snapshot.session);
  const bbs = secondsToBBSMap(map, t.position);
  const playing = t.playing;

  return (
    <header className="topbar" data-testid="topbar">
      <div className="brand">
        <span className="mark">M</span>
        <span className="name">MOSH</span>
      </div>

      <div className="transport" data-testid="transport" data-playing={playing} data-recording={t.recording}>
        <button className="btn icon" title="To start" aria-label="To start"
          onClick={() => void exec("set_transport", { action: "stop", position: 0 })}>⏮</button>
        <button
          className="btn icon"
          data-testid="transport-play"
          data-state={playing ? "playing" : "stopped"}
          aria-pressed={playing}
          aria-label={playing ? "Pause" : "Play"}
          title={playing ? "Pause" : "Play"}
          onClick={() => void exec("set_transport", { action: "toggle" })}
        >{playing ? "⏸" : "▶"}</button>
        <button className="btn icon" data-testid="transport-stop" title="Stop" aria-label="Stop"
          onClick={() => void exec("set_transport", { action: "stop", position: 0 })}>⏹</button>
        <button className="btn icon rec" data-testid="transport-record"
          data-state={t.recording ? "recording" : "idle"} aria-pressed={t.recording}
          title="Record" aria-label="Record"
          onClick={() => void exec("set_transport", { action: "record" })}>⏺</button>

        <div className="read">
          <span className="pos tc" data-testid="position">{bbs}</span>
          <span className="bpm tc">{Math.round(snapshot.session.tempo)} BPM · {snapshot.session.timeSigNumerator ?? 4}/{snapshot.session.timeSigDenominator ?? 4}</span>
        </div>
      </div>

      <div className="spacer" />
      <ViewToggle />
      <Moshi />
    </header>
  );
}

function ViewToggle() {
  const view = useStore((s) => s.view);
  const setView = useStore((s) => s.setView);
  return (
    <div className="seg" role="group" aria-label="View" data-testid="view-toggle">
      {(["arrange", "mixer"] as const).map((v) => (
        <button key={v} className={`btn${view === v ? " on" : ""}`} data-state={view === v ? "active" : "idle"}
          aria-pressed={view === v} onClick={() => setView(v)}>{v[0].toUpperCase() + v.slice(1)}</button>
      ))}
    </div>
  );
}

export function Toolbar() {
  const exec = useStore((s) => s.exec);
  const tool = useStore((s) => s.tool);
  const setTool = useStore((s) => s.setTool);
  const snap = useStore((s) => s.snap);
  const setSnap = useStore((s) => s.setSnap);
  const snapDivision = useStore((s) => s.snapDivision);
  const setSnapDivision = useStore((s) => s.setSnapDivision);
  const pxPerSec = useStore((s) => s.pxPerSec);
  const setPxPerSec = useStore((s) => s.setPxPerSec);
  const selectedTrackId = useStore((s) => s.selectedTrackId);

  return (
    <div className="toolbar" data-testid="toolbar">
      <div className="group">
        <button className="btn" onClick={() => void exec("create_track", { name: "Audio" })}>+ Track</button>
        <button className="btn" disabled={!selectedTrackId}
          onClick={() => void exec("add_test_tone_clip", { trackId: selectedTrackId })}>+ Test Tone</button>
      </div>
      <div className="sep" />
      <div className="seg" role="group" aria-label="Tool">
        {(["move", "split", "range"] as const).map((tn) => (
          <button key={tn} className={`btn${tool === tn ? " on" : ""}`} data-state={tool === tn ? "active" : "idle"}
            aria-pressed={tool === tn} onClick={() => setTool(tn)}>{tn[0].toUpperCase() + tn.slice(1)}</button>
        ))}
      </div>
      <div className="sep" />
      <div className="group">
        <button className={`btn${snap ? " on" : ""}`} aria-pressed={snap} data-state={snap ? "on" : "off"}
          onClick={() => setSnap(!snap)}>Snap</button>
        <select className="btn ghost" value={snapDivision} onChange={(e) => setSnapDivision(e.target.value as typeof snapDivision)}>
          {SNAP_DIVISIONS.map((d) => <option key={d} value={d}>{d}</option>)}
        </select>
      </div>
      <div className="sep" />
      <div className="group">
        <label>Zoom</label>
        <input type="range" min={20} max={400} step={5} value={pxPerSec}
          onChange={(e) => setPxPerSec(Number(e.target.value))} style={{ accentColor: "var(--lime)" }} />
      </div>
      <div className="sep" />
      <div className="group">
        <button className="btn" onClick={() => void exec("undo")}>Undo</button>
        <button className="btn" onClick={() => void exec("redo")}>Redo</button>
      </div>
    </div>
  );
}
