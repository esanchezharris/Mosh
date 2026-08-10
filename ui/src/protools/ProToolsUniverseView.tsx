import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  type CSSProperties,
  type RefObject,
} from "react";
import { useStore } from "../store";
import type { Snapshot } from "../types";
import { timelineSeconds } from "./layout";
import { capturePointer, releasePointer } from "./pointerCapture";
import {
  buildProToolsUniverseTracks,
  PROTOOLS_UNIVERSE_DEFAULT_HEIGHT,
  PROTOOLS_UNIVERSE_MAX_HEIGHT,
  PROTOOLS_UNIVERSE_MIN_HEIGHT,
  proToolsUniverseFrame,
  proToolsUniverseTarget,
  type ProToolsUniverseViewport,
} from "./proToolsUniverse";
import { useProTools } from "./proToolsState";

type UniverseClipStyle = CSSProperties & { "--pt-universe-color"?: string };

const percent = (fraction: number): string => `${fraction * 100}%`;

function viewportOf(timeline: HTMLDivElement): ProToolsUniverseViewport {
  return {
    scrollLeft: timeline.scrollLeft,
    scrollTop: timeline.scrollTop,
    clientWidth: timeline.clientWidth,
    clientHeight: timeline.clientHeight,
    scrollWidth: timeline.scrollWidth,
    scrollHeight: timeline.scrollHeight,
  };
}

