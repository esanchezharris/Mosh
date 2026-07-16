import { useEffect, useRef, useState, type KeyboardEvent, type PointerEvent } from "react";
import { useStore } from "../store";
import type { PeerInfo, PeerPresence } from "../multiplayer/sync";
import { useOpenLanes } from "./state";
import {
  clampViewStart,
  navigatorFraction,
  songEndSeconds,
  type TimelineSnapshot,
  type VisibleRange,
} from "./timelineGeometry";
import { NavigatorOverview } from "./NavigatorOverview";

type NavigatorProps = {
  readonly snapshot: TimelineSnapshot;
  readonly range: VisibleRange;
};

type VisiblePeer = {
  readonly id: string;
  readonly name: string;
  readonly color: string;
  readonly position: number;
  readonly playing: boolean;
  readonly recording: boolean;
};

type DragState = {
  readonly pointerId: number;
  readonly grabOffsetSec: number;
  readonly startClientX: number;
  readonly moved: boolean;
};

const PEER_FRESH_MS = 8_000;
const DRAG_THRESHOLD_PX = 3;

export function visibleNavigatorPeers(
  presence: Readonly<Record<string, PeerPresence>>,
  peers: Readonly<Record<string, PeerInfo>>,
  nowMs: number,
): readonly VisiblePeer[] {
  return Object.entries(presence)
    .filter(([id, item]) => peers[id]?.online && nowMs - item.updatedAtMs < PEER_FRESH_MS)
    .map(([id, item]) => ({
      id,
      name: peers[id]?.name ?? id,
      color: peers[id]?.color ?? "#ff69a8",
      position: item.position,
      playing: item.playing,
      recording: item.recording,
    }));
}

