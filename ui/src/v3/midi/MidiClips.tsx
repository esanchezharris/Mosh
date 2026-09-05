import type { MidiNote } from "../../types";
import { V3_DRUM_LANES, v3DrumLane } from "./drums";

export function DrumsClip({ notes, beats = 32 }: { notes?: MidiNote[]; beats?: number }) {
  const w = 640;
  const h = 48;
  const cell = w / beats;
  const rows = V3_DRUM_LANES.map((lane, i) => ({
    lane,
    y: 0.06 + i * 0.3,
    hits: (notes ?? []).filter((n) => v3DrumLane(n.pitch) === lane),
  }));
  return (
    <div className="cwave midi" data-testid="v3-drums-midi">
      <svg xmlns="http://www.w3.org/2000/svg" width="100%" height="100%" viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="none">
        {Array.from({ length: beats + 1 }, (_, k) => (
          <line key={k} x1={k * cell} y1={0} x2={k * cell} y2={h}
            stroke={k % 4 === 0 ? "#7A8282" : "#3A4040"} strokeWidth="1" vectorEffect="non-scaling-stroke" />
        ))}
        {rows.map((row) => row.hits.map((n) => {
          const x = n.start * cell + 0.6;
          const nw = Math.max(2, n.length * cell - 1.2);
          const nh = h * 0.24;
          const y = row.y * h;
          return (
            <rect key={`${row.lane}-${n.i}`} x={x} y={y} width={nw} height={nh} rx="1.2"
              fill="var(--accent)" fillOpacity="0.92" />
          );
        }))}
      </svg>
    </div>
  );
}

export function MelodyClip({ notes, beats = 32 }: { notes?: MidiNote[]; beats?: number }) {
  const w = 640;
  const h = 48;
  const cell = w / beats;
  const ns = notes ?? [];
  let lo = 48, hi = 72;
  if (ns.length) {
    lo = Math.min(...ns.map((n) => n.pitch));
    hi = Math.max(...ns.map((n) => n.pitch));
    if (hi - lo < 4) { const c = Math.round((lo + hi) / 2); lo = c - 6; hi = c + 6; }
  }
  const span = Math.max(1, hi - lo + 2);
  const rowH = h / span;
  return (
    <div className="cwave midi" data-testid="v3-melody-midi">
      <svg xmlns="http://www.w3.org/2000/svg" width="100%" height="100%" viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="none">
        {Array.from({ length: beats + 1 }, (_, k) => (
          <line key={k} x1={k * cell} y1={0} x2={k * cell} y2={h}
            stroke={k % 4 === 0 ? "#7A8282" : "#3A4040"} strokeWidth="1" vectorEffect="non-scaling-stroke" />
        ))}
        {ns.map((n) => {
          const y = h - ((n.pitch - lo + 1) / span) * h;
          return (
            <rect key={n.i} x={n.start * cell + 0.5} y={y} width={Math.max(2.5, n.length * cell - 1)}
              height={Math.max(3.5, rowH - 1.2)} rx="1.4" fill="var(--accent)" fillOpacity="0.9" />
          );
        })}
      </svg>
    </div>
  );
}
