export type TimeRulerTick = { seconds: number; label: string };

const NICE_STEPS = [1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 900, 1800, 3600] as const;
export const TIME_RULER_MAX_TICKS = 2048;

export function formatElapsedTime(totalSeconds: number): string {
  const whole = Number.isFinite(totalSeconds) ? Math.max(0, Math.floor(totalSeconds)) : 0;
  const hours = Math.floor(whole / 3600);
  const minutes = Math.floor((whole % 3600) / 60);
  const seconds = whole % 60;
  return hours > 0
    ? `${hours}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`
    : `${minutes}:${String(seconds).padStart(2, "0")}`;
}

export function timeRulerTicks(totalSeconds: number, pxPerSec: number, minLabelPx = 72): TimeRulerTick[] {
  const end = Number.isFinite(totalSeconds) ? Math.max(0, totalSeconds) : 0;
  const desiredStep = Math.max(
    minLabelPx / Math.max(0.001, pxPerSec),
    end / (TIME_RULER_MAX_TICKS - 1),
  );
  const step = NICE_STEPS.find((candidate) => candidate >= desiredStep)
    ?? Math.ceil(desiredStep / 3600) * 3600;
  const ticks: TimeRulerTick[] = [];
  for (let seconds = 0; seconds <= end + 1e-6; seconds += step)
    ticks.push({ seconds, label: formatElapsedTime(seconds) });
  return ticks;
}
