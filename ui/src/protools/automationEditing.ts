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
  readonly points: readonly AutoPoint[];
};

export type AutomationReplacementBounds = {
  readonly start: number;
  readonly end: number;
};

type PointMove = {
  readonly point: AutoPoint;
  readonly deltaX: number;
  readonly deltaY: number;
  readonly pxPerSec: number;
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
    points: param.points ?? [],
  };
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

export function moveAutomationPoint({ point, deltaX, deltaY, pxPerSec }: PointMove): AutoPoint {
  return {
    t: round(Math.max(0, point.t + deltaX / pxPerSec)),
    v: round(clampValue(point.v - deltaY / AUTOMATION_GRAPH_HEIGHT_PX)),
  };
}

export function replaceAutomationPoint(
  points: readonly AutoPoint[],
  pointIndex: number,
  replacement: AutoPoint,
): readonly AutoPoint[] {
  return points.map((point, index) => index === pointIndex ? replacement : point);
}
