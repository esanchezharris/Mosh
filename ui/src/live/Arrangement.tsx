// The live arrangement (SPEC §1/§5/§6/§8) — Live's signature layout: the track
// headers sit on the RIGHT of the lanes, and the lanes scroll horizontally under a
// fixed header strip. Reuses, never forks: ClipView (clip anatomy, gestures, drag
// commit/revert, context menu), BarRuler (seek/scrub/shift-range), the shared canvas
// clip renderers, and addTrackOfKind — all re-skinned by live.css under .live-shell.
//
// Gestures resolve through the ACTIVE gesture table (liveGestureTable) — the "live"
// template pins it to "ableton", so clip-header drag moves, body drag time-selects,
// edge drag trims, double-click opens the editor (sets the store's editingClipId,
// which the detail dock reacts to). Nothing here hardcodes a DAW.
//
// v1 gaps (deliberate, SPEC §10): no mixer strip, no clip marquee lasso
// (empty-lane drag paints Live's time selection instead — SPEC §8), the ruler
// loop-brace is a readout only. See docs/live-clone/PARITY.md for the full audit.

import { Fragment, useCallback, useRef, useState } from "react";
import { useStore } from "../store";
import { useShell } from "../v2/shellState";
import { ClipView } from "../v2/lanes/ClipView";
import { LiveRuler } from "./LiveRuler";
import { LoopBrace } from "./LoopBrace";
import { meterOf, contentSeconds } from "../v2/timeline/geom";
import { addTrackOfKind, TRACK_KINDS } from "../v2/lanes/TrackLaneList";
import { barSeconds, beatSeconds } from "../time";
import { EditorAction as EA } from "../interaction/actions";
import { resolveGesture } from "../interaction/gestures";
import { liveGestureTable } from "../interaction/config";
import { muteButtonState } from "../ui/muteState";
import { SAMPLE_DND_MIME } from "../ui/sampleBrowserUtil";
import { MoshMenu, MoshMenuItem } from "../chrome/Menu";
import { IconPlus } from "../ui/icons";
import { useLive } from "./liveState";
import { LiveClipMenu, type LiveClipMenuState } from "./LiveClipMenu";
import { clampLaneHeight, LANE_DEFAULT, LANE_COMPACT_MAX, LANE_MIN, LANE_MAX } from "./laneGeometry";
import { TrackHeaderMenu, type TrackMenuState } from "./TrackHeaderMenu";
import { applyArrangementZoom, recordZoom } from "./zoomHistory";
import { TrackIoSection } from "./TrackIoSection";
import { TakeLanes, TAKE_ROW_H } from "./TakeLanes";
import { takeLanesLayout } from "./takeLanesLayout";
import type { Snapshot, Track } from "../types";

