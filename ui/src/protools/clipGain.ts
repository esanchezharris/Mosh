export const CLIP_GAIN_MIN_DB = -48;
export const CLIP_GAIN_MAX_DB = 24;
export const CLIP_GAIN_STEP_DB = 0.5;
const CLIP_GAIN_DB_PER_DRAG_PX = 0.25;

export function clampClipGain(gainDb: number): number {
  if (!Number.isFinite(gainDb)) return 0;
  return Math.min(CLIP_GAIN_MAX_DB, Math.max(CLIP_GAIN_MIN_DB, gainDb));
}

export function clipGainAmplitude(gainDb: number): number {
  return 10 ** (clampClipGain(gainDb) / 20);
}

export function clipGainLinePercent(gainDb: number): number {
  const span = CLIP_GAIN_MAX_DB - CLIP_GAIN_MIN_DB;
  return ((CLIP_GAIN_MAX_DB - clampClipGain(gainDb)) / span) * 100;
}

export function clipGainAfterVerticalDrag(initialDb: number, deltaY: number): number {
  const raw = initialDb - deltaY * CLIP_GAIN_DB_PER_DRAG_PX;
  return clampClipGain(Math.round(raw / CLIP_GAIN_STEP_DB) * CLIP_GAIN_STEP_DB);
}

export function clipGainFromKey(currentDb: number, key: string): number | null {
  switch (key) {
    case "ArrowUp":
    case "ArrowRight":
      return clampClipGain(currentDb + CLIP_GAIN_STEP_DB);
    case "ArrowDown":
    case "ArrowLeft":
      return clampClipGain(currentDb - CLIP_GAIN_STEP_DB);
    case "PageUp":
      return clampClipGain(currentDb + 6);
    case "PageDown":
      return clampClipGain(currentDb - 6);
    case "Home":
      return CLIP_GAIN_MIN_DB;
    case "End":
      return CLIP_GAIN_MAX_DB;
    default:
      return null;
  }
}
