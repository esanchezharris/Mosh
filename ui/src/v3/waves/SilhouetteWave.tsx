import { useId } from "react";
import { silhouettePath, type PeakPair } from "./silhouette";

export function SilhouetteWave({
  peaks,
  selected = false,
  live = false,
  beats = 32,
  showGrid = true,
  className = "cwave",
}: {
  peaks?: readonly PeakPair[];
  selected?: boolean;
  live?: boolean;
  beats?: number;
  showGrid?: boolean;
  className?: string;
}) {
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
  const mid = h / 2;
  const uid = useId();
  return (
    <div className={className} data-testid="v3-silhouette" data-live={live || undefined}>
      <svg xmlns="http://www.w3.org/2000/svg" width="100%" height="100%" viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="none">
        {showGrid && Array.from({ length: beats + 1 }, (_, k) => (
          <line key={`${uid}-g${k}`} x1={(k / beats) * w} y1={0} x2={(k / beats) * w} y2={h}
            stroke={k % 4 === 0 ? "#7A8282" : "#3A4040"} strokeWidth="1" vectorEffect="non-scaling-stroke" />
        ))}
        {d && <path d={d} fill={fill} fillOpacity={live ? 0.9 : selected ? 0.88 : 0.95} stroke="#E8E6DE" strokeWidth="0.5" strokeOpacity="0.28" />}
        <line x1={0} y1={mid} x2={w} y2={mid} stroke="#EDE9E1" strokeOpacity="0.07" strokeWidth="1" vectorEffect="non-scaling-stroke" />
      </svg>
    </div>
  );
}
