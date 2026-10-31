import { useStore } from "../store";

// Tier 1: "is my mic working?" at a glance. Fed by the 30 Hz `levels` rail for the Takes
// track, the lane the singer is monitored through. That meter sits AFTER the chain, so it
// only moves while Hear myself is on; with monitoring off (laptop speakers) the bar greys
// out and says why, instead of sitting at zero looking broken.

/** Below this the bar reads as silence (the rail's floor is -100). */
export const METER_FLOOR_DB = -60;

/** 0..1 fill for a peak in dBFS. */
export function meterFill(db: number): number {
  if (!Number.isFinite(db) || db <= METER_FLOOR_DB) return 0;
  return Math.min(1, (db - METER_FLOOR_DB) / -METER_FLOOR_DB);
}

export function InputMeter({ trackId, monitoring }: { trackId: string | null | undefined; monitoring: boolean }) {
  const level = useStore((s) => (trackId ? s.levels.tracks[trackId] : undefined));
  const peak = level ? Math.max(level.l, level.r) : -100;
  const fill = monitoring ? meterFill(peak) : 0;
  const hint = !monitoring
    ? "The meter wakes up when Hear myself is on (headphones)."
    : fill > 0 ? "We hear you." : "Say something…";
  return (
    <div className="input-meter-row" data-testid="v3-input-meter" data-live={monitoring ? true : undefined}>
      <div className={`input-meter${monitoring ? "" : " off"}`} role="meter" aria-label="Microphone level"
        aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(fill * 100)}>
        <span className="fill" style={{ width: `${Math.round(fill * 100)}%` }} />
      </div>
      <span className="set-hint">{hint}</span>
    </div>
  );
}
