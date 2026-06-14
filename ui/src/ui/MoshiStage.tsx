// The permanent Moshi stage — a right rail where the character lives large enough
// for his reactive body (spectrum + params) to actually read, with a small live
// spectrum-bar readout beneath him. Moshi himself is the GL component; this is just
// the frame + the spectrum visualization.

import { Moshi } from "./Moshi";
import { useStore } from "../store";

export function MoshiStage() {
  const bands = useStore((s) => s.spectrum.bands);
  const playing = useStore((s) => s.snapshot?.transport.playing ?? false);
  const recording = useStore((s) => s.snapshot?.transport.recording ?? false);
  const rendering = useStore((s) => Object.keys(s.renderProgress).length > 0);
  const label = recording ? "recording" : rendering ? "rendering" : playing ? "listening" : "idle";
  const shown = bands.length ? bands : Array(8).fill(0);

  return (
    <aside className="moshi-stage" data-testid="moshi-stage">
      <div className="stage-canvas"><Moshi /></div>
      <div className="stage-spectrum" data-testid="stage-spectrum" aria-hidden="true">
        {shown.map((b, i) => (
          <span key={i} className="sbar" style={{ height: `${Math.max(3, Math.round(b * 100))}%` }} />
        ))}
      </div>
      <div className="stage-label tc" data-state={label}>{label}</div>
    </aside>
  );
}
