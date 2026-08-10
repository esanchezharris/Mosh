import type { Snapshot } from "../types";

export const PROTOOLS_UNIVERSE_MIN_HEIGHT = 44;
export const PROTOOLS_UNIVERSE_DEFAULT_HEIGHT = 72;
export const PROTOOLS_UNIVERSE_MAX_HEIGHT = 160;
export const PROTOOLS_UNIVERSE_TRACK_ROW_MIN_HEIGHT = 6;

const PROTOOLS_UNIVERSE_VERTICAL_CHROME = 11;

export type ProToolsUniverseClip = {
  readonly clipId: string;
  readonly startFraction: number;
  readonly widthFraction: number;
};

export type ProToolsUniverseTrack = {
  readonly trackId: string;
  readonly trackName: string;
  readonly color?: string;
  readonly clips: readonly ProToolsUniverseClip[];
};

export type ProToolsUniverseViewport = {
  readonly scrollLeft: number;
  readonly scrollTop: number;
  readonly clientWidth: number;
  readonly clientHeight: number;
  readonly scrollWidth: number;
  readonly scrollHeight: number;
};

export type ProToolsUniverseFrame = {
  readonly left: number;
  readonly top: number;
  readonly width: number;
  readonly height: number;
};

export type ProToolsUniverseTrackWindow = {
  readonly start: number;
  readonly end: number;
  readonly visibleCount: number;
  readonly maxStart: number;
  readonly scrollable: boolean;
  readonly canScrollUp: boolean;
  readonly canScrollDown: boolean;
};

export type ProToolsUniverseWindowFrame = ProToolsUniverseFrame & {
  readonly visible: boolean;
};

const clamp = (value: number, min: number, max: number): number => (
  Math.min(max, Math.max(min, Number.isFinite(value) ? value : min))
);

const positive = (value: number): number => (
  Number.isFinite(value) && value > 0 ? value : 1
);

export const clampProToolsUniverseHeight = (height: number): number => (
  clamp(height, PROTOOLS_UNIVERSE_MIN_HEIGHT, PROTOOLS_UNIVERSE_MAX_HEIGHT)
);

export function buildProToolsUniverseTracks(
  snapshot: Snapshot,
  totalSeconds: number,
): readonly ProToolsUniverseTrack[] {
  const duration = positive(totalSeconds);
  return snapshot.tracks
    .filter((track) => !track.isGroup && !track.isReturn)
    .map((track) => ({
      trackId: track.id,
      trackName: track.name,
      ...(track.color ? { color: track.color } : {}),
      clips: track.clips.flatMap((clip) => {
        if (clip.hidden || !Number.isFinite(clip.start) || !Number.isFinite(clip.length)) return [];
        const startFraction = clamp(clip.start / duration, 0, 1);
        const endFraction = clamp((clip.start + Math.max(0, clip.length)) / duration, 0, 1);
        return endFraction > startFraction
          ? [{ clipId: clip.id, startFraction, widthFraction: endFraction - startFraction }]
          : [];
      }),
    }));
}

export function proToolsUniverseFrame(
  viewport: ProToolsUniverseViewport,
): ProToolsUniverseFrame {
  const scrollWidth = positive(viewport.scrollWidth);
  const scrollHeight = positive(viewport.scrollHeight);
  const width = clamp(viewport.clientWidth / scrollWidth, 0, 1);
  const height = clamp(viewport.clientHeight / scrollHeight, 0, 1);
  return {
    left: clamp(viewport.scrollLeft / scrollWidth, 0, 1 - width),
    top: clamp(viewport.scrollTop / scrollHeight, 0, 1 - height),
    width,
    height,
  };
}

export function proToolsUniverseTarget(
  point: { readonly x: number; readonly y: number },
  viewport: ProToolsUniverseViewport,
): { readonly scrollLeft: number; readonly scrollTop: number } {
  const scrollWidth = positive(viewport.scrollWidth);
  const scrollHeight = positive(viewport.scrollHeight);
  const maxLeft = Math.max(0, scrollWidth - Math.max(0, viewport.clientWidth));
  const maxTop = Math.max(0, scrollHeight - Math.max(0, viewport.clientHeight));
  return {
    scrollLeft: clamp(
      clamp(point.x, 0, 1) * scrollWidth - Math.max(0, viewport.clientWidth) / 2,
      0,
      maxLeft,
    ),
    scrollTop: clamp(
      clamp(point.y, 0, 1) * scrollHeight - Math.max(0, viewport.clientHeight) / 2,
      0,
      maxTop,
    ),
  };
}

export function proToolsUniverseTrackWindow(
  totalTracks: number,
  height: number,
  requestedStart: number,
): ProToolsUniverseTrackWindow {
  const total = Number.isFinite(totalTracks) ? Math.max(0, Math.floor(totalTracks)) : 0;
  const availableHeight = Math.max(1, height - PROTOOLS_UNIVERSE_VERTICAL_CHROME);
  const capacity = Math.max(
    1,
    Math.floor(availableHeight / PROTOOLS_UNIVERSE_TRACK_ROW_MIN_HEIGHT),
  );
  const visibleCount = Math.min(total, capacity);
  const maxStart = Math.max(0, total - visibleCount);
  const start = Math.min(
    maxStart,
    Math.max(0, Number.isFinite(requestedStart) ? Math.floor(requestedStart) : 0),
  );
  const scrollable = total > visibleCount;
  return {
    start,
    end: start + visibleCount,
    visibleCount,
    maxStart,
    scrollable,
    canScrollUp: scrollable && start > 0,
    canScrollDown: scrollable && start < maxStart,
  };
}

export function proToolsUniverseGlobalY(
  localY: number,
  window: ProToolsUniverseTrackWindow,
  totalTracks: number,
): number {
  const total = Number.isFinite(totalTracks) ? Math.max(0, Math.floor(totalTracks)) : 0;
  if (total === 0 || window.visibleCount === 0) return clamp(localY, 0, 1);
  return clamp(
    (window.start + clamp(localY, 0, 1) * window.visibleCount) / total,
    0,
    1,
  );
}

export function proToolsUniverseFrameInTrackWindow(
  frame: ProToolsUniverseFrame,
  window: ProToolsUniverseTrackWindow,
  totalTracks: number,
): ProToolsUniverseWindowFrame {
  const total = Number.isFinite(totalTracks) ? Math.max(0, Math.floor(totalTracks)) : 0;
  if (total === 0 || window.visibleCount === 0) {
    return { ...frame, top: 0, height: 1, visible: true };
  }
  const windowStart = window.start / total;
  const windowEnd = window.end / total;
  const windowHeight = positive(windowEnd - windowStart);
  const frameStart = clamp(frame.top, 0, 1);
  const frameEnd = clamp(frame.top + frame.height, 0, 1);
  const overlapStart = Math.max(frameStart, windowStart);
  const overlapEnd = Math.min(frameEnd, windowEnd);
  if (overlapEnd <= overlapStart) {
    return {
      ...frame,
      top: frameEnd <= windowStart ? 0 : 1,
      height: 0,
      visible: false,
    };
  }
  return {
    ...frame,
    top: (overlapStart - windowStart) / windowHeight,
    height: (overlapEnd - overlapStart) / windowHeight,
    visible: true,
  };
}
