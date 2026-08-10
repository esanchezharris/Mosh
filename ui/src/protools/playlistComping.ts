export const PROTOOLS_PLAYLIST_MIN_COMP_SEC = 0.02;

export type PlaylistCompTimeRange = {
  readonly start: number;
  readonly end: number;
};

const clamp = (value: number, low: number, high: number) => Math.max(low, Math.min(high, value));

export function playlistSecondsAtClientX(
  clientX: number,
  rectLeft: number,
  clipStart: number,
  clipLength: number,
  pxPerSec: number,
): number {
  const clipEnd = clipStart + Math.max(0, clipLength);
  if (![clientX, rectLeft, clipStart, clipLength, pxPerSec].every(Number.isFinite) || pxPerSec <= 0) {
    return clipStart;
  }
  return clamp(clipStart + (clientX - rectLeft) / pxPerSec, clipStart, clipEnd);
}

export function normalizePlaylistCompRange(
  anchor: number,
  head: number,
  clipStart: number,
  clipLength: number,
  minimumLength = PROTOOLS_PLAYLIST_MIN_COMP_SEC,
): PlaylistCompTimeRange | null {
  if (![anchor, head, clipStart, clipLength, minimumLength].every(Number.isFinite)
    || clipLength <= 0 || minimumLength < 0) return null;
  const clipEnd = clipStart + clipLength;
  const start = clamp(Math.min(anchor, head), clipStart, clipEnd);
  const end = clamp(Math.max(anchor, head), clipStart, clipEnd);
  return end - start >= minimumLength ? { start, end } : null;
}
