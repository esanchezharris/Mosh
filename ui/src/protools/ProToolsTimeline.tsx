import { useMemo, useRef, useState, type RefObject } from "react";
import { useStore } from "../store";
import { beatSeconds, meterFrom } from "../time";
import type { Clip, Snapshot, Track } from "../types";
import { applyNoteEdits } from "../ui/noteCommands";
import { ClipView } from "../v2/lanes/ClipView";
import { TRACK_ROW_HEIGHT, CLIP_VISUAL_HEADER_PX } from "./layout";
import { midiPointerIsBlank } from "./midiBlankHit";
import { capturePointer, releasePointer } from "./pointerCapture";
import { ProToolsAutomationLane } from "./ProToolsAutomationLane";
import { ProToolsFadeHandles } from "./ProToolsFadeHandles";
import { proToolsGestureTable } from "./proToolsGestureTable";
import { useProTools } from "./proToolsState";
import { classifyProToolsIntent, type ProToolsIntent } from "./smartTool";

type Props = {
  snapshot: Snapshot;
  contentWidth: number;
  scrollRef: RefObject<HTMLDivElement>;
  onScroll: () => void;
  onSpotClip: (clip: Clip) => void;
};

type ClipMatch = { clip: Clip; track: Track };
type Marquee = { pointerId: number; trackId: string; startX: number; x: number; top: number };
type SpotCandidate = { pointerId: number; clip: Clip; epoch: number };

export function ProToolsTimeline({ snapshot, contentWidth, scrollRef, onScroll, onSpotClip }: Props) {
  const pxPerSec = useStore((s) => s.pxPerSec);
  const select = useStore((s) => s.select);
  const clearSelection = useStore((s) => s.clearSelection);
  const position = useStore((s) => s.transport.position);
  const smartToolEnabled = useProTools((s) => s.smartToolEnabled);
  const activeTool = useProTools((s) => s.activeTool);
  const editMode = useProTools((s) => s.editMode);
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
  const spotCandidate = useRef<SpotCandidate | null>(null);
  const lastIntentClip = useRef<HTMLElement | null>(null);

  const hit = (e: React.PointerEvent): (ClipMatch & { element: HTMLElement; intent: ProToolsIntent; blank: boolean }) | null => {
    if (!(e.target instanceof HTMLElement)) return null;
    const element = e.target.closest<HTMLElement>("[data-clip-id]");
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
    if (editMode === "spot" && current.intent === "grabber") {
      e.preventDefault(); e.stopPropagation();
      select([current.clip.id]);
      current.element.focus();
      spotCandidate.current = {
        pointerId: e.pointerId,
        clip: current.clip,
        epoch: useStore.getState().projectEpoch,
      };
      capturePointer(e.currentTarget, e.pointerId);
      return;
    }
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
      pointerId: e.pointerId,
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
    const spot = spotCandidate.current;
    if (spot?.pointerId === e.pointerId) {
      e.preventDefault(); e.stopPropagation();
      spotCandidate.current = null;
      releasePointer(e.currentTarget, e.pointerId);
      if (useStore.getState().projectEpoch === spot.epoch) onSpotClip(spot.clip);
      return;
    }
    const velocity = velocityDrag.current;
    let handled = false;
    if (velocity?.pointerId === e.pointerId) {
      e.preventDefault(); e.stopPropagation();
      handled = true;
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
    if (area?.pointerId === e.pointerId) {
      e.preventDefault(); e.stopPropagation();
      handled = true;
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
    if (handled) releasePointer(e.currentTarget, e.pointerId);
  };

  const cancelGesture = (e: React.PointerEvent<HTMLDivElement>) => {
    const velocity = velocityDrag.current;
    const area = marqueeRef.current;
    const spot = spotCandidate.current;
    const cancelled = velocity?.pointerId === e.pointerId
      || area?.pointerId === e.pointerId
      || spot?.pointerId === e.pointerId;
    if (!cancelled) return;
    e.preventDefault(); e.stopPropagation();
    if (velocity?.pointerId === e.pointerId) velocityDrag.current = null;
    if (spot?.pointerId === e.pointerId) spotCandidate.current = null;
    if (area?.pointerId === e.pointerId) {
      marqueeRef.current = null;
      setMarquee(null);
    }
    releasePointer(e.currentTarget, e.pointerId);
  };

  const onKeyDownCapture = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (editMode !== "spot" || (e.key !== "Enter" && e.key !== " ")) return;
    if (!smartToolEnabled && activeTool !== "grabber") return;
    if (!(e.target instanceof HTMLElement)) return;
    const element = e.target.closest<HTMLElement>("[data-clip-id]");
    const match = element?.dataset.clipId ? clipMap.get(element.dataset.clipId) : null;
    if (!match) return;
    e.preventDefault(); e.stopPropagation();
    select([match.clip.id]);
    onSpotClip(match.clip);
  };

  return (
    <div ref={scrollRef} className="pt-timeline-scroll" data-testid="pt-timeline" onScroll={onScroll}
      role="region" aria-label="Editing timeline" tabIndex={0}>
      <div className="pt-timeline-content" style={{ width: contentWidth }}
        onPointerDownCapture={onPointerDownCapture} onPointerMoveCapture={onPointerMoveCapture}
        onPointerUpCapture={finishGesture} onPointerCancelCapture={cancelGesture}
        onKeyDownCapture={onKeyDownCapture}
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
