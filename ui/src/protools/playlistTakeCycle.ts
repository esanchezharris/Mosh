import type { Clip, CommandResult } from "../types";
import type { TimeRangeSel } from "../v2/shellState";

export type PlaylistTakeCycleDirection = -1 | 1;

export type PlaylistCycleTarget = {
  readonly clipId: string;
  readonly start: number;
  readonly end: number;
  readonly currentTakeIndex: number;
  readonly takeCount: number;
};

const RANGE_EPSILON = 1e-6;

export function resolvePlaylistCycleTarget(
  clip: Clip,
  range: TimeRangeSel | null,
): PlaylistCycleTarget | null {
  if (clip.type !== "wave" || !range) return null;
  if (!Number.isFinite(range.start) || !Number.isFinite(range.end)) return null;
  const takeCount = clip.numTakes ?? clip.takes?.length ?? 0;
  if (!Number.isInteger(takeCount) || takeCount < 2) return null;
  const clipEnd = clip.start + clip.length;
  if (range.start < clip.start - RANGE_EPSILON
    || range.end > clipEnd + RANGE_EPSILON
    || range.end <= range.start + RANGE_EPSILON) return null;
  const requestedCurrent = clip.currentTakeIndex ?? 0;
  const currentTakeIndex = Number.isInteger(requestedCurrent)
    && requestedCurrent >= 0
    && requestedCurrent < takeCount
    ? requestedCurrent
    : 0;
  return {
    clipId: clip.id,
    start: Math.max(clip.start, range.start),
    end: Math.min(clipEnd, range.end),
    currentTakeIndex,
    takeCount,
  };
}

export function nextPlaylistTakeIndex(
  currentTakeIndex: number,
  takeCount: number,
  direction: PlaylistTakeCycleDirection,
): number {
  if (!Number.isInteger(takeCount) || takeCount < 2) return 0;
  const current = Number.isInteger(currentTakeIndex)
    ? Math.min(takeCount - 1, Math.max(0, currentTakeIndex))
    : 0;
  return (current + direction + takeCount) % takeCount;
}

export function promotedPlaylistClipId(result: CommandResult): string | null {
  if (!result.ok || typeof result.data !== "object" || result.data === null) return null;
  const clipId = Reflect.get(result.data, "clipId");
  return typeof clipId === "string" && clipId.length > 0 ? clipId : null;
}
