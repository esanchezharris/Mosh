// Open Lanes (v3) — the arrangement slab's lane stack. Each track is a chrome-off lane:
// at rest it's pure hue-tinted content; on hover/focus the name + M/S controls fade in
// (progressive disclosure). Stage 1 renders a compact clip preview per lane (clips as
// positioned hue blocks); Stage 2 swaps the focused body for the real inline editors
// (drum step-grid / MIDI piano-roll / audio waveform) reusing the proven renderers.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useStore } from "../store";
import { useOpenLanes } from "./state";
import { trackHue } from "./palette";
import type { Snapshot } from "../types";
import type { VisibleRange } from "./timelineGeometry";
import { startLanePlayheadLoop, type LaneGeometry } from "./lanePlayhead";
import { computeLaneLayout } from "./laneLayout";
import { LaneSurface } from "./LaneSurface";

function LanePlayhead({ trackId, register }: {
  trackId: string;
  register: (trackId: string, node: HTMLDivElement | null) => void;
}) {
  const attach = useCallback((node: HTMLDivElement | null) => register(trackId, node), [register, trackId]);
  return <div ref={attach} className="ol-ph" data-testid={`v3-lane-playhead-${trackId}`} />;
}

export function Lanes({ snapshot, range }: { snapshot: Snapshot; range: VisibleRange }) {
  const exec = useStore((s) => s.exec);
  const selectedTrackId = useStore((s) => s.selectedTrackId);
  const setSelectedTrack = useStore((s) => s.setSelectedTrack);
  const focusIdx = useOpenLanes((s) => s.focusIdx);
  const setFocusIdx = useOpenLanes((s) => s.setFocusIdx);
  const tracks = snapshot.tracks;
  const rootRef = useRef<HTMLDivElement>(null);
  const laneGeoRef = useRef(new Map<string, LaneGeometry>());
  const [availableHeightPx, setAvailableHeightPx] = useState(0);
  const rangeRef = useRef(range);
  rangeRef.current = range;
  const trackIds = tracks.map((track) => track.id).join("|");
  const layout = useMemo(
    () => computeLaneLayout(tracks.map((track) => track.id), availableHeightPx, focusIdx),
    [availableHeightPx, focusIdx, tracks],
  );
  const expandedIds = useMemo(() => new Set(layout.expandedTrackIds), [layout.expandedTrackIds]);

  const registerPlayhead = useCallback((trackId: string, node: HTMLDivElement | null) => {
    const geometry = laneGeoRef.current.get(trackId) ?? { head: null, contentLeftPx: 0, contentWidthPx: 0, expanded: false };
    geometry.head = node;
    laneGeoRef.current.set(trackId, geometry);
  }, []);

  // ResizeObserver is the only layout-reading path. The rAF transport loop below
  // consumes these cached widths and never calls getBoundingClientRect per frame.
  useEffect(() => {
    const root = rootRef.current;
    if (!root || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver((entries) => {
      for (const entry of entries) {
        if (!(entry.target instanceof HTMLElement)) continue;
        if (entry.target === root) {
          setAvailableHeightPx(Math.floor(entry.contentRect.height));
          continue;
        }
        const trackId = entry.target.dataset.laneContent;
        if (!trackId) continue;
        const geometry = laneGeoRef.current.get(trackId) ?? { head: null, contentLeftPx: 0, contentWidthPx: 0, expanded: false };
        geometry.contentLeftPx = entry.target.offsetLeft;
        geometry.contentWidthPx = entry.contentRect.width;
        laneGeoRef.current.set(trackId, geometry);
      }
    });
    observer.observe(root);
    root.querySelectorAll<HTMLElement>("[data-lane-content]").forEach((editor) => observer.observe(editor));
    return () => observer.disconnect();
  }, [layout.mode, trackIds]);

  useEffect(() => {
    const liveTrackIds = new Set(tracks.map((track) => track.id));
    tracks.forEach((track) => {
      const geometry = laneGeoRef.current.get(track.id) ?? { head: null, contentLeftPx: 0, contentWidthPx: 0, expanded: false };
      geometry.expanded = expandedIds.has(track.id);
      if (!geometry.expanded && geometry.head) geometry.head.style.visibility = "hidden";
      laneGeoRef.current.set(track.id, geometry);
    });
    for (const trackId of laneGeoRef.current.keys()) {
      if (!liveTrackIds.has(trackId)) laneGeoRef.current.delete(trackId);
    }
  }, [expandedIds, trackIds, tracks]);

  useEffect(() => {
    return startLanePlayheadLoop(
      () => laneGeoRef.current.values(),
      () => useStore.getState().transport.position,
      () => rangeRef.current,
    );
  }, []);

  if (tracks.length === 0)
    return <div ref={rootRef} className="ol-lanes" data-testid="v3-lanes"><div className="ol-empty" data-testid="v3-empty">No tracks yet — ask Moshi to start something.</div></div>;

  return (
    <div ref={rootRef} className="ol-lanes" data-testid="v3-lanes">
      {tracks.map((track, i) => {
        const hue = trackHue(track.index);
        const focused = focusIdx === i;
        const expanded = expandedIds.has(track.id);
        return (
          <div key={track.id}
            className={`ol-lane${focused ? " focus" : ""}${track.mute ? " muted" : ""}${selectedTrackId === track.id ? " selected" : ""}`}
            style={{ ["--hue" as string]: hue, height: layout.heightsPx[i] }}
            data-expanded={expanded}
            data-testid={`v3-lane-${track.id}`}
            onPointerDown={() => { setFocusIdx(i); setSelectedTrack(track.id); }}>
            <div className="ol-lhead">
              <span className="ol-grip" title="Drag to reorder" aria-hidden>⠿</span>
              <span className="ol-nm">{track.name || "Track"}</span>
              <span className="ol-lctl">
                <button className="ol-cbtn m" data-on={Boolean(track.mute)} title="Mute" aria-pressed={Boolean(track.mute)}
                  onClick={(e) => { e.stopPropagation(); void exec("set_track_mute", { trackId: track.id, mute: !track.mute }); }}>M</button>
                <button className="ol-cbtn s" data-on={Boolean(track.solo)} title="Solo" aria-pressed={Boolean(track.solo)}
                  onClick={(e) => { e.stopPropagation(); void exec("set_track_solo", { trackId: track.id, solo: !track.solo }); }}>S</button>
              </span>
            </div>
            <div className="ol-ed" data-track-id={track.id}>
              <LaneSurface track={track} snapshot={snapshot} hue={hue} range={range} expanded={expanded} />
            </div>
            {expanded && <LanePlayhead trackId={track.id} register={registerPlayhead} />}
          </div>
        );
      })}
    </div>
  );
}