export function Navigator({ snapshot, range }: NavigatorProps) {
  const exec = useStore((state) => state.exec);
  const peers = useStore((state) => state.peers);
  const peerPresence = useStore((state) => state.peerPresence);
  const setViewStartSec = useOpenLanes((state) => state.setViewStartSec);
  const trackRef = useRef<HTMLDivElement>(null);
  const headRef = useRef<HTMLDivElement>(null);
  const trackWidthRef = useRef(0);
  const dragRef = useRef<DragState | null>(null);
  const [expiryTick, setExpiryTick] = useState(0);
  const totalSec = songEndSeconds(snapshot);
  const maxStartSec = Math.max(0, totalSec - range.spanSec);
  const spanFrac = range.spanSec / totalSec;
  const startFrac = range.startSec / totalSec;
  const viewportTranslate = spanFrac >= 1 ? 0 : (startFrac / spanFrac) * 100;
  const visiblePeers = visibleNavigatorPeers(peerPresence, peers, Date.now());

  useEffect(() => {
    const nowMs = Date.now();
    const expiries = Object.entries(peerPresence)
      .filter(([id, presence]) => peers[id]?.online && presence.updatedAtMs + PEER_FRESH_MS > nowMs)
      .map(([, presence]) => presence.updatedAtMs + PEER_FRESH_MS);
    if (expiries.length === 0) return;
    const nextExpiry = Math.min(...expiries);
    const timer = window.setTimeout(() => setExpiryTick((tick) => tick + 1), nextExpiry - nowMs + 1);
    return () => window.clearTimeout(timer);
  }, [expiryTick, peerPresence, peers]);

  useEffect(() => {
    const track = trackRef.current;
    const head = headRef.current;
    if (!track || !head) return;

    const updateHead = () => {
      const positionSec = useStore.getState().transport.position;
      const x = navigatorFraction(positionSec, totalSec) * trackWidthRef.current;
      head.style.transform = `translate3d(${x.toFixed(2)}px, 0, 0)`;
    };

    const unsubscribe = useStore.subscribe(updateHead);
    let observer: ResizeObserver | null = null;
    if (typeof ResizeObserver !== "undefined") {
      observer = new ResizeObserver((entries) => {
        const entry = entries[0];
        if (!entry) return;
        trackWidthRef.current = entry.contentRect.width;
        updateHead();
      });
      observer.observe(track);
    } else {
      trackWidthRef.current = track.getBoundingClientRect().width;
    }
    updateHead();
    return () => {
      unsubscribe();
      observer?.disconnect();
    };
  }, [totalSec]);

  const secondsAtPointer = (clientX: number): number => {
    const rect = trackRef.current?.getBoundingClientRect();
    if (!rect || rect.width <= 0) return 0;
    return navigatorFraction(clientX - rect.left, rect.width) * totalSec;
  };

  const moveViewport = (startSec: number) => {
    setViewStartSec(clampViewStart(startSec, totalSec, range.spanSec));
  };

  const seekTransport = (positionSec: number) => {
    const clampedPosition = Math.max(0, Math.min(totalSec, positionSec));
    moveViewport(clampedPosition - range.spanSec / 2);
    void exec("set_transport", { position: clampedPosition });
  };

  const seekFromBackground = (event: PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    seekTransport(secondsAtPointer(event.clientX));
  };

  const beginViewportDrag = (event: PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    event.stopPropagation();
    dragRef.current = {
      pointerId: event.pointerId,
      grabOffsetSec: secondsAtPointer(event.clientX) - range.startSec,
      startClientX: event.clientX,
      moved: false,
    };
    if (typeof event.currentTarget.setPointerCapture === "function") {
      event.currentTarget.setPointerCapture(event.pointerId);
    }
  };

  const continueViewportDrag = (event: PointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    const moved = drag.moved || Math.abs(event.clientX - drag.startClientX) >= DRAG_THRESHOLD_PX;
    if (!moved) return;
    if (!drag.moved) dragRef.current = { ...drag, moved: true };
    moveViewport(secondsAtPointer(event.clientX) - drag.grabOffsetSec);
  };

  const endViewportDrag = (event: PointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    dragRef.current = null;
    if (!drag.moved) seekTransport(secondsAtPointer(event.clientX));
    if (typeof event.currentTarget.releasePointerCapture === "function") {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
  };

  const cancelViewportDrag = (event: PointerEvent<HTMLDivElement>) => {
    if (dragRef.current?.pointerId !== event.pointerId) return;
    dragRef.current = null;
    if (typeof event.currentTarget.releasePointerCapture === "function") {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
  };

  const nudgeViewport = (event: KeyboardEvent<HTMLDivElement>) => {
    const stepSec = Math.max(1, range.spanSec / 10);
    if (event.shiftKey) {
      const positionSec = useStore.getState().transport.position;
      let nextPositionSec: number | null = null;
      if (event.key === "ArrowLeft" || event.key === "ArrowDown") nextPositionSec = positionSec - stepSec;
      if (event.key === "ArrowRight" || event.key === "ArrowUp") nextPositionSec = positionSec + stepSec;
      if (event.key === "Home") nextPositionSec = 0;
      if (event.key === "End") nextPositionSec = totalSec;
      if (nextPositionSec === null) return;
      event.preventDefault();
      seekTransport(nextPositionSec);
      return;
    }
    let nextStartSec: number | null = null;
    if (event.key === "ArrowLeft" || event.key === "ArrowDown") nextStartSec = range.startSec - stepSec;
    if (event.key === "ArrowRight" || event.key === "ArrowUp") nextStartSec = range.startSec + stepSec;
    if (event.key === "Home") nextStartSec = 0;
    if (event.key === "End") nextStartSec = maxStartSec;
    if (nextStartSec === null) return;
    event.preventDefault();
    moveViewport(nextStartSec);
  };

  return (
    <div
      ref={trackRef}
      className="ol-navigator"
      data-testid="v3-navigator"
      aria-label="Song overview — click to seek"
      onPointerDown={seekFromBackground}
    >
      <NavigatorOverview snapshot={snapshot} totalSec={totalSec} />

      {visiblePeers.map((peer) => (
        <span
          key={peer.id}
          className={`ol-nav-peer${peer.playing ? " playing" : ""}${peer.recording ? " recording" : ""}`}
          data-testid="v3-nav-peer"
          title={peer.name}
          style={{ left: `${navigatorFraction(peer.position, totalSec) * 100}%`, backgroundColor: peer.color, color: peer.color }}
        >{peer.name.trim().slice(0, 2).toUpperCase()}</span>
      ))}

      <div
        className="ol-nav-viewport"
        data-testid="v3-nav-viewport"
        role="slider"
        tabIndex={0}
        aria-label="Visible arrangement window"
        aria-valuemin={0}
        aria-valuemax={Math.round(maxStartSec)}
        aria-valuenow={Math.round(range.startSec)}
        aria-valuetext={`${range.startSec.toFixed(1)} to ${range.endSec.toFixed(1)} seconds`}
        aria-keyshortcuts="Shift+ArrowLeft Shift+ArrowRight Shift+Home Shift+End"
        title="Drag to pan · click to seek · arrow keys pan · Shift+arrow keys seek"
        style={{ width: `${spanFrac * 100}%`, transform: `translate3d(${viewportTranslate}%, 0, 0)` }}
        onPointerDown={beginViewportDrag}
        onPointerMove={continueViewportDrag}
        onPointerUp={endViewportDrag}
        onPointerCancel={cancelViewportDrag}
        onKeyDown={nudgeViewport}
      />
      <div ref={headRef} className="ol-nav-head" data-testid="v3-nav-head" aria-hidden />
    </div>
  );
}
