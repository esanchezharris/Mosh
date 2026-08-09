import { useMemo, useRef, useState, type RefObject } from "react";
import { useStore } from "../store";
import { beatSeconds, meterFrom } from "../time";
import type { Clip, Snapshot, Track } from "../types";
import { applyNoteEdits } from "../ui/noteCommands";
import { ClipView } from "../v2/lanes/ClipView";
import { TRACK_ROW_HEIGHT, CLIP_VISUAL_HEADER_PX } from "./layout";
import { midiPointerIsBlank } from "./midiBlankHit";
import { ProToolsAutomationLane } from "./ProToolsAutomationLane";
import { ProToolsFadeHandles } from "./ProToolsFadeHandles";
import { proToolsGestureTable } from "./proToolsGestureTable";
import { useProTools } from "./proToolsState";
import { classifyProToolsIntent, type ProToolsIntent } from "./smartTool";

const capturePointer = (element: HTMLElement, pointerId: number): void => {
  if (typeof element.setPointerCapture !== "function") return;
  try {
    element.setPointerCapture(pointerId);
  } catch (error) {
    if (!(error instanceof DOMException)) throw error;
  }
};

const releasePointer = (element: HTMLElement, pointerId: number): void => {
  if (typeof element.releasePointerCapture !== "function") return;
  try {
    element.releasePointerCapture(pointerId);
  } catch (error) {
    if (!(error instanceof DOMException)) throw error;
  }
};

type Props = {
  snapshot: Snapshot;
  contentWidth: number;
  scrollRef: RefObject<HTMLDivElement>;
  onScroll: () => void;
};

type ClipMatch = { clip: Clip; track: Track };
type Marquee = { trackId: string; startX: number; x: number; top: number };

