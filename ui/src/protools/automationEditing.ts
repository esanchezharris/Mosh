import type { AutoPoint, Track } from "../types";

export const AUTOMATION_GRAPH_TOP_PX = 3;
export const AUTOMATION_GRAPH_HEIGHT_PX = 20;
export const AUTOMATION_TIME_EPSILON_SEC = 0.000001;

export type AutomationRange = {
  readonly start: number;
  readonly end: number;
};

export type IndexedAutomationPoint = AutoPoint & {
  readonly pointIndex: number;
};

export type AutomationTarget = {
  readonly pluginIndex: number;
  readonly paramIndex: number;
  readonly paramName: string;
  readonly value: number;
  readonly points: readonly AutoPoint[];
  readonly discrete?: boolean;
  readonly states?: number;
};

export type AutomationReplacementBounds = {
  readonly start: number;
  readonly end: number;
};

export type AutomationClipboard = {
  readonly duration: number;
  readonly sourceParamName: string;
  readonly points: readonly AutoPoint[];
};

type PointMove = {
  readonly point: AutoPoint;
  readonly deltaX: number;
  readonly deltaY: number;
  readonly pxPerSec: number;
  readonly graphHeightPx?: number;
};

const round = (value: number): number => Number(value.toFixed(6));
const clampValue = (value: number): number => Math.min(1, Math.max(0, value));

export function firstAutomationTarget(track: Track): AutomationTarget | null {
  const plugin = [...(track.plugins ?? []), ...(track.mixerPlugins ?? [])]
    .find((candidate) => candidate.params.length > 0);
  const param = plugin?.params[0];
  if (!plugin || !param) return null;
  return {
    pluginIndex: plugin.index,
    paramIndex: param.index,
    paramName: param.name,
    value: param.value,
    points: param.points ?? [],
    discrete: param.discrete,
    states: param.states,
  };
}

export function automationTargetByName(track: Track, paramName: string): AutomationTarget | null {
  const requested = paramName.trim().toLowerCase();
  for (const plugin of [...(track.mixerPlugins ?? []), ...(track.plugins ?? [])]) {
    const param = plugin.params.find((candidate) => candidate.name.trim().toLowerCase() === requested);
    if (!param) continue;
    return {
      pluginIndex: plugin.index,
      paramIndex: param.index,
      paramName: param.name,
      value: param.value,
      points: param.points ?? [],
      discrete: param.discrete,
      states: param.states,
    };
  }
  return null;
}

export function automationRange(anchor: number, current: number): AutomationRange {
  return { start: Math.min(anchor, current), end: Math.max(anchor, current) };
}

export function automationPointIsSelected(point: AutoPoint, range: AutomationRange | null): boolean {
  return range !== null && point.t >= range.start && point.t <= range.end;
}

export function orderedAutomationPoints(points: readonly AutoPoint[]): readonly IndexedAutomationPoint[] {
  return points.map((point, pointIndex) => ({ ...point, pointIndex }))
    .sort((left, right) => left.t - right.t);
}

export function trimAutomationPoints(
  points: readonly AutoPoint[],
  range: AutomationRange,
  deltaValue: number,
): readonly AutoPoint[] {
  return points.map((point) => automationPointIsSelected(point, range)
    ? { t: point.t, v: round(clampValue(point.v + deltaValue)) }
    : point);
}

export function nudgeAutomationPoints(
  points: readonly AutoPoint[],
  range: AutomationRange,
  requestedDelta: number,
): readonly AutoPoint[] {
  const selected = points.filter((point) => automationPointIsSelected(point, range));
  if (selected.length === 0) return points;
  const earliest = Math.min(...selected.map((point) => point.t));
  const latest = Math.max(...selected.map((point) => point.t));
  const unselectedBefore = points.filter((point) => point.t < earliest
    && !automationPointIsSelected(point, range));
  const unselectedAfter = points.filter((point) => point.t > latest
    && !automationPointIsSelected(point, range));
  const previousTime = unselectedBefore.length > 0
    ? Math.max(...unselectedBefore.map((point) => point.t)) : null;
  const nextTime = unselectedAfter.length > 0
    ? Math.min(...unselectedAfter.map((point) => point.t)) : null;
  const minimumDelta = previousTime === null ? -earliest
    : Math.max(-earliest, previousTime + AUTOMATION_TIME_EPSILON_SEC - earliest);
  const maximumDelta = nextTime === null ? Number.POSITIVE_INFINITY
    : nextTime - AUTOMATION_TIME_EPSILON_SEC - latest;
  const appliedDelta = Math.min(maximumDelta, Math.max(minimumDelta, requestedDelta));
  return points.map((point) => automationPointIsSelected(point, range)
    ? { t: round(point.t + appliedDelta), v: point.v }
    : point);
}

