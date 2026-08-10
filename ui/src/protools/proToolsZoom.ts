import { useStore } from "../store";

export const HORIZONTAL_ZOOM_LEVELS = [20, 28, 40, 56, 80, 112, 160, 224, 320, 400] as const;
export const DEFAULT_HORIZONTAL_ZOOM_PRESETS = [32, 56, 80, 160, 320] as const;
export const VERTICAL_ZOOM_LEVELS = [0.5, 0.75, 1, 1.5, 2, 3, 4] as const;

type PendingZoomScroll = {
  readonly timeline: HTMLDivElement;
  readonly pxPerSec: number;
  readonly scrollLeft: number;
  readonly epoch: number;
  readonly generation: number;
};

let zoomGeneration = 0;
let pendingZoomScroll: PendingZoomScroll | null = null;

export function clampHorizontalZoom(pxPerSec: number): number {
  return Math.min(400, Math.max(20, pxPerSec));
}

export function nextHorizontalZoom(current: number, direction: -1 | 1): number {
  if (direction > 0) return HORIZONTAL_ZOOM_LEVELS.find((level) => level > current) ?? 400;
  return [...HORIZONTAL_ZOOM_LEVELS].reverse().find((level) => level < current) ?? 20;
}

export function clampVerticalZoom(value: number): number {
  return Math.min(4, Math.max(0.5, Number.isFinite(value) ? value : 1));
}

export function nextVerticalZoom(current: number, direction: -1 | 1): number {
  if (direction > 0) return VERTICAL_ZOOM_LEVELS.find((level) => level > current) ?? 4;
  return [...VERTICAL_ZOOM_LEVELS].reverse().find((level) => level < current) ?? 0.5;
}

function timelineElement(): HTMLDivElement | null {
  return document.querySelector<HTMLDivElement>(".pt-timeline-scroll");
}

function deferScroll(effect: () => void): void {
  if (typeof requestAnimationFrame === "function") requestAnimationFrame(effect);
  else window.setTimeout(effect, 0);
}

function scheduleTimelineScroll(
  timeline: HTMLDivElement,
  pxPerSec: number,
  scrollLeft: number,
  epoch: number,
): void {
  zoomGeneration += 1;
  const generation = zoomGeneration;
  pendingZoomScroll = { timeline, pxPerSec, scrollLeft, epoch, generation };
  deferScroll(() => {
    if (pendingZoomScroll?.generation !== generation) return;
    pendingZoomScroll = null;
    if (useStore.getState().projectEpoch !== epoch || !timeline.isConnected) return;
    timeline.scrollLeft = scrollLeft;
    timeline.dispatchEvent(new Event("scroll"));
  });
}

export function applyHorizontalZoom(nextValue: number, anchorClientX?: number): void {
  const store = useStore.getState();
  const previous = store.pxPerSec;
  const next = clampHorizontalZoom(nextValue);
  if (next === previous) return;
  const timeline = timelineElement();
  const epoch = store.projectEpoch;
  let anchorTime: number | null = null;
  let anchorPx = 0;
  if (timeline) {
    const rect = timeline.getBoundingClientRect();
    const viewportWidth = timeline.clientWidth || rect.width;
    anchorPx = anchorClientX === undefined
      ? viewportWidth / 2
      : Math.min(viewportWidth, Math.max(0, anchorClientX - rect.left));
    const effectiveScrollLeft = pendingZoomScroll?.timeline === timeline
      && pendingZoomScroll.epoch === epoch
      && pendingZoomScroll.pxPerSec === previous
      ? pendingZoomScroll.scrollLeft
      : timeline.scrollLeft;
    anchorTime = (effectiveScrollLeft + anchorPx) / previous;
  }

  store.setPxPerSec(next);
  if (!timeline || anchorTime === null) return;
  scheduleTimelineScroll(timeline, next, Math.max(0, anchorTime * next - anchorPx), epoch);
}

export function applyHorizontalZoomStep(direction: -1 | 1, anchorClientX?: number): void {
  applyHorizontalZoom(nextHorizontalZoom(useStore.getState().pxPerSec, direction), anchorClientX);
}

export function applyHorizontalZoomRange(
  timeline: HTMLDivElement,
  startContentX: number,
  endContentX: number,
): boolean {
  const store = useStore.getState();
  const distance = Math.abs(endContentX - startContentX);
  if (distance < 8) return false;
  const startSeconds = Math.min(startContentX, endContentX) / store.pxPerSec;
  const durationSeconds = distance / store.pxPerSec;
  const viewportWidth = timeline.clientWidth || timeline.getBoundingClientRect().width;
  if (!Number.isFinite(durationSeconds) || durationSeconds <= 0 || viewportWidth <= 0) return false;
  const next = clampHorizontalZoom((viewportWidth * 0.9) / durationSeconds);
  const epoch = store.projectEpoch;
  store.setPxPerSec(next);
  scheduleTimelineScroll(timeline, next, Math.max(0, startSeconds * next - viewportWidth * 0.05), epoch);
  return true;
}
