import { snapTimeMap, tempoMapFrom, type SnapDiv } from "../time";
import type { Snapshot } from "../types";
import type { TimeRangeSel } from "../v2/shellState";
import type { ProToolsEditMode } from "./proToolsState";

type SelectionSecondOptions = {
  readonly clientX: number;
  readonly rectLeft: number;
  readonly pxPerSecond: number;
  readonly totalSeconds: number;
  readonly editMode: ProToolsEditMode;
  readonly bypassSnap: boolean;
  readonly session: Snapshot["session"];
  readonly snapDivision: SnapDiv;
  readonly snapTriplet: boolean;
};

const finiteOr = (value: number, fallback: number): number =>
  Number.isFinite(value) ? value : fallback;

const clampSecond = (value: number, totalSeconds: number): number =>
  Math.max(0, Math.min(finiteOr(totalSeconds, 0), finiteOr(value, 0)));

export function proToolsSelectionSecondAt(options: SelectionSecondOptions): number {
  const pxPerSecond = Math.max(1e-6, finiteOr(options.pxPerSecond, 1));
  const raw = clampSecond((options.clientX - options.rectLeft) / pxPerSecond, options.totalSeconds);
  if (options.editMode !== "grid" || options.bypassSnap) return raw;
  const snapped = snapTimeMap(
    tempoMapFrom(options.session),
    raw,
    options.snapDivision,
    options.snapTriplet,
  );
  return clampSecond(snapped, options.totalSeconds);
}

export function normalizedProToolsSelection(anchor: number, current: number): TimeRangeSel {
  return {
    start: Math.min(anchor, current),
    end: Math.max(anchor, current),
  };
}

export function extendedProToolsSelection(
  range: TimeRangeSel | null,
  playhead: number,
  next: number,
  direction: -1 | 1,
): TimeRangeSel {
  if (!range || range.end <= range.start) return normalizedProToolsSelection(playhead, next);
  return direction > 0
    ? { start: range.start, end: Math.max(range.end, next) }
    : { start: Math.min(range.start, next), end: range.end };
}
