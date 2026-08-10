import type { Snapshot } from "../types";

export const PROTOOLS_UNIVERSE_MIN_HEIGHT = 44;
export const PROTOOLS_UNIVERSE_DEFAULT_HEIGHT = 72;
export const PROTOOLS_UNIVERSE_MAX_HEIGHT = 160;

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