export function ProToolsUniverse({
  snapshot,
  timelineRef,
}: {
  readonly snapshot: Snapshot;
  readonly timelineRef: RefObject<HTMLDivElement>;
}) {
  const open = useProTools((state) => state.universeOpen);
  const height = useProTools((state) => state.universeHeight);
  const setHeight = useProTools((state) => state.setUniverseHeight);
  const totalSeconds = timelineSeconds(snapshot);
  const tracks = useMemo(
    () => buildProToolsUniverseTracks(snapshot, totalSeconds),
    [snapshot, totalSeconds],
  );
  const frameRef = useRef<HTMLSpanElement>(null);
  const resizeRef = useRef<{
    readonly pointerId: number;
    readonly startY: number;
    readonly startHeight: number;
  } | null>(null);

  const updateFrame = useCallback((): void => {
    const timeline = timelineRef.current;
    const frame = frameRef.current;
    if (!timeline || !frame) return;
    const next = proToolsUniverseFrame(viewportOf(timeline));
    frame.style.left = percent(next.left);
    frame.style.top = percent(next.top);
    frame.style.width = percent(next.width);
    frame.style.height = percent(next.height);
  }, [timelineRef]);

  useEffect(() => {
    if (!open) return;
    const timeline = timelineRef.current;
    if (!timeline) return;
    updateFrame();
    timeline.addEventListener("scroll", updateFrame);
    const observer = typeof ResizeObserver === "undefined"
      ? null
      : new ResizeObserver(updateFrame);
    observer?.observe(timeline);
    const timelineContent = timeline.querySelector<HTMLElement>(".pt-timeline-content");
    if (timelineContent) observer?.observe(timelineContent);
    return () => {
      timeline.removeEventListener("scroll", updateFrame);
      observer?.disconnect();
    };
  }, [open, timelineRef, updateFrame]);

  if (!open) return null;

  const setTimelineScroll = (scrollLeft: number, scrollTop: number): void => {
    const timeline = timelineRef.current;
    if (!timeline) return;
    timeline.scrollLeft = scrollLeft;
    timeline.scrollTop = scrollTop;
    timeline.dispatchEvent(new Event("scroll", { bubbles: true }));
    updateFrame();
  };

  const navigateTo = (x: number, y: number): void => {
    const timeline = timelineRef.current;
    if (!timeline) return;
    const target = proToolsUniverseTarget({ x, y }, viewportOf(timeline));
    setTimelineScroll(target.scrollLeft, target.scrollTop);
  };

  const navigateByKey = (event: React.KeyboardEvent<HTMLButtonElement>): void => {
    const timeline = timelineRef.current;
    if (!timeline) return;
    const viewport = viewportOf(timeline);
    const horizontalStep = Math.max(80, viewport.clientWidth * 0.75);
    const verticalStep = Math.max(40, viewport.clientHeight * 0.75);
    let left = viewport.scrollLeft;
    let top = viewport.scrollTop;
    switch (event.key) {
      case "ArrowLeft": left -= horizontalStep; break;
      case "ArrowRight": left += horizontalStep; break;
      case "ArrowUp": top -= verticalStep; break;
      case "ArrowDown": top += verticalStep; break;
      case "Home": left = 0; break;
      case "End": left = viewport.scrollWidth - viewport.clientWidth; break;
      default: return;
    }
    event.preventDefault();
    event.stopPropagation();
    const maxLeft = Math.max(0, viewport.scrollWidth - viewport.clientWidth);
    const maxTop = Math.max(0, viewport.scrollHeight - viewport.clientHeight);
    setTimelineScroll(
      Math.min(maxLeft, Math.max(0, left)),
      Math.min(maxTop, Math.max(0, top)),
    );
  };

  return (
    <section id="pt-universe" className="pt-universe" data-testid="pt-universe"
      aria-label="Universe session overview" style={{ height }}>
      <div className="pt-universe-label">
        <strong>Universe</strong>
        <span>Session overview</span>
      </div>
      <button type="button" className="pt-universe-field" data-testid="pt-universe-field"
        aria-label="Navigate the session overview. Click, use arrow keys, or press Enter or Space to center the playhead."
        aria-keyshortcuts="ArrowLeft ArrowRight ArrowUp ArrowDown Home End Enter Space"
        onKeyDown={navigateByKey}
        onClick={(event) => {
          const timeline = timelineRef.current;
          if (!timeline) return;
          if (event.detail === 0) {
            const position = useStore.getState().transport.position;
            const verticalCenter = (timeline.scrollTop + timeline.clientHeight / 2)
              / Math.max(1, timeline.scrollHeight);
            navigateTo(position / Math.max(1, totalSeconds), verticalCenter);
            return;
          }
          const rect = event.currentTarget.getBoundingClientRect();
          navigateTo(
            (event.clientX - rect.left) / Math.max(1, rect.width),
            (event.clientY - rect.top) / Math.max(1, rect.height),
          );
        }}>
        <span className="pt-universe-tracks" aria-hidden="true">
          {tracks.map((track) => (
            <span key={track.trackId} className="pt-universe-track"
              data-testid="pt-universe-track" data-track-id={track.trackId}>
              {track.clips.map((clip) => (
                <span key={clip.clipId} className="pt-universe-clip"
                  data-testid="pt-universe-clip" data-clip-id={clip.clipId}
                  style={{
                    left: percent(clip.startFraction),
                    width: percent(clip.widthFraction),
                    ...(track.color ? { "--pt-universe-color": track.color } : {}),
                  } as UniverseClipStyle} />
              ))}
            </span>
          ))}
        </span>
        <span ref={frameRef} className="pt-universe-frame"
          data-testid="pt-universe-frame" aria-hidden="true" />
      </button>
      <div className="pt-universe-resizer" data-testid="pt-universe-resizer"
        role="separator" aria-orientation="horizontal" aria-label="Resize Universe view"
        aria-valuemin={PROTOOLS_UNIVERSE_MIN_HEIGHT}
        aria-valuemax={PROTOOLS_UNIVERSE_MAX_HEIGHT}
        aria-valuenow={height} tabIndex={0}
        onDoubleClick={() => setHeight(PROTOOLS_UNIVERSE_DEFAULT_HEIGHT)}
        onPointerDown={(event) => {
          resizeRef.current = {
            pointerId: event.pointerId,
            startY: event.clientY,
            startHeight: height,
          };
          capturePointer(event.currentTarget, event.pointerId);
        }}
        onPointerMove={(event) => {
          const resize = resizeRef.current;
          if (!resize || resize.pointerId !== event.pointerId) return;
          setHeight(resize.startHeight + event.clientY - resize.startY);
        }}
        onPointerUp={(event) => {
          if (resizeRef.current?.pointerId !== event.pointerId) return;
          resizeRef.current = null;
          releasePointer(event.currentTarget, event.pointerId);
        }}
        onPointerCancel={(event) => {
          const resize = resizeRef.current;
          if (!resize || resize.pointerId !== event.pointerId) return;
          resizeRef.current = null;
          setHeight(resize.startHeight);
          releasePointer(event.currentTarget, event.pointerId);
        }}
        onKeyDown={(event) => {
          const next = event.key === "ArrowDown"
            ? height + 8
            : event.key === "ArrowUp"
              ? height - 8
              : event.key === "Home"
                ? PROTOOLS_UNIVERSE_MIN_HEIGHT
                : event.key === "End"
                  ? PROTOOLS_UNIVERSE_MAX_HEIGHT
                  : null;
          if (next === null) return;
          event.preventDefault();
          event.stopPropagation();
          setHeight(next);
        }} />
    </section>
  );
}