export function automationPointsEqual(
  left: readonly AutoPoint[],
  right: readonly AutoPoint[],
): boolean {
  return left.length === right.length
    && left.every((point, index) => point.t === right[index]?.t && point.v === right[index]?.v);
}

export function automationReplacementBounds(
  before: readonly AutoPoint[],
  after: readonly AutoPoint[],
): AutomationReplacementBounds | null {
  const times = [...before, ...after].map((point) => point.t);
  return times.length > 0 ? { start: Math.min(...times), end: Math.max(...times) } : null;
}

export function automationClipboardFromSelection(
  points: readonly AutoPoint[],
  range: AutomationRange,
  sourceParamName: string,
): AutomationClipboard | null {
  const selected = points.filter((point) => automationPointIsSelected(point, range));
  if (selected.length === 0) return null;
  return {
    duration: round(range.end - range.start),
    sourceParamName,
    points: selected.map((point) => ({ t: round(point.t - range.start), v: point.v })),
  };
}

export function selectedAutomationPointIndices(
  points: readonly AutoPoint[],
  range: AutomationRange,
): readonly number[] {
  return points.map((point, index) => ({ point, index }))
    .filter(({ point }) => automationPointIsSelected(point, range))
    .map(({ index }) => index)
    .sort((left, right) => right - left);
}

export function automationPointsForPaste(
  clipboard: AutomationClipboard,
  insertionTime: number,
): readonly AutoPoint[] {
  return clipboard.points.map((point) => ({
    t: round(Math.max(0, insertionTime) + point.t),
    v: point.v,
  }));
}

export function automationLinePoints(start: AutoPoint, end: AutoPoint): readonly AutoPoint[] {
  const normalizedStart = { t: round(Math.max(0, start.t)), v: round(clampValue(start.v)) };
  const normalizedEnd = { t: round(Math.max(0, end.t)), v: round(clampValue(end.v)) };
  if (normalizedStart.t === normalizedEnd.t) return [normalizedEnd];
  return normalizedStart.t < normalizedEnd.t
    ? [normalizedStart, normalizedEnd]
    : [normalizedEnd, normalizedStart];
}

export function normalizeAutomationSamples(samples: readonly AutoPoint[]): readonly AutoPoint[] {
  const byTime = new Map<number, AutoPoint>();
  for (const sample of samples) {
    const point = { t: round(Math.max(0, sample.t)), v: round(clampValue(sample.v)) };
    byTime.set(point.t, point);
  }
  return [...byTime.values()].sort((left, right) => left.t - right.t);
}

export function automationSegmentPreview(
  points: readonly AutoPoint[],
  segment: readonly AutoPoint[],
): readonly AutoPoint[] {
  if (segment.length === 0) return points;
  const start = segment[0].t;
  const end = segment[segment.length - 1].t;
  return [...points.filter((point) => point.t < start || point.t > end), ...segment]
    .sort((left, right) => left.t - right.t);
}

export function moveAutomationPoint({
  point,
  deltaX,
  deltaY,
  pxPerSec,
  graphHeightPx = AUTOMATION_GRAPH_HEIGHT_PX,
}: PointMove): AutoPoint {
  return {
    t: round(Math.max(0, point.t + deltaX / pxPerSec)),
    v: round(clampValue(point.v - deltaY / graphHeightPx)),
  };
}

export function replaceAutomationPoint(
  points: readonly AutoPoint[],
  pointIndex: number,
  replacement: AutoPoint,
): readonly AutoPoint[] {
  return points.map((point, index) => index === pointIndex ? replacement : point);
}
