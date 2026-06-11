import { useStore } from "../store";
import type { Level } from "../types";

// dBFS → 0..1 (−60 dB floor → 0, 0 dB → full). Live values arrive via the 30Hz
// "levels" event; the bar's CSS transition gives smooth ballistics.
const frac = (db: number) => Math.max(0, Math.min(1, (db + 60) / 60));
const colour = (db: number) => (db >= -3 ? "var(--playhead)" : db >= -12 ? "var(--warn)" : "var(--ok)");

export function Meter({ trackId, master }: { trackId?: string; master?: boolean }) {
  const lvl = useStore((s) => (master ? s.levels.master : trackId ? s.levels.tracks[trackId] : undefined)) as Level | undefined;
  const l = lvl?.l ?? -100;
  const r = lvl?.r ?? -100;
  return (
    <div className="meter" title={`${l.toFixed(0)} / ${r.toFixed(0)} dB`}>
      <div className="meter-ch"><div className="meter-fill" style={{ height: `${frac(l) * 100}%`, background: colour(l) }} /></div>
      <div className="meter-ch"><div className="meter-fill" style={{ height: `${frac(r) * 100}%`, background: colour(r) }} /></div>
    </div>
  );
}
