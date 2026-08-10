import type { ClipGainPoint } from "../types";
import { clipGainLinePercent } from "./clipGain";

export const CLIP_GAIN_ENVELOPE_MIN_DB = -48;
export const CLIP_GAIN_ENVELOPE_MAX_DB = 6;
export const CLIP_GAIN_ENVELOPE_STEP_DB = 0.5;
const DB_PER_DRAG_PX = 0.25;
const TIME_EPSILON = 0.001;

export function clampClipGainOffset(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(CLIP_GAIN_ENVELOPE_MAX_DB, Math.max(CLIP_GAIN_ENVELOPE_MIN_DB, value));
}

export function clipGainOffsetAt(points: readonly ClipGainPoint[], time: number): number {
  if (points.length === 0) return 0;
  if (time <= points[0].t) return points[0].gainDb;
  const last = points[points.length - 1];
  if (time >= last.t) return last.gainDb;
  for (let index = 1; index < points.length; index += 1) {
    const right = points[index];
    if (time > right.t) continue;
    const left = points[index - 1];
    const ratio = (time - left.t) / (right.t - left.t);
    return left.gainDb + (right.gainDb - left.gainDb) * ratio;
  }
  return last.gainDb;
}

export function insertClipGainPoint(
  points: readonly ClipGainPoint[],
  time: number,
  clipLength: number,
): ClipGainPoint[] {
  const t = Math.min(clipLength, Math.max(0, time));
  if (points.some((point) => Math.abs(point.t - t) < TIME_EPSILON)) return [...points];
  return [...points, { t, gainDb: clampClipGainOffset(clipGainOffsetAt(points, t)) }]
    .sort((left, right) => left.t - right.t);
}

export function moveClipGainPoint(
  points: readonly ClipGainPoint[],
  index: number,
  time: number,
  gainDb: number,
  clipLength: number,
): ClipGainPoint[] {
  const previous = points[index - 1];
  const next = points[index + 1];
  const minTime = Math.max(0, previous ? previous.t + TIME_EPSILON : 0);
  const maxTime = Math.min(clipLength, next ? next.t - TIME_EPSILON : clipLength);
  return points.map((point, pointIndex) => pointIndex === index ? {
    ...point,
    t: Math.min(maxTime, Math.max(minTime, time)),
    gainDb: clampClipGainOffset(Math.round(gainDb / CLIP_GAIN_ENVELOPE_STEP_DB)
      * CLIP_GAIN_ENVELOPE_STEP_DB),
  } : point);
}

export function clipGainPointAfterDrag(
  points: readonly ClipGainPoint[],
  index: number,
  deltaX: number,
  deltaY: number,
  width: number,
  clipLength: number,
): ClipGainPoint[] {
  const point = points[index];
  if (!point) return [...points];
  const time = point.t + (width > 0 ? deltaX / width * clipLength : 0);
  const gainDb = point.gainDb - deltaY * DB_PER_DRAG_PX;
  return moveClipGainPoint(points, index, time, gainDb, clipLength);
}

export function clipGainEnvelopePath(
  points: readonly ClipGainPoint[],
  clipLength: number,
  staticGainDb: number,
): string {
  const at = (time: number, offset: number) => {
    const x = clipLength > 0 ? time / clipLength * 100 : 0;
    const y = clipGainLinePercent(staticGainDb + offset);
    return `${x.toFixed(3)},${y.toFixed(3)}`;
  };
  const visible = points.filter((point) => point.t >= 0 && point.t <= clipLength);
  const vertices = [at(0, clipGainOffsetAt(points, 0))];
  for (const point of visible) {
    if (point.t > 0 && point.t < clipLength) vertices.push(at(point.t, point.gainDb));
  }
  vertices.push(at(clipLength, clipGainOffsetAt(points, clipLength)));
  return `M ${vertices.join(" L ")}`;
}