export function ProToolsTimeline({ snapshot, contentWidth, scrollRef, onScroll }: Props) {
  const pxPerSec = useStore((s) => s.pxPerSec);
  const select = useStore((s) => s.select);
  const clearSelection = useStore((s) => s.clearSelection);
  const position = useStore((s) => s.transport.position);
  const smartToolEnabled = useProTools((s) => s.smartToolEnabled);
  const activeTool = useProTools((s) => s.activeTool);
  const setHoveredIntent = useProTools((s) => s.setHoveredIntent);
  const tracks = snapshot.tracks.filter((track) => !track.isGroup && !track.isReturn);
  const clipMap = useMemo(() => new Map(tracks.flatMap((track) =>
    track.clips.map((clip) => [clip.id, { clip, track }] as const))), [tracks]);
  const beatsInSeconds = beatSeconds(meterFrom(snapshot.session));
  const [marquee, setMarquee] = useState<Marquee | null>(null);
  const marqueeRef = useRef<Marquee | null>(null);
  const velocityDrag = useRef<{
    pointerId: number; startY: number; clip: Clip; epoch: number;
  } | null>(null);
  const lastIntentClip = useRef<HTMLElement | null>(null);

  const hit = (e: React.PointerEvent): (ClipMatch & { element: HTMLElement; intent: ProToolsIntent; blank: boolean }) | null => {
    const element = (e.target as HTMLElement).closest<HTMLElement>("[data-clip-id]");
    const match = element?.dataset.clipId ? clipMap.get(element.dataset.clipId) : null;
    if (!element || !match) return null;
    const rect = element.getBoundingClientRect();
    const audio = match.clip.type === "wave";
    const blank = match.clip.type === "midi" && midiPointerIsBlank(
      match.clip,
      e.clientX - rect.left,
      e.clientY - rect.top,
      rect.width,
      rect.height,
      beatsInSeconds,
      match.track.type === "drum",
    );
    const intent = classifyProToolsIntent({
      media: audio ? "audio" : "midi",
      x: e.clientX - rect.left,
      y: e.clientY - rect.top,
      width: rect.width,
      height: rect.height,
      edgeGrabPx: 7,
      blank,
      meta: e.metaKey || e.ctrlKey,
      gesture: e.type === "pointerdown" ? "click" : "drag",
      smartToolEnabled,
      activeTool,
    });
    if (lastIntentClip.current !== element) lastIntentClip.current?.removeAttribute("data-pt-intent");
    element.dataset.ptIntent = intent;
    lastIntentClip.current = element;
    setHoveredIntent(intent);
    return { ...match, element, intent, blank };
  };

  const onPointerDownCapture = (e: React.PointerEvent<HTMLDivElement>) => {
    const current = hit(e);
    if (!current || e.button !== 0) return;
    if (current.intent === "velocity-trim" && current.clip.notes?.length) {
      e.preventDefault(); e.stopPropagation();
      select([current.clip.id]);
      velocityDrag.current = {
        pointerId: e.pointerId,
        startY: e.clientY,
        clip: current.clip,
        epoch: useStore.getState().projectEpoch,
      };
      capturePointer(e.currentTarget, e.pointerId);
      return;
    }
    if (current.intent !== "marquee") return;
    e.preventDefault(); e.stopPropagation();
    clearSelection();
    const contentRect = e.currentTarget.getBoundingClientRect();
    const lane = current.element.closest<HTMLElement>(".pt-lane");
    const next = {
      trackId: current.track.id,
      startX: e.clientX - contentRect.left,
      x: e.clientX - contentRect.left,
      top: lane?.offsetTop ?? 0,
    };
    marqueeRef.current = next;
    setMarquee(next);
    capturePointer(e.currentTarget, e.pointerId);
  };

  const onPointerMoveCapture = (e: React.PointerEvent<HTMLDivElement>) => {
    if (velocityDrag.current || marqueeRef.current) {
      e.preventDefault(); e.stopPropagation();
      if (marqueeRef.current) {
        const rect = e.currentTarget.getBoundingClientRect();
        const next = { ...marqueeRef.current, x: e.clientX - rect.left };
        marqueeRef.current = next;
        setMarquee(next);
      }
      return;
    }
    hit(e);
  };

  const finishGesture = (e: React.PointerEvent<HTMLDivElement>) => {
    const velocity = velocityDrag.current;
    if (velocity?.pointerId === e.pointerId) {
      e.preventDefault(); e.stopPropagation();
      velocityDrag.current = null;
      const delta = Math.round((velocity.startY - e.clientY) * 0.8);
      if (delta && useStore.getState().projectEpoch === velocity.epoch) {
        const edits = (velocity.clip.notes ?? []).map((note) => ({
          i: note.i,
          velocity: Math.max(1, Math.min(127, note.velocity + delta)),
        }));
        void applyNoteEdits(useStore.getState().exec, velocity.clip.id, edits);
      }
    }
    const area = marqueeRef.current;
    if (area) {
      e.preventDefault(); e.stopPropagation();
      marqueeRef.current = null; setMarquee(null);
      const start = Math.min(area.startX, area.x) / pxPerSec;
      const end = Math.max(area.startX, area.x) / pxPerSec;
      const ids = clipMap.size > 0 && end - start >= 0.02
        ? (snapshot.tracks.find((track) => track.id === area.trackId)?.clips ?? [])
            .filter((clip) => clip.start < end && clip.start + clip.length > start)
            .map((clip) => clip.id)
        : [];
      select(ids, false);
    }
    releasePointer(e.currentTarget, e.pointerId);
  };

  return (
    <div ref={scrollRef} className="pt-timeline-scroll" data-testid="pt-timeline" onScroll={onScroll}
      role="region" aria-label="Editing timeline" tabIndex={0}>
      <div className="pt-timeline-content" style={{ width: contentWidth }}
        onPointerDownCapture={onPointerDownCapture} onPointerMoveCapture={onPointerMoveCapture}
        onPointerUpCapture={finishGesture} onPointerCancelCapture={finishGesture}
        onPointerLeave={() => { lastIntentClip.current?.removeAttribute("data-pt-intent"); setHoveredIntent(null); }}>
        <div className="pt-timeline-title-spacer">Timeline</div>
        {tracks.map((track) => (
          <div key={track.id} className="pt-lane" data-testid="pt-lane" data-track-id={track.id}
            style={{
              height: TRACK_ROW_HEIGHT,
              "--pt-track-color": track.color ?? "var(--pt-selected)",
              "--pt-beat-px": `${beatsInSeconds * pxPerSec}px`,
            } as React.CSSProperties}>
            {track.clips.filter((clip) => !clip.hidden).map((clip) => {
              const media = clip.type === "wave" ? "audio" : "midi";
              return (
                <span key={clip.id}>
                  <ClipView clip={clip} trackType={track.type} snapshot={snapshot}
                    clipHeaderPx={media === "audio" ? (TRACK_ROW_HEIGHT - 30) / 2 : 0}
                    clipVisualHeaderPx={CLIP_VISUAL_HEADER_PX}
                    gestureTable={() => proToolsGestureTable(media, smartToolEnabled, activeTool)} />
                  {clip.type === "wave" && <ProToolsFadeHandles clip={clip} />}
                </span>
              );
            })}
            <ProToolsAutomationLane track={track} width={contentWidth} />
          </div>
        ))}
        {tracks.length === 0 && <p className="pt-timeline-empty" role="status">Add a track to begin editing.</p>}
        {marquee && <div className="pt-marquee" style={{
          left: Math.min(marquee.startX, marquee.x),
          top: marquee.top,
          width: Math.abs(marquee.x - marquee.startX),
          height: TRACK_ROW_HEIGHT,
        }} />}
        <div className="pt-playhead" data-testid="pt-playhead" style={{ left: position * pxPerSec }} aria-hidden="true" />
      </div>
    </div>
  );
}
