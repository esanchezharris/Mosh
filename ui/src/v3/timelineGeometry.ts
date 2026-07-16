import { barSeconds, beatSeconds, meterFrom } from "../time";
import type { ZoomBars } from "./state";

export type TimelineSnapshot = {
  readonly session: {
    readonly tempo?: number;
    readonly timeSigNumerator?: number;
    readonly timeSigDenominator?: number;
    readonly length?: number;
  };
  readonly tracks: readonly {
    readonly clips: readonly {
      readonly start: number;
      readonly length: number;
      readonly hidden?: boolean;
    }[];
  }[];
  readonly sections?: readonly {
    readonly id: string;
    readonly name: string;
    readonly startBeat: number;
    readonly endBeat: number;
    readonly color?: string;
  }[];
};

export type VisibleRange = {
  readonly startSec: number;
  readonly endSec: number;
  readonly spanSec: number;
};

export type ClipRect = {
  readonly leftFrac: number;
  readonly widthFrac: number;
};

export type ZoomViewRequest = {
  readonly range: VisibleRange;
  readonly nextSpanSec: number;
  readonly totalSec: number;
  readonly transportSec: number;
};

const MIN_SONG_SECONDS = 32;
const SONG_TAIL_SECONDS = 4;

export function beatToSeconds(snapshot: TimelineSnapshot, beat: number): number {
  return Math.max(0, beat) * beatSeconds(meterFrom(snapshot.session));
}

// Keep the v3 overview on the same extent rules as v2 timeline/geom: the session,
// last visible clip, and last section all contribute, followed by a short tail and
// a 32-second floor for empty projects.
export function songEndSeconds(snapshot: TimelineSnapshot): number {
  let end = snapshot.session.length ?? 0;
  for (const track of snapshot.tracks) {
    for (const clip of track.clips) {
      if (!clip.hidden) end = Math.max(end, clip.start + clip.length);
    }
  }
  for (const section of snapshot.sections ?? []) {
    end = Math.max(end, beatToSeconds(snapshot, section.endBeat));
  }
  return Math.max(end + SONG_TAIL_SECONDS, MIN_SONG_SECONDS);
}

export function visibleSpanSeconds(snapshot: TimelineSnapshot, zoom: ZoomBars): number {
  const totalSec = songEndSeconds(snapshot);
  if (zoom === "full") return totalSec;
  return Math.min(totalSec, zoom * barSeconds(meterFrom(snapshot.session)));
}

export function clampViewStart(startSec: number, totalSec: number, spanSec: number): number {
  return Math.max(0, Math.min(Number.isFinite(startSec) ? startSec : 0, Math.max(0, totalSec - spanSec)));
}

export function visibleRange(snapshot: TimelineSnapshot, zoom: ZoomBars, viewStartSec: number): VisibleRange {
  const totalSec = songEndSeconds(snapshot);
  const spanSec = visibleSpanSeconds(snapshot, zoom);
  const startSec = zoom === "full" ? 0 : clampViewStart(viewStartSec, totalSec, spanSec);
  return { startSec, endSec: startSec + spanSec, spanSec };
}

export function centeredViewStart(range: VisibleRange, nextSpanSec: number, totalSec: number): number {
  const centerSec = range.startSec + range.spanSec / 2;
  return clampViewStart(centerSec - nextSpanSec / 2, totalSec, nextSpanSec);
}

export function zoomedViewStart({ range, nextSpanSec, totalSec, transportSec }: ZoomViewRequest): number {
  const anchorSec = transportSec >= range.startSec && transportSec <= range.endSec
    ? transportSec
    : range.startSec + range.spanSec / 2;
  return clampViewStart(anchorSec - nextSpanSec / 2, totalSec, nextSpanSec);
}

export function navigatorFraction(seconds: number, totalSec: number): number {
  return Math.max(0, Math.min(1, seconds / Math.max(1, totalSec)));
}

export function clipRectInRange(startSec: number, lengthSec: number, range: VisibleRange): ClipRect | null {
  const clippedStart = Math.max(startSec, range.startSec);
  const clippedEnd = Math.min(startSec + Math.max(0, lengthSec), range.endSec);
  if (clippedEnd <= clippedStart) return null;
  return {
    leftFrac: (clippedStart - range.startSec) / range.spanSec,
    widthFrac: (clippedEnd - clippedStart) / range.spanSec,
  };
}

export function playheadX(positionSec: number, range: VisibleRange, widthPx: number): number | null {
  if (positionSec < range.startSec || positionSec > range.endSec || widthPx <= 0) return null;
  return ((positionSec - range.startSec) / range.spanSec) * widthPx;
}
