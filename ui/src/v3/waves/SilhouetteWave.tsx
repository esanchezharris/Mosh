import { silhouettePath, type PeakPair } from "./silhouette";

export function SilhouetteWave({
  peaks,
  selected = false,
  live = false,
  className = "cwave",
}: {
  peaks?: readonly PeakPair[];
  selected?: boolean;
  live?: boolean;
  className?: string;
}) {
  // Content only: the arrangement's lane grid is the one grid (no lines drawn inside a clip).
  const w = 640;
  const h = className.includes("bigwave") ? 180 : 48;
  const fallback: PeakPair[] = peaks && peaks.length > 0
    ? [...peaks]
    : Array.from({ length: 64 }, (_, i) => {
      const a = 0.15 + 0.35 * Math.abs(Math.sin(i / 6));
      return [-a, a] as PeakPair;
    });
  const fill = live ? "var(--wave-live)" : selected ? "var(--wave-sel)" : "var(--wave-idle)";
  const d = silhouettePath(fallback, w, h);
  return (
    <div className={className} data-testid="v3-silhouette" data-live={live || undefined}>
      <svg xmlns="http://www.w3.org/2000/svg" width="100%" height="100%" viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="none">
        {d && <path d={d} fill={fill} fillOpacity={live ? 0.9 : selected ? 0.88 : 0.95} stroke="#E8E6DE" strokeWidth="0.5" strokeOpacity="0.28" />}
      </svg>
    </div>
  );
}