export function Arrangement({ snapshot, dragging }: { snapshot: Snapshot; dragging?: boolean }) {
  const pxPerSec = useStore((s) => s.pxPerSec);
  const clearSelection = useStore((s) => s.clearSelection);
  const select = useStore((s) => s.select);
  const exec = useStore((s) => s.exec);
  const refresh = useStore((s) => s.refresh);
  const snapTime = useStore((s) => s.snapTime);
  const timeRange = useShell((s) => s.timeRange);
  const setTimeRange = useShell((s) => s.setTimeRange);
  const openPianoRoll = useStore((s) => s.openPianoRoll);
  // Per-lane heights (WIDGETS §1: the header-column divider drags one lane at a
  // time, 17–443pt, default 86 — session state, liveState).
  const laneHeights = useLive((s) => s.laneHeights);
  const laneH = (trackId: string) => laneHeights[trackId] ?? LANE_DEFAULT;
  // ⌘R inline rename (the key resolution lives in useLiveKeys; this is the surface).
  const renamingClipId = useLive((s) => s.renamingClipId);
  const setRenamingClip = useLive((s) => s.setRenamingClip);
  const renameCancel = useRef(false);
  const commitRename = (clipId: string, prevName: string, value: string) => {
    setRenamingClip(null);
    const name = value.trim();
    // An emptied field keeps the old name (same snap-back rule as the v2 inspector's
    // track rename) — a clip with no name is worse than a cancelled rename.
    if (renameCancel.current || !name || name === prevName) return;
    void exec("rename_clip", { clipId, name });
  };

  // The same arrangement filter v2 uses: group folders and aux/return carriers hold
  // no clips and belong to the mixer surface, not the lane list.
  const tracks = snapshot.tracks.filter((t) => !t.isGroup && !t.isReturn);
  const contentW = contentSeconds(snapshot) * pxPerSec;
  const beatPx = beatSeconds(meterOf(snapshot)) * pxPerSec;
  const barPx = beatPx * meterOf(snapshot).num;
  // Take lanes (Live 12): per-track expand/collapse, UI-local (not a setting).
  // Default EXPANDED — Live shows the lanes the moment a comp exists; a track
  // without takes renders nothing at all (zero visual change). The layout is
  // computed once per track and shared by the lanes pane (the sub-lane rows)
  // and the headers pane (the matching extra header height).
  const [takesCollapsed, setTakesCollapsed] = useState<Record<string, boolean>>({});
  const takeLayouts = new Map(tracks.map((t) => [t.id, takeLanesLayout(t.clips)]));
  const takeRowsOpen = (t: Track) => (takeLayouts.get(t.id)?.rows ?? 0) > 0 && !takesCollapsed[t.id];
  const takeExtraH = (t: Track) => (takeRowsOpen(t) ? (takeLayouts.get(t.id)?.rows ?? 0) * TAKE_ROW_H : 0);
  // The clip being renamed, resolved against the visible lanes (below the tracks
  // filter, which is why this can't live with the subscriptions above).
  const renaming = renamingClipId
    ? (() => {
        for (const t of tracks) {
          const clip = t.clips.find((c) => c.id === renamingClipId);
          if (clip) return { trackId: t.id, clip };
        }
        return null;
      })()
    : null;

  // The two ruler strips and the RIGHT header column are separate overflow:hidden panes
  // synced to the lanes' scroll — the lanes own BOTH scrollbars (so they sit at the
  // viewport's bottom/right edge, reachable without scrolling to them), and the
  // ruler/header panes follow by scrollLeft / translateY.
  const lanesScrollRef = useRef<HTMLDivElement>(null);
  const rulerClipRef = useRef<HTMLDivElement>(null);
  const timeRulerClipRef = useRef<HTMLDivElement>(null);
  const headersInnerRef = useRef<HTMLDivElement>(null);
  const syncPanes = useCallback(() => {
    const sc = lanesScrollRef.current;
    if (!sc) return;
    if (rulerClipRef.current) rulerClipRef.current.scrollLeft = sc.scrollLeft;
    if (timeRulerClipRef.current) timeRulerClipRef.current.scrollLeft = sc.scrollLeft;
    if (headersInnerRef.current)
      headersInnerRef.current.style.transform = `translateY(${-sc.scrollTop}px)`;
  }, []);

  // The ruler's vertical drag-zoom (LiveRuler): set the zoom, then re-anchor the
  // scroll so the time under the drag point stays put. setPxPerSec owns the clamp;
  // scrollLeft applies the CLAMPED value, or the anchor would drift at the extremes.
  const onRulerZoom = useCallback((anchorSec: number, anchorOffsetX: number, nextPps: number) => {
    recordZoom();   // Live's zoom history: the burst-start view (coalesced per drag)
    const sc = lanesScrollRef.current;
    if (sc) applyArrangementZoom(sc, nextPps, (applied) => anchorSec * applied - anchorOffsetX);
  }, []);

  // Empty-lane pointer (SPEC §8): click resolves the table's "empty"/click rule
  // (DESELECT under every preset); a DRAG paints Live's time selection — the live
  // shell ships no lasso, so the table's empty-drag action (MARQUEE) maps onto the
  // shared timeRange span, the same one a ruler shift-drag and a clip-body drag
  // write. ClipView stopPropagation()s its own presses, so this only ever fires on
  // lane background.
  const emptyDrag = useRef<{ pointerId: number; anchorSec: number; moved: boolean } | null>(null);
  const secAt = (e: { clientX: number; currentTarget: EventTarget & Element }, snap: boolean) => {
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const raw = Math.max(0, (e.clientX - rect.left) / pxPerSec);
    return snap ? snapTime(raw) : raw;
  };
  const onEmptyDown = (e: React.PointerEvent) => {
    if (e.button !== 0) return;
    const mods = { shift: e.shiftKey, alt: e.altKey, meta: e.metaKey || e.ctrlKey };
    const table = liveGestureTable();
    const clickAction = resolveGesture(table, { region: "empty", gesture: "click", mods });
    // Mark BEFORE the deselect (selectionFollow.ts): if this press turns into a
    // time-selection DRAG, the selection-clear must NOT close the clip view. The
    // click case closes explicitly in onEmptyUp — Live closes the view on deselect,
    // never on a time-selection paint.
    useLive.getState().setEmptyDragInFlight(true);
    if (clickAction === EA.DESELECT) {
      clearSelection();
      if (useShell.getState().timeRange) setTimeRange(null);
    }
    const dragAction = resolveGesture(table, { region: "empty", gesture: "drag", mods });
    if (dragAction !== EA.MARQUEE && dragAction !== EA.TIME_SELECT) return;
    const anchorSec = secAt(e, !e.altKey);
    emptyDrag.current = { pointerId: e.pointerId, anchorSec, moved: false };
    setTimeRange({ start: anchorSec, end: anchorSec });
    try { e.currentTarget.setPointerCapture(e.pointerId); } catch { /* no-op */ }
  };
  const onEmptyMove = (e: React.PointerEvent) => {
    const d = emptyDrag.current;
    if (!d || d.pointerId !== e.pointerId) return;
    const cur = secAt(e, !e.altKey);
    if (!d.moved) d.moved = true;
    setTimeRange({ start: Math.min(d.anchorSec, cur), end: Math.max(d.anchorSec, cur) });
  };
  const onEmptyUp = (e: React.PointerEvent) => {
    const d = emptyDrag.current;
    useLive.getState().setEmptyDragInFlight(false);
    if (!d || d.pointerId !== e.pointerId) return;
    emptyDrag.current = null;
    try { e.currentTarget.releasePointerCapture(e.pointerId); } catch { /* no-op */ }
    if (!d.moved) {
      // A press with no real travel is a CLICK. The selection was cleared at
      // pointer-down and the follow-sync was suppressed for exactly this case:
      // deselecting closes the clip view (Live's rule), a drag does not.
      // The pointer-down also wrote a COLLAPSED span {t,t} for the drag that never
      // came — clear it here, or every empty click leaves a 1px ghost band forever
      // (the real-span clear below only runs when the pointer actually moved).
      const r0 = useShell.getState().timeRange;
      if (r0 && r0.end - r0.start < 1e-6) setTimeRange(null);
      const st = useStore.getState();
      if (st.editingClipId && !st.selection.has(st.editingClipId)) st.closePianoRoll();
      return;
    }
    const r = useShell.getState().timeRange;
    if (r && r.end - r.start < 1e-6) setTimeRange(null);
  };
  const onEmptyCancel = (e: React.PointerEvent) => {
    // A cancelled gesture is neither click nor drag: dispose without any
    // deselect/close side-effect.
    useLive.getState().setEmptyDragInFlight(false);
    const d = emptyDrag.current;
    if (!d || d.pointerId !== e.pointerId) return;
    emptyDrag.current = null;
    try { e.currentTarget.releasePointerCapture(e.pointerId); } catch { /* no-op */ }
    const r = useShell.getState().timeRange;
    if (r && r.end - r.start < 1e-6) setTimeRange(null);
  };

  // Empty-lane double-click (ableton table: CREATE_CLIP) — Live's "make a clip and
  // open its editor" in one gesture. The clip lands at the snapped pointer position,
  // one bar long; clips keep their own dblclick (OPEN), so this bails on clip hits.
  // The lane is resolved by its rendered bounding box, not e.target: the empty-drag's
  // pointer capture retargets the dblclick event to the lanes container, so a
  // target-based closest() finds no [data-track-id]. Bounding boxes also keep
  // resized lanes and intervening take rows from being misrouted as a uniform stack.
  const onEmptyDblClick = (e: React.MouseEvent) => {
    if ((e.target as HTMLElement).closest(".v2-clip")) return;
    const mods = { shift: e.shiftKey, alt: e.altKey, meta: e.metaKey || e.ctrlKey };
    const action = resolveGesture(liveGestureTable(), { region: "empty", gesture: "dblclick", mods });
    if (action !== EA.CREATE_CLIP) return;
    const lanesEl = e.currentTarget as HTMLElement;
    const lane = Array.from(lanesEl.querySelectorAll<HTMLElement>("[data-testid='live-lane']"))
      .find((el) => {
        const box = el.getBoundingClientRect();
        return e.clientY >= box.top && e.clientY < box.bottom;
      });
    const track = tracks.find((t) => t.id === lane?.dataset.trackId);
    // An ordinary audio lane has no sound-producing MIDI path. Bass is an audio
    // track too, but its isInstrument marker makes it MIDI-capable; drum tracks
    // are always eligible because add_midi_clip supplies their sampler if needed.
    if (!track || (!track.isInstrument && track.type !== "drum")) return;
    const rect = lanesEl.getBoundingClientRect();
    const start = snapTime(Math.max(0, (e.clientX - rect.left) / pxPerSec));
    const length = barSeconds(meterOf(snapshot));
    void (async () => {
      const res = await exec("add_midi_clip", { trackId: track.id, start, length });
      await refresh();
      const clipId = (res.data as { clipId?: string } | undefined)?.clipId;
      if (res.ok && clipId) openPianoRoll(clipId);
    })();
  };

  const onLaneDrop = (track: Track) => (e: React.DragEvent) => {
    const file = e.dataTransfer.getData(SAMPLE_DND_MIME);
    if (!file) return;
    e.preventDefault();
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const start = snapTime(Math.max(0, (e.clientX - rect.left) / pxPerSec));
    void exec("import_clip", { file, trackId: track.id, startSeconds: start }).then(() => refresh());
  };

  // Live's clip context menu (SPEC §8). Intercepted in CAPTURE phase: the shared
  // ClipView's own menu (the v2 inventory) stopPropagation-ed out of THIS shell.
  // Right-click inside the multi-selection keeps it; outside it, re-selects — Live's
  // rule, and it is what makes Consolidate act on the right clip set.
  const [clipMenu, setClipMenu] = useState<LiveClipMenuState | null>(null);
  const onClipContextCapture = (e: React.MouseEvent) => {
    const clipEl = (e.target as HTMLElement).closest("[data-clip-id]") as HTMLElement | null;
    if (!clipEl) return;   // empty ground: no menu (matches Live)
    e.preventDefault();
    e.stopPropagation();
    const clipId = clipEl.dataset.clipId!;
    if (!useStore.getState().selection.has(clipId)) select([clipId], false);
    const laneEl = clipEl.closest("[data-track-id]") as HTMLElement | null;
    const rect = (laneEl ?? e.currentTarget as HTMLElement).getBoundingClientRect();
    const raw = Math.max(0, (e.clientX - rect.left) / pxPerSec);
    const time = e.altKey ? raw : snapTime(raw);
    setClipMenu({ x: e.clientX, y: e.clientY, clipId, time });
  };

  return (
    <div className="live-arr" data-testid="live-arrangement">
      {/* ruler row — bar numbers over the lanes; a corner cell caps the header column */}
      <div className="live-ruler-row">
        <div className="live-ruler-clip" ref={rulerClipRef}>
          <div className="live-ruler-inner" style={{ width: contentW }}>
            <LiveRuler snapshot={snapshot} width={contentW} onZoom={onRulerZoom} />
            <LoopBrace snapshot={snapshot} />
          </div>
        </div>
        <div className="live-ruler-corner" aria-hidden="true" />
      </div>

      {/* lanes (left, owning both scrollbars) + headers (RIGHT, synced pane) */}
      <div className="live-arr-body">
        <div className="live-lanes-scroll" ref={lanesScrollRef} onScroll={syncPanes} data-testid="live-timeline">
          <div
            className="live-lanes"
            style={{ width: contentW }}
            onPointerDown={onEmptyDown}
            onPointerMove={onEmptyMove}
            onPointerUp={onEmptyUp}
            onPointerCancel={onEmptyCancel}
            onDoubleClick={onEmptyDblClick}
            onContextMenuCapture={onClipContextCapture}
          >
            {tracks.length === 0 && (
              <div className="live-empty live-empty-arrangement" role="status" aria-live="polite">
                <span>No tracks yet — add one to start.</span>
                <AddTrackButton variant="empty" />
              </div>
            )}
            {tracks.map((t) => (
              <Fragment key={t.id}>
              <div
                className={`live-lane${t.frozen ? " frozen" : ""}`}
                data-testid="live-lane"
                data-track-id={t.id}
                data-frozen={t.frozen === true}
                style={{
                  height: laneH(t.id),
                  "--beat-px": `${beatPx}px`,
                  "--bar-px": `${barPx}px`,
                  // Clip bodies + name strips read this (live.css); absent ⇒ per-kind defaults.
                  ...(t.color ? { "--track-col": t.color } : {}),
                } as React.CSSProperties}
                onDragOver={(e) => { if (e.dataTransfer.types.includes(SAMPLE_DND_MIME)) { e.preventDefault(); e.dataTransfer.dropEffect = "copy"; } }}
                onDrop={onLaneDrop(t)}
              >
                {t.clips.filter((c) => !c.hidden).map((c) => (
                  <ClipView key={c.id} clip={c} trackType={t.type} snapshot={snapshot} />
                ))}
                {/* ⌘R inline rename — an input over the clip's name strip, in the lane's
                    own coordinate space so it scrolls with the clip. */}
                {renaming && renaming.trackId === t.id && (
                  <input
                    className="live-rename"
                    data-testid="live-rename"
                    aria-label={`Rename clip ${renaming.clip.name}`}
                    style={{
                      left: renaming.clip.start * pxPerSec,
                      width: Math.max(90, renaming.clip.length * pxPerSec),
                    }}
                    defaultValue={renaming.clip.name}
                    autoFocus
                    onFocus={(e) => e.target.select()}
                    onPointerDown={(e) => e.stopPropagation()}
                    onKeyDown={(e) => {
                      e.stopPropagation();
                      if (e.key === "Enter") e.currentTarget.blur();
                      if (e.key === "Escape") { renameCancel.current = true; e.currentTarget.blur(); }
                    }}
                    onBlur={(e) => {
                      commitRename(renaming.clip.id, renaming.clip.name, e.target.value);
                      renameCancel.current = false;
                    }}
                  />
                )}
              </div>
              {/* Live 12 take lanes — sub-lanes under this track's lane, one row per
                  take index, while the track's lanes are expanded (default). */}
              {takeRowsOpen(t) && <TakeLanes track={t} layout={takeLayouts.get(t.id)!} />}
              </Fragment>
            ))}
            {/* The body time-selection (ableton table: clip-body drag) writes the
                shared shellState range — paint it across the lanes so the gesture is
                visible. Cleared by an empty-lane click; action toolbar is Phase 3. */}
            {timeRange && (
              <div
                className="live-timerange"
                data-testid="live-timerange"
                style={{ left: timeRange.start * pxPerSec, width: Math.max(1, (timeRange.end - timeRange.start) * pxPerSec) }}
              />
            )}
            <LivePlayhead />
          </div>
        </div>
        {clipMenu && <LiveClipMenu menu={clipMenu} onClose={() => setClipMenu(null)} />}

        <div className="live-headers" data-testid="live-headers">
          <div className="live-headers-inner" ref={headersInnerRef}>
            {tracks.map((t, i) => (
              <TrackHeader key={t.id} track={t} index={i} height={laneH(t.id) + takeExtraH(t)}
                takeRows={takeLayouts.get(t.id)?.rows ?? 0}
                takesOpen={takeRowsOpen(t)}
                onToggleTakes={() => setTakesCollapsed((m) => ({ ...m, [t.id]: !m[t.id] }))} />
            ))}
            {tracks.length > 0 && <AddTrackButton variant="row" />}
          </div>
        </div>
      </div>

      {/* Live's second ruler sits below the lanes: elapsed time, not bar numbers.
          It follows the same horizontal viewport and owns the same anchored zoom. */}
      <div className="live-time-ruler-row">
        <div className="live-time-ruler-clip" ref={timeRulerClipRef} data-testid="live-time-ruler-clip">
          <div className="live-time-ruler-inner" style={{ width: contentW }}>
            <LiveRuler snapshot={snapshot} width={contentW} onZoom={onRulerZoom} variant="time" />
          </div>
        </div>
        <div className="live-time-ruler-corner" aria-hidden="true">1/1</div>
      </div>

      {dragging && (
        <div className="live-drop" role="status" aria-live="polite" data-testid="live-drop">
          <span>Drop audio to import</span>
        </div>
      )}
    </div>
  );
}

