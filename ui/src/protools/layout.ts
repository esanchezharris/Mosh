import type { Snapshot } from "../types";
import { gridLines, secAtBeat, secondsToBBSMap, tempoMapFrom } from "../time";
import { contentSeconds } from "../v2/timeline/geom";
import { BASE_TRACK_ROW_HEIGHT } from "./trackHeightZoom";

export const TRACK_ROW_HEIGHT = BASE_TRACK_ROW_HEIGHT;
export const AUDIO_CLIP_HEADER_PX = 44;
export const CLIP_VISUAL_HEADER_PX = 16;
export const PROTOOLS_TIMECODE_FPS = 30;

export type ProToolsRulerTick = {
  readonly seconds: number;
  readonly label: string;
  readonly major: boolean;
};

const NICE_STEPS = [
  1 / 30, 1 / 15, 0.1, 0.25, 0.5, 1, 2, 5, 10, 15, 30,
  60, 120, 300, 600, 900, 1_800, 3_600,
] as const;
const MAX_TICKS = 2_048;

const finitePositive = (value: number, fallback: number) =>
  Number.isFinite(value) && value > 0 ? value : fallback;

export function timelineSeconds(snapshot: Snapshot): number {
  const map = tempoMapFrom(snapshot.session);
  const lastMarker = (snapshot.annotations ?? []).reduce((latest, annotation) => {
    if (!Number.isFinite(annotation.beat)) return latest;
    return Math.max(latest, secAtBeat(map, annotation.beat) + 4);
  }, 0);
  return finitePositive(Math.max(contentSeconds(snapshot), lastMarker), 32);
}

export function timelinePxPerSecond(contentWidth: number, totalSeconds: number): number {
  return finitePositive(contentWidth, 1) / finitePositive(totalSeconds, 1);
}

export function secondsAtClientX(
  clientX: number,
  rectLeft: number,
  contentWidth: number,
  totalSeconds: number,
): number {
  const width = finitePositive(contentWidth, 1);
  const total = finitePositive(totalSeconds, 1);
  const fraction = Math.min(1, Math.max(0, (clientX - rectLeft) / width));
  return fraction * total;
}

export function secondsAtScrollLeft(
  scrollLeft: number,
  contentWidth: number,
  totalSeconds: number,
): number {
  return secondsAtClientX(scrollLeft, 0, contentWidth, totalSeconds);
}

export function formatTimecode(seconds: number, fps = PROTOOLS_TIMECODE_FPS): string {
  const safeFps = Math.max(1, Math.round(finitePositive(fps, PROTOOLS_TIMECODE_FPS)));
  const frames = Math.max(0, Math.floor((Number.isFinite(seconds) ? seconds : 0) * safeFps + 1e-6));
  const frame = frames % safeFps;
  const wholeSeconds = Math.floor(frames / safeFps);
  const second = wholeSeconds % 60;
  const minute = Math.floor(wholeSeconds / 60) % 60;
  const hour = Math.floor(wholeSeconds / 3_600);
  return [hour, minute, second, frame]
    .map((value) => String(value).padStart(2, "0"))
    .join(":");
}

export function formatMinutesSeconds(seconds: number): string {
  const milliseconds = Math.max(0, Math.round((Number.isFinite(seconds) ? seconds : 0) * 1_000));
  const minute = Math.floor(milliseconds / 60_000);
  const second = Math.floor(milliseconds / 1_000) % 60;
  const millis = milliseconds % 1_000;
  return `${String(minute).padStart(2, "0")}:${String(second).padStart(2, "0")}.${String(millis).padStart(3, "0")}`;
}

export function formatSamples(seconds: number, sampleRate: number): string {
  const rate = finitePositive(sampleRate, 48_000);
  const sample = Math.max(0, Math.round((Number.isFinite(seconds) ? seconds : 0) * rate));
  return sample.toLocaleString("en-US");
}

export function linearRulerTicks(
  totalSeconds: number,
  contentWidth: number,
  format: (seconds: number) => string,
  minLabelPx = 84,
): ProToolsRulerTick[] {
  const total = Math.max(0, Number.isFinite(totalSeconds) ? totalSeconds : 0);
  const pxPerSecond = timelinePxPerSecond(contentWidth, total || 1);
  const desired = Math.max(minLabelPx / pxPerSecond, total / (MAX_TICKS - 1));
  const step = NICE_STEPS.find((candidate) => candidate >= desired)
    ?? Math.ceil(desired / 3_600) * 3_600;
  const ticks: ProToolsRulerTick[] = [];
  for (let seconds = 0; seconds <= total + 1e-6 && ticks.length < MAX_TICKS; seconds += step) {
    ticks.push({ seconds, label: format(seconds), major: true });
  }
  return ticks;
}

export function barsBeatsRulerTicks(
  snapshot: Snapshot,
  contentWidth: number,
): ProToolsRulerTick[] {
  const total = timelineSeconds(snapshot);
  const pxPerSecond = timelinePxPerSecond(contentWidth, total);
  const map = tempoMapFrom(snapshot.session);
  const { bars, beats } = gridLines(map, 0, total);
  const barStride = Math.max(1, Math.ceil(62 / Math.max(1, (bars[1]?.sec ?? total) * pxPerSecond)));
  const major = bars.map((bar, index) => ({
    seconds: bar.sec,
    label: index % barStride === 0 ? `${bar.label}|1` : "",
    major: true,
  }));
  const minor = pxPerSecond >= 56
    ? beats.map((seconds) => ({
        seconds,
        label: pxPerSecond >= 110 ? secondsToBBSMap(map, seconds).replace(/\./g, "|") : "",
        major: false,
      }))
    : [];
  return [...major, ...minor].sort((a, b) => a.seconds - b.seconds);
}
