import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type RefObject,
} from "react";
import { useStore } from "../store";
import type { Snapshot } from "../types";
import { IconArrowUp } from "../ui/icons";
import { timelineSeconds } from "./layout";
import {
  buildProToolsUniverseTracks,
  proToolsUniverseFrameInTrackWindow,
  proToolsUniverseGlobalY,
  proToolsUniverseFrame,
  proToolsUniverseTarget,
  proToolsUniverseTrackWindow,
  type ProToolsUniverseViewport,
} from "./proToolsUniverse";
import { ProToolsUniverseResizer } from "./ProToolsUniverseResizer";
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
  const projectEpoch = useStore((state) => state.projectEpoch);
  const totalSeconds = timelineSeconds(snapshot);
  const tracks = useMemo(
    () => buildProToolsUniverseTracks(snapshot, totalSeconds),
    [snapshot, totalSeconds],
  );
  const [trackWindowStart, setTrackWindowStart] = useState(0);
  const trackWindow = useMemo(
    () => proToolsUniverseTrackWindow(tracks.length, height, trackWindowStart),
    [height, trackWindowStart, tracks.length],
  );
  const visibleTracks = tracks.slice(trackWindow.start, trackWindow.end);
  const frameRef = useRef<HTMLSpanElement>(null);

  const updateFrame = useCallback((): void => {
    const timeline = timelineRef.current;
    const frame = frameRef.current;
    if (!timeline || !frame) return;
    const next = proToolsUniverseFrameInTrackWindow(
      proToolsUniverseFrame(viewportOf(timeline)),
      trackWindow,
      tracks.length,
    );
    frame.style.left = percent(next.left);
    frame.style.top = percent(next.top);
    frame.style.width = percent(next.width);
    frame.style.height = percent(next.height);
    frame.dataset.visible = String(next.visible);
  }, [timelineRef, trackWindow, tracks.length]);

  useEffect(() => setTrackWindowStart(0), [projectEpoch]);

  useEffect(() => {
    setTrackWindowStart((current) => Math.min(current, trackWindow.maxStart));
  }, [trackWindow.maxStart]);

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
    const target = proToolsUniverseTarget({
      x,
      y: proToolsUniverseGlobalY(y, trackWindow, tracks.length),
    }, viewportOf(timeline));
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
        <span>{trackWindow.scrollable
          ? `Tracks ${trackWindow.start + 1}–${trackWindow.end} of ${tracks.length}`
          : `${tracks.length} ${tracks.length === 1 ? "track" : "tracks"}`}</span>
      </div>
      <div className="pt-universe-stage" data-scrollable={trackWindow.scrollable}>
        <button type="button" className="pt-universe-field" data-testid="pt-universe-field"
          aria-label={`Navigate the session overview. Showing tracks ${tracks.length === 0 ? 0 : trackWindow.start + 1} through ${trackWindow.end} of ${tracks.length}. Click, use arrow keys, or press Enter or Space to center the playhead.`}
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
          <span id="pt-universe-tracks" className="pt-universe-tracks" aria-hidden="true">
            {visibleTracks.map((track) => (
              <span key={track.trackId} className="pt-universe-track"
                data-testid="pt-universe-track" data-track-id={track.trackId}>
                {track.clips.map((clip) => (
                  <span key={clip.clipId} className="pt-universe-clip"
                    data-testid="pt-universe-clip" data-clip-id={clip.clipId}
                    style={{
                      left: percent(clip.startFraction),
                      width: percent(clip.widthFraction),
                      ...(track.color ? { "--pt-universe-color": track.color } : {}),
                    } satisfies UniverseClipStyle} />
                ))}
              </span>
            ))}
          </span>
          <span ref={frameRef} className="pt-universe-frame"
            data-testid="pt-universe-frame" aria-hidden="true" />
        </button>
        {trackWindow.scrollable && (
          <div className="pt-universe-scroll-controls" role="group"
            aria-label="Scroll tracks shown in the Universe overview">
            <button type="button" data-testid="pt-universe-scroll-up"
              aria-label="Scroll Universe tracks up" disabled={!trackWindow.canScrollUp}
              onClick={() => setTrackWindowStart(trackWindow.start - 1)}>
              <IconArrowUp size={12} />
            </button>
            <button type="button" data-testid="pt-universe-scroll-down"
              aria-label="Scroll Universe tracks down" disabled={!trackWindow.canScrollDown}
              onClick={() => setTrackWindowStart(trackWindow.start + 1)}>
              <IconArrowUp size={12} className="pt-universe-arrow-down-icon" />
            </button>
          </div>
        )}
      </div>
      <ProToolsUniverseResizer />
    </section>
  );
}