// The playhead — own implementation rather than v2's Playhead, whose headW() offset
// reads a v2 token that doesn't exist in this shell (v2 headers stick LEFT; ours sit
// in a fixed RIGHT column, so the offset here is simply 0).
function LivePlayhead() {
  const pos = useStore((s) => s.transport.position);
  const pxPerSec = useStore((s) => s.pxPerSec);
  return <div className="live-playhead" data-testid="live-playhead" style={{ left: pos * pxPerSec }} />;
}

// A RIGHT-side track header (SPEC §5 + WIDGETS §1/§2): number box (accent orange,
// dark number), colour chip + name, M / S / arm, monitor tri-state, and the I/O grid
// (TrackIoSection — real routing popups + vol/pan). The
// header's bottom edge is the LANE-HEIGHT divider (drag: 17–443pt, one lane at a
// time; at ≤40pt the header collapses to its top row, Live's collapsed-at-min).
// Right-click opens the header context menu (WIDGETS §2 ctx-header).
function TrackHeader({ track, index, height, takeRows = 0, takesOpen = false, onToggleTakes }: {
  track: Track; index: number; height: number;
  /** Live 12 take lanes: rows available on this track (0 = no comp), whether the
   *  lanes are expanded, and the toggle. The header's extra height already matches
   *  the lanes pane's sub-lane rows (Arrangement computes both). */
  takeRows?: number; takesOpen?: boolean; onToggleTakes?: () => void;
}) {
  const exec = useStore((s) => s.exec);
  const selectedTrackId = useStore((s) => s.selectedTrackId);
  const setSelectedTrack = useStore((s) => s.setSelectedTrack);
  const clearSelection = useStore((s) => s.clearSelection);
  // The 30Hz mute-automation rail, NOT the snapshot — same subscription as v2's header.
  const muteAutomation = useStore((s) => s.muteAutomation);
  const mute = muteButtonState(track, muteAutomation, "m");
  const sel = selectedTrackId === track.id;
  const monitor = track.monitor ?? "automatic";
  const compact = height <= LANE_COMPACT_MAX;
  const setLaneHeight = useLive((s) => s.setLaneHeight);
  const renamingTrackId = useLive((s) => s.renamingTrackId);
  const setRenamingTrack = useLive((s) => s.setRenamingTrack);
  const setDevicesHidden = useLive((s) => s.setDevicesHidden);
  const [menu, setMenu] = useState<TrackMenuState | null>(null);
  const laneDrag = useRef<{ pointerId: number; startY: number; startH: number } | null>(null);

  const selectTrack = () => {
    clearSelection();
    setSelectedTrack(track.id);
    setDevicesHidden(false);
  };
  const setMonitor = (mode: "on" | "automatic" | "off") =>
    void exec("set_input_monitor", { trackId: track.id, mode });

  return (
    <div
      className={`live-thead${sel ? " sel" : ""}${compact ? " compact" : ""}${track.frozen ? " frozen" : ""}`}
      style={{ height }}
      data-testid="live-track-header"
      data-track-id={track.id}
      data-selected={sel}
      data-frozen={track.frozen === true}
      role="group"
      aria-label={`${track.name} track`}
      onContextMenu={(e) => {
        e.preventDefault();
        e.stopPropagation();
        setMenu({ x: e.clientX, y: e.clientY, trackId: track.id });
      }}
    >
      <div className="live-thead-top">
        <span className="live-tcolor" style={{ background: track.color ?? "var(--live-text-dim)" }} aria-hidden="true" />
        {renamingTrackId === track.id ? (
          <input
            className="live-tname-input"
            data-testid="live-track-rename"
            aria-label={`Rename track ${track.name}`}
            defaultValue={track.name}
            autoFocus
            onFocus={(e) => e.target.select()}
            onKeyDown={(e) => {
              e.stopPropagation();
              if (e.key === "Enter") e.currentTarget.blur();
              if (e.key === "Escape") { e.currentTarget.value = track.name; e.currentTarget.blur(); }
            }}
            onBlur={(e) => {
              setRenamingTrack(null);
              const name = e.target.value.trim();
              if (name && name !== track.name) void exec("rename_track", { trackId: track.id, name });
            }}
          />
        ) : (
          <button
            type="button"
            className="live-tname"
            aria-label={`Select track ${track.name}`}
            aria-pressed={sel}
            title={track.name}
            onClick={selectTrack}
          >{track.name}</button>
        )}
        {/* the number box — accent orange, dark number, right-of-name (12.4.2 headers) */}
        <span className="live-tnum" aria-hidden="true">{index + 1}</span>
      </div>
      {!compact && (
        <>
          <div className="live-thead-row">
            <span className="live-tms">
              <button
                className={`m${mute.pressed ? " on" : ""}${mute.automated ? " automated" : ""}`}
                aria-label={mute.label} aria-pressed={mute.pressed} title={mute.label}
                onClick={(e) => { e.stopPropagation(); void exec("set_track_mute", { trackId: track.id, mute: !track.mute }); }}
              >M</button>
              <button
                className={`s${track.solo ? " on" : ""}`}
                aria-label="Solo" aria-pressed={!!track.solo} title="Solo"
                onClick={(e) => { e.stopPropagation(); void exec("set_track_solo", { trackId: track.id, solo: !track.solo }); }}
              >S</button>
              <button
                className={`r${track.armed ? " on" : ""}`}
                data-testid="live-track-arm"
                aria-label={`Record-arm ${track.name}`} aria-pressed={!!track.armed}
                title="Record-arm: route live input here so it can be recorded or captured"
                onClick={(e) => { e.stopPropagation(); void exec("arm_track", { trackId: track.id, armed: !track.armed }); }}
              >●</button>
            </span>
            {/* monitor tri-state (In·Auto·Off) — active = accent, per SPEC §5 */}
            <span className="live-tmon" role="group" aria-label={`Monitor ${track.name}`}>
              {([["on", "In"], ["automatic", "Auto"], ["off", "Off"]] as const).map(([mode, label]) => (
                <button
                  key={mode}
                  className={monitor === mode ? "on" : ""}
                  aria-pressed={monitor === mode}
                  title={`Monitor ${label}`}
                  onClick={(e) => { e.stopPropagation(); setMonitor(mode); }}
                >{label}</button>
              ))}
            </span>
          </div>
          {/* I/O grid — real engine-backed routing popups + monitor trio + vol/pan
              (per-channel pickers honestly disabled until the engine grows them). */}
          <TrackIoSection track={track} />
        </>
      )}
      {/* the lane-height divider (WIDGETS §1: drag between two headers, 17–443pt) */}
      <div
        className="live-lane-resize"
        data-testid="live-lane-resize"
        role="separator"
        aria-orientation="horizontal"
        aria-label={`Resize the ${track.name} lane`}
        aria-valuenow={height}
        aria-valuemin={LANE_MIN}
        aria-valuemax={LANE_MAX}
        tabIndex={0}
        title="Drag to resize this lane (↑/↓ also work)"
        onPointerDown={(e) => {
          laneDrag.current = { pointerId: e.pointerId, startY: e.clientY, startH: height };
          try { e.currentTarget.setPointerCapture(e.pointerId); } catch { /* no-op */ }
          e.stopPropagation();
        }}
        onPointerMove={(e) => {
          const d = laneDrag.current;
          if (!d || d.pointerId !== e.pointerId) return;
          setLaneHeight(track.id, clampLaneHeight(d.startH + (e.clientY - d.startY)));
        }}
        onPointerUp={(e) => {
          laneDrag.current = null;
          try { e.currentTarget.releasePointerCapture(e.pointerId); } catch { /* no-op */ }
        }}
        onKeyDown={(e) => {
          const delta = e.key === "ArrowDown" ? 8 : e.key === "ArrowUp" ? -8 : 0;
          if (delta === 0) return;
          e.preventDefault();
          e.stopPropagation();
          setLaneHeight(track.id, clampLaneHeight(height + delta));
        }}
      />
      {takeRows > 0 && (
        <button
          type="button"
          className="live-take-toggle"
          data-testid="live-take-toggle"
          aria-expanded={takesOpen}
          title={takesOpen ? "Collapse this track's take lanes" : "Expand this track's take lanes"}
          onClick={(e) => { e.stopPropagation(); onToggleTakes?.(); }}
        >
          {takesOpen ? "▾" : "▸"} {takeRows} take{takeRows === 1 ? "" : "s"}
        </button>
      )}
      {menu && <TrackHeaderMenu menu={menu} onClose={() => setMenu(null)} />}
    </div>
  );
}

// Add-track, reusing v2's kind menu (audio / drums / instrument / tone) and its
// command sequence verbatim — a new kind of track must behave identically in every
// shell, so there is exactly one addTrackOfKind.
function AddTrackButton({ variant }: { variant: "empty" | "row" }) {
  const exec = useStore((s) => s.exec);
  return (
    <MoshMenu
      label="Add track"
      align="start"
      trigger={
        <button
          className={variant === "empty" ? "live-add-empty" : "live-add-row"}
          data-testid="live-track-add"
          title="Add a track"
          onPointerDown={(e) => e.stopPropagation()}
        >
          <IconPlus size={12} />
          <span>Add track</span>
        </button>
      }
    >
      <div className="live-menu" role="menu" onPointerDown={(e) => e.stopPropagation()}>
        {TRACK_KINDS.map(({ kind, label, hint }) => (
          <MoshMenuItem
            key={kind}
            ariaLabel={`${label} track — ${hint}`}
            testId={`live-track-add-${kind}`}
            onPick={() => void addTrackOfKind(kind, exec)}
          >
            <span className="live-menu-label">{label}</span>
            <span className="live-menu-hint">{hint}</span>
          </MoshMenuItem>
        ))}
      </div>
    </MoshMenu>
  );
}
