// A single clip on a lane, rendered by type: wave (peak canvas), midi (note bars),
// drum (step blocks), or a generic block. Drag = move, edge-drag = trim, double-click
// MIDI = open piano-roll, right-click = context menu (split/duplicate/convert/remove).
//
// The interaction is the SHARED layer — region classify + gesture resolve + optimistic
// preview + commit-with-revert — reused verbatim from the classic shell so the math
// (snap, drag threshold, trim offset, rejection revert) is identical. v2 pins the
// gesture table to "mosh" (single design, no skin axis) and has no modal tool, so split
// lives in the context menu instead of a split-tool click. Selection routes through the
// store (so multiplayer broadcast/lock-claim still fire).

import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { expandLoopedNotes } from "../../midi/midiLoop";
import { createPortal } from "react-dom";
import { useStore } from "../../store";
import { useSettings } from "../../settings/store";
import { useShell } from "../shellState";
import { beatSeconds } from "../../time";
import { meterOf } from "../timeline/geom";
import { EditorAction as EA, type Mods } from "../../interaction/actions";
import { resolveGesture, type GestureTable } from "../../interaction/gestures";
import { selectSimilarIds } from "./selectSimilar";
import { classifyClipRegion } from "../../interaction/region";
import { liveFeel, liveGestureTable } from "../../interaction/config";
import { passedDragThreshold, isDoubleClick } from "../../interaction/feel";
import { commitClipDrag, type DragPos } from "../../ui/clipDrag";
import { pushEscapeHandler } from "../../hooks/escapeStack";
// Reuse the proven canvas renderers so drum clips show a true fixed-lane step grid +
// MIDI shows note blocks (identical to the classic shell), not sparse dots. These live
// in their own module (not classic's Arrange.tsx) so importing them does not pull the
// classic arrangement view into the v2 module graph.
import { ClipWave, ClipMidi, ClipDrumGrid, isDrumClip } from "../../ui/clipRenderers";
import type { Clip, Snapshot } from "../../types";
import { AI_SETUP_HINT, transcriptionMenuEnabled } from "../../capabilities";
// AGT-MEM (M4, item 3) — "Save pattern to memory": reads the clip's own notes into
// pattern-string shape, builds a DrumPatternCard, and writes it as an explicit global
// memory item (the confirm toast is the SAME M3 v2-memory-toast surface the "remember"
// fastPath already uses, with the same true-Undo-via-delete affordance).
import { drumPatternFromNotes } from "../../ui/drumPatternUtil";
import { buildDrumPatternCard } from "../../agent/memory/patternCards";
import { saveDrumPatternCard } from "../../agent/memory/savePatternCard";

const MIN_LEN = 0.05; // shortest clip / trim, seconds

// v2 now honours the user's "Mouse gestures" setting (settings/schema.ts `gestureTable`).
// It used to hardcode `getGestureTable("mosh")` with the comment "v2 = single Mosh
// interaction model", which made a user-visible DAW picker do NOTHING in the shipped
// shell while the sibling `keymap` setting WAS honoured — an asymmetry that read as a
// defect, not a design. The reason it was hardcoded is that Ableton's and Pro Tools'
// tables address `clip.header` / `clip.body`, and v2 passed `headerPx: 0` so
// classifyClipRegion could never return `clip.header`: switching the table alone would
// have produced a clip whose top strip did nothing. Both halves land together here.
const TABLE = () => liveGestureTable();

// The draggable title strip, in px — same value the classic shell uses. Only applied
// when the ACTIVE table actually distinguishes header from body; under Mosh/FL/Logic
// (whole-clip rules) it stays 0, so those users get no invisible 18px dead zone and no
// decorative bar that does not change what a drag does.
const CLIP_HEADER_PX = 18;
const tableHasHeader = (t: ReturnType<typeof liveGestureTable>) =>
  t.some((r) => r.region === "clip.header");

const modsOf = (e: { shiftKey?: boolean; altKey?: boolean; metaKey?: boolean; ctrlKey?: boolean }): Mods =>
  ({ shift: !!e.shiftKey, alt: !!e.altKey, meta: !!(e.metaKey || e.ctrlKey) });
const capturePointer = (el: Element, id: number) => { try { (el as HTMLElement).setPointerCapture(id); } catch { /* no-op */ } };
const releasePointer = (el: Element, id: number) => { try { (el as HTMLElement).releasePointerCapture(id); } catch { /* no-op */ } };

type DragKind = "move" | "trim-l" | "trim-r" | "stretch" | "time";

export function ClipView({ clip, trackType, snapshot, clipHeaderPx, clipVisualHeaderPx,
  gestureTable, waveAmplitudeAt, midiVerticalZoom, linkedClipIds, clipGroupId, clipGroupName }: {
  clip: Clip; trackType: string; snapshot: Snapshot;
  clipHeaderPx?: number; clipVisualHeaderPx?: number;
  gestureTable?: () => GestureTable;
  waveAmplitudeAt?: (ratio: number) => number;
  midiVerticalZoom?: number;
  linkedClipIds?: readonly string[];
  clipGroupId?: string;
  clipGroupName?: string;
}) {
  const pxPerSec = useStore((s) => s.pxPerSec);
  const selection = useStore((s) => s.selection);
  const select = useStore((s) => s.select);
  const exec = useStore((s) => s.exec);
  const tool = useStore((s) => s.tool);
  const snapTime = useStore((s) => s.snapTime);
  // CAP-CLP-017 — the modal ripple toggle (top bar). Read here rather than inside
  // commitClipDrag so that helper stays store-free and unit-testable.
  const ripple = useStore((s) => s.ripple);
  const openPianoRoll = useStore((s) => s.openPianoRoll);
  const transportPosition = useStore((s) => s.transport.position);
  const setSelectedClip = useShell((s) => s.setSelectedClip);

  const ensurePeaks = useStore((s) => s.ensurePeaks);
  const peaks = useStore((s) => s.peaks[clip.id]);
  // In-flight status for the three clip-menu AI actions below (transcode/lyrics/flow) —
  // v2 had zero visual feedback for any of these (the classic shell's "transcribing…"
  // badge is classic-only); a guest-degradation gap since these actions error/hang
  // silently otherwise. transcribing/buildingLyrics/buildingSkeleton are keyed by the
  // source clip id and cleared on done/error by the store's event handlers.
  const transcribing = useStore((s) => !!s.transcribing[clip.id]);
  const buildingLyrics = useStore((s) => !!s.buildingLyrics[clip.id]);
  const buildingSkeleton = useStore((s) => !!s.buildingSkeleton[clip.id]);
  const pxToSec = (px: number) => px / pxPerSec;
  const secToPx = (s: number) => s * pxPerSec;
  const bs = beatSeconds(meterOf(snapshot)); // seconds per beat (renderers map beats→px)
  // MIDI clip looping: expand the notes into originals + dimmed ghost repeats
  // (Live's striped repeat rendering) whenever the clip carries loop fields.
  const shownNotes = useMemo(
    () => expandLoopedNotes(
      clip.notes ?? [],
      bs > 0 ? clip.length / bs : 0,
      clip.midiLoopStartBeats ?? 0,
      clip.midiLoopLengthBeats ?? 0,
    ),
    [clip.notes, clip.length, clip.midiLoopStartBeats, clip.midiLoopLengthBeats, bs],
  );
  // clip.sourceFile is a dep so an in-place repoint (re-imagine / relink) re-fetches the waveform.
  useEffect(() => { if (clip.type === "wave") ensurePeaks(clip.id); }, [clip.id, clip.type, clip.sourceFile, ensurePeaks]);

  // Optimistic preview during a drag; cleared when the committed props arrive.
  const [preview, setPreview] = useState<DragPos | null>(null);
  const drag = useRef<{ kind: DragKind; startX: number; startY: number; engaged: boolean; anchorSec: number; orig: DragPos; projectEpoch: number } | null>(null);
  const lastUp = useRef<number | null>(null);
  const clipRef = useRef<HTMLDivElement>(null);
  const [menu, setMenu] = useState<{ x: number; y: number; time: number; splitLabel: string } | null>(null);
  useEffect(() => { setPreview(null); }, [clip.start, clip.length, clip.offset]);

  // L3 (EDGECASE_SWEEP_V2_2026-07-18) — abandon an interrupted drag. Without this, a
  // pointercancel (system gesture, alt-tab, palm rejection) or an Escape mid-drag
  // left drag.current armed and the optimistic preview frozen at a position that was
  // never committed. While a drag is armed it also holds the TOP of the shared
  // Escape stack, so Esc cancels the gesture instead of closing an overlay beneath.
  const escDispose = useRef<(() => void) | null>(null);
  const cancelDrag = () => {
    const timeSelection = drag.current?.kind === "time";
    drag.current = null;
    setPreview(null);
    if (timeSelection) {
      useShell.getState().setTimeRangeDragging(false);
      useShell.getState().setTimeRange(null);
    }
    escDispose.current?.();
    escDispose.current = null;
  };
  useEffect(() => () => {
    if (drag.current?.kind === "time") {
      useShell.getState().setTimeRangeDragging(false);
      useShell.getState().setTimeRange(null);
    }
    drag.current = null;
    escDispose.current?.();
    escDispose.current = null;
  }, []);

  const pos: DragPos = preview ?? { start: clip.start, length: clip.length, offset: clip.offset };
  const left = pos.start * pxPerSec;
  const width = Math.max(4, pos.length * pxPerSec);
  const selectableClipIds = linkedClipIds?.length ? linkedClipIds : [clip.id];
  const selected = selectableClipIds.some((clipId) => selection.has(clipId));
  // Drum vs melodic by the clip's own pitches (GM percussion), with the drum track as a
  // fallback for an empty/ambiguous clip — matches the legacy detection.
  const drumClip = clip.type === "midi" && (isDrumClip(clip.notes) || trackType === "drum");
  const kind = clip.type === "wave" ? "wave" : clip.type === "midi" ? (drumClip ? "drum" : "midi") : "block";

  const selectClip = (additive: boolean) => {
    select([...selectableClipIds], additive);
    setSelectedClip(clip.id);
  };
  const closeMenu = (restoreFocus: boolean) => {
    setMenu(null);
    if (restoreFocus) window.setTimeout(() => clipRef.current?.focus(), 0);
  };
  const openKeyboardMenu = () => {
    const rect = clipRef.current?.getBoundingClientRect();
    const playheadInside = transportPosition > clip.start && transportPosition < clip.start + clip.length;
    const rawTime = playheadInside ? transportPosition : clip.start + clip.length / 2;
    const snappedTime = snapTime(rawTime);
    const splitTime = snappedTime > clip.start && snappedTime < clip.start + clip.length ? snappedTime : rawTime;
    setMenu({
      x: (rect?.left ?? 0) + Math.min(24, (rect?.width ?? 0) / 2),
      y: (rect?.top ?? 0) + Math.min(24, (rect?.height ?? 0) / 2),
      time: splitTime,
      splitLabel: playheadInside ? "Split at playhead" : "Split at clip midpoint",
    });
  };
  const edgeGrab = liveFeel().edgeGrabPx;
  const activeTable = gestureTable ?? TABLE;

  // 0 unless the ACTIVE table has clip.header rules — see CLIP_HEADER_PX.
  const headerPx = () => Number.isFinite(clipHeaderPx)
    ? Math.max(0, clipHeaderPx!)
    : (tableHasHeader(activeTable()) ? CLIP_HEADER_PX : 0);

  const regionOf = (e: React.PointerEvent | React.MouseEvent) => {
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const localX = e.clientX - rect.left, localY = e.clientY - rect.top;
    const edgePx = liveFeel().edgeGrabPx;
    const region = classifyClipRegion({
      x: localX, y: localY, width: rect.width, height: rect.height,
      edgeGrabPx: edgePx, headerPx: headerPx(),
    });
    return { region, localX, edgePx };
  };

  const onDown = (e: React.PointerEvent) => {
    e.stopPropagation();
    if (e.button !== 0) return; // right-click handled by onContextMenu
    const { region, localX, edgePx } = regionOf(e);
    const mods = modsOf(e);
    const clickAction = resolveGesture(activeTable(), { region, gesture: "click", mods, tool });
    const dragAction = resolveGesture(activeTable(), { region, gesture: "drag", mods, tool });
    if (clickAction === EA.SELECT) selectClip(false);
    else if (clickAction === EA.ADDITIVE_SELECT) selectClip(true);
    let dk: DragKind | null = null;
    if (dragAction === EA.MOVE) dk = "move";
    else if (dragAction === EA.TIME_SELECT) dk = "time";
    else if (dragAction === EA.TRIM) dk = localX <= edgePx ? "trim-l" : "trim-r";
    // ⌘+edge-drag on a wave clip time-stretches (warp) from the RIGHT edge; the left
    // edge and non-wave clips fall back to trimming (no source audio to stretch).
    else if (dragAction === EA.STRETCH)
      dk = clip.type === "wave" && localX > edgePx ? "stretch" : localX <= edgePx ? "trim-l" : "trim-r";
    if (!dk) return;
    capturePointer(e.target as HTMLElement, e.pointerId);
    // A time-selection drag measures from the SECOND the pointer went down, not from the
    // clip's start: the range a producer draws across a clip body has nothing to do with
    // where that clip begins.
    const anchorSec = snapTime(Math.max(0, clip.start + localX / pxPerSec));
    drag.current = {
      kind: dk, startX: e.clientX, startY: e.clientY, engaged: false, anchorSec,
      orig: { start: clip.start, length: clip.length, offset: clip.offset },
      projectEpoch: useStore.getState().projectEpoch,
    };
    escDispose.current?.();
    escDispose.current = pushEscapeHandler(cancelDrag);
  };

  const onMove = (e: React.PointerEvent) => {
    const d = drag.current; if (!d) return;
    const dx = e.clientX - d.startX, dy = e.clientY - d.startY;
    const threshold = liveFeel().dragThreshold;
    if (!d.engaged) {
      if (!passedDragThreshold(dx, dy, threshold)) return;
      d.engaged = true;
      if (d.kind === "time") useShell.getState().setTimeRangeDragging(true);
    }
    // TIME SELECTION across the clip body (Ableton / Pro Tools). It paints the shared
    // range band instead of a clip preview, so it returns before every rule below —
    // those are all about previewing a moved/trimmed clip, which this gesture never does.
    // The band lives in shellState, not the classic store: writing to useStore.timeRange
    // sets a value v2 renders nowhere (the mistake the marquee wave already paid for).
    if (d.kind === "time") {
      const cur = (e.altKey ? (x: number) => x : snapTime)(Math.max(0, d.anchorSec + pxToSec(dx)));
      useShell.getState().setTimeRange({
        start: Math.min(d.anchorSec, cur),
        end: Math.max(d.anchorSec, cur),
      });
      return;
    }
    // Every OTHER clip-drag kind writes only the TIME axis (a clip cannot be dragged to
    // another lane — the commit never sends trackId), so once the gesture has
    // engaged, vertical travel must not move the clip in time. Clearing the preview
    // rather than leaving it unwritten also makes "drag it out and put it back"
    // commit nothing, instead of releasing with the abandoned position still set.
    // Without this an off-grid clip — a pushed hit, a hand-placed sample — was
    // silently straightened to the grid by a drag that never really travelled.
    if (Math.abs(dx) <= threshold) { setPreview(null); return; }
    const delta = pxToSec(dx), o = d.orig;
    // Option is the temporary, gesture-local snap bypass. Read it on every move so
    // the producer can press or release the modifier while already dragging; the
    // shared snap toggle/division remains unchanged for the next edit.
    const gestureTime = (raw: number) => e.altKey ? raw : snapTime(raw);
    if (d.kind === "move") {
      setPreview({ ...o, start: Math.max(0, gestureTime(o.start + delta)) });
    } else if (d.kind === "trim-r" || d.kind === "stretch") {
      // Both drag the right edge to a new length; the commit differs (trim vs warp).
      const end = gestureTime(o.start + o.length + delta);
      setPreview({ ...o, length: Math.max(MIN_LEN, end - o.start) });
    } else {
      const start = Math.max(0, Math.min(o.start + o.length - MIN_LEN, gestureTime(o.start + delta)));
      const used = start - o.start;
      setPreview({ start, length: o.length - used, offset: Math.max(0, o.offset + used) });
    }
  };

  const onUp = (e: React.PointerEvent) => {
    const d = drag.current; drag.current = null;
    escDispose.current?.();
    escDispose.current = null;
    releasePointer(e.target as HTMLElement, e.pointerId);
    if (d && d.engaged) {
      lastUp.current = null;
      if (d.kind === "time") {
        useShell.getState().setTimeRangeDragging(false);
        if (useStore.getState().projectEpoch !== d.projectEpoch) {
          useShell.getState().setTimeRange(null);
          return;
        }
        // Nothing to commit: a range is UI-local state, and delete/loop act on it from
        // the band's own toolbar. Drop a zero-width range so a stray drag leaves nothing.
        const r = useShell.getState().timeRange;
        if (r && r.end - r.start < 1e-6) useShell.getState().setTimeRange(null);
        return;
      }
      if (useStore.getState().projectEpoch !== d.projectEpoch) {
        setPreview(null);
        return;
      }
      commitClipDrag(d.kind, preview, d.orig.start, clip.id, exec, setPreview, ripple);
      return;
    }
    // A non-left button's release (right-click → context menu, middle-click) must NOT
    // feed the double-click-to-open detector below — onDown already ignores it
    // (`e.button !== 0` bails before engaging a drag), so drag.current is null here
    // exactly like a genuine left click's pointerup, and without this guard a
    // right-click's own release masqueraded as a normal click for double-click timing
    // purposes: right-click (sets lastUp) then the context menu's OWN click handler
    // reaching back here on close could pair up within doubleClickMs and pop the piano
    // roll open as a surprising side effect of opening the context menu.
    if (e.button !== 0) return;
    // pure click → manual double-click detection (feel.doubleClickMs) → open editor
    const now = performance.now();
    if (isDoubleClick(lastUp.current, now, liveFeel().doubleClickMs)) {
      lastUp.current = null;
      const { region } = regionOf(e);
      const action = resolveGesture(activeTable(), { region, gesture: "dblclick", mods: modsOf(e), tool });
      if (action === EA.OPEN && (clip.type === "midi" || clip.type === "wave")) openPianoRoll(clip.id);
    } else {
      lastUp.current = now;
    }
  };

  const onCancel = (e: React.PointerEvent) => {
    releasePointer(e.target as HTMLElement, e.pointerId);
    cancelDrag();
  };

  const onContext = (e: React.MouseEvent) => {
    const { region, localX } = regionOf(e);
    const action = resolveGesture(activeTable(), { region, gesture: "contextmenu", mods: modsOf(e), tool });
    if (action !== EA.CONTEXT_MENU) return;
    e.preventDefault();
    selectClip(false);
    const rawTime = clip.start + pxToSec(localX);
    setMenu({ x: e.clientX, y: e.clientY, time: e.altKey ? rawTime : snapTime(rawTime), splitLabel: "Split here" });
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.target !== e.currentTarget) return;
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      e.stopPropagation();
      selectClip(e.shiftKey);
      return;
    }
    if (e.key === "ContextMenu" || (e.key === "F10" && e.shiftKey)) {
      e.preventDefault();
      e.stopPropagation();
      selectClip(false);
      openKeyboardMenu();
    }
  };

  return (
    <div
      ref={clipRef}
      // `hdr` draws the title strip as a real, visible drag handle. Only when the active
      // table distinguishes header from body — otherwise it would be a decorative bar
      // that does not change what a drag does, which is the kind of surface this whole
      // programme exists to remove. Under Ableton/Pro Tools it is the ONLY place a clip
      // can be grabbed to move, so it has to be visible.
      className={`v2-clip ${kind}${selected ? " sel" : ""}${clipGroupId ? " pt-clip-group-member" : ""}${clip.type === "wave" && clip.autoTempo ? " warped" : ""}${headerPx() > 0 ? " hdr" : ""}`}
      style={{ left, width, "--v2-clip-hdr": `${clipVisualHeaderPx ?? headerPx()}px` } as React.CSSProperties}
      onPointerDown={onDown} onPointerMove={onMove} onPointerUp={onUp} onPointerCancel={onCancel} onContextMenu={onContext}
      onKeyDown={onKeyDown}
      role="button" tabIndex={0}
      aria-label={`${clip.name} ${kind} clip${clipGroupName ? `, member of ${clipGroupName}` : ""}`}
      aria-pressed={selected}
      aria-haspopup="menu" aria-expanded={menu !== null}
      data-testid="v2-clip" data-clip-id={clip.id} data-clip-group-id={clipGroupId} title={clip.name}
    >
      {clip.type === "wave" && <ClipWave peaks={peaks} width={width} amplitudeAt={waveAmplitudeAt} />}
      {clip.type === "midi" && (drumClip
        ? <ClipDrumGrid notes={shownNotes} width={width} bs={bs} secToPx={secToPx}
            verticalZoom={midiVerticalZoom} />
        : <ClipMidi notes={shownNotes} width={width} bs={bs} secToPx={secToPx}
            verticalZoom={midiVerticalZoom} />)}
      <span className="v2-clip-label">{clip.name}</span>
      {clipGroupName && (
        <span className="v2-clip-badge pt-clip-group-badge" aria-hidden="true"
          title={`Clip Group: ${clipGroupName}`}>grp</span>
      )}
      {clip.renderLayer?.reimagineActive && (
        <span className="v2-clip-badge reimagine" data-testid="v2-clip-reimagine"
          title="A re-imagined render is playing beneath this clip; the MIDI is muted but still editable. Reset in the generative drawer to restore it.">✨</span>
      )}
      {clip.type === "wave" && clip.autoTempo && (
        <span className="v2-clip-badge warp" data-testid="v2-clip-warp"
          title="Warped — this clip time-stretches to follow the project tempo. ⌘-drag the edge or use the Warp tab.">≈</span>
      )}
      {transcribing && <span className="v2-clip-badge working" role="status" aria-live="polite" data-testid="clip-transcribing">transcribing…</span>}
      {buildingLyrics && <span className="v2-clip-badge working" role="status" aria-live="polite" data-testid="clip-building-lyrics">lyrics…</span>}
      {buildingSkeleton && <span className="v2-clip-badge working" role="status" aria-live="polite" data-testid="clip-building-skeleton">flow…</span>}
      {/* edge cursor affordance — pointerdown bubbles up to the clip handler, which
          classifies the edge by position (move tool trims). */}
      <div className="v2-trim l" style={{ width: edgeGrab }} />
      <div className="v2-trim r" style={{ width: edgeGrab }} />
      {menu && (
        <ClipMenu clip={clip} x={menu.x} y={menu.y} time={menu.time} splitLabel={menu.splitLabel} onClose={closeMenu}
          drumClip={drumClip} beatsPerBar={meterOf(snapshot).num}
          linkedClipIds={selectableClipIds} />
      )}
    </div>
  );
}

function ClipMenu({ clip, x, y, time, splitLabel, onClose, drumClip, beatsPerBar, linkedClipIds }: {
  clip: Clip; x: number; y: number; time: number; splitLabel: string; onClose: (restoreFocus: boolean) => void;
  drumClip: boolean; beatsPerBar: number; linkedClipIds: readonly string[];
}) {
  const exec = useStore((s) => s.exec);
  const setMemoryToast = useStore((s) => s.setMemoryToast);
  const memoryOn = useSettings((s) => s.get("agentMemory") !== false);
  // Guest degradation: these three actions all ultimately need Basic Pitch (transcribe)
  // to detect notes — on a Mac without the per-feature venvs they used to fail
  // cryptically. Stay VISIBLE (progressive disclosure — discoverable, not hidden) but
  // disabled with a tooltip naming the fix.
  const aiReady = useStore((s) => transcriptionMenuEnabled(s.capabilities));
  const aiHint = aiReady ? undefined : AI_SETUP_HINT;
  const loadCapabilities = useStore((s) => s.loadCapabilities);
  const menuRef = useRef<HTMLDivElement>(null);
  // LAZY, on first menu open only — never at app init (that would synchronously spawn
  // the generative service and freeze the message thread on every launch; see
  // store.ts's init()). A guest opening this menu before ever visiting the generative
  // drawer briefly sees the AI actions enabled until this resolves, then corrects.
  useEffect(() => { loadCapabilities(); }, [loadCapabilities]);
  useLayoutEffect(() => {
    menuRef.current?.querySelector<HTMLButtonElement>('button[role="menuitem"]:not(:disabled)')?.focus();
  }, []);
  useEffect(() => {
    const close = () => onClose(false);
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(true); };
    const t = window.setTimeout(() => { window.addEventListener("pointerdown", close); window.addEventListener("keydown", onKey); }, 0);
    return () => { window.clearTimeout(t); window.removeEventListener("pointerdown", close); window.removeEventListener("keydown", onKey); };
  }, [onClose]);
  const run = (fn: () => void) => { fn(); onClose(true); };
  const onMenuKeyDown = (e: React.KeyboardEvent) => {
    const items = [...(menuRef.current?.querySelectorAll<HTMLButtonElement>('button[role="menuitem"]:not(:disabled)') ?? [])];
    const current = items.indexOf(document.activeElement as HTMLButtonElement);
    let next = -1;
    if (e.key === "ArrowDown") next = (current + 1) % items.length;
    else if (e.key === "ArrowUp") next = (current - 1 + items.length) % items.length;
    else if (e.key === "Home") next = 0;
    else if (e.key === "End") next = items.length - 1;
    else if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      onClose(true);
      return;
    }
    if (next >= 0) {
      e.preventDefault();
      e.stopPropagation();
      items[next]?.focus();
    }
  };
  const savePattern = async () => {
    const parsed = drumPatternFromNotes(clip.notes ?? [], beatsPerBar, 16);
    const card = buildDrumPatternCard(parsed, clip.name || "Drum pattern");
    const res = await saveDrumPatternCard(exec, card);
    if (res.ok) setMemoryToast({ text: `pattern "${card.name}"`, scope: "global", kind: "drum_pattern", ts: res.ts });
  };
  const grouped = linkedClipIds.length > 1;
  const removeTargets = async () => {
    if (!grouped) {
      await exec("remove_clip", { clipId: clip.id });
      return;
    }
    await useStore.getState().runAtomic("remove clip group", async (run) => {
      for (const clipId of linkedClipIds) await run("remove_clip", { clipId });
    });
  };
  return createPortal(
    <div ref={menuRef} className="v2-clipmenu" role="menu" aria-label={`${clip.name} clip actions`}
      data-testid="v2-clip-menu" style={{ left: x, top: y }} onPointerDown={(e) => e.stopPropagation()} onKeyDown={onMenuKeyDown}>
      <button role="menuitem" tabIndex={-1} disabled={grouped}
        title={grouped ? "Ungroup before splitting a Clip Group" : undefined}
        onClick={() => run(() => void exec("split_clip", { clipId: clip.id, time }))}>{splitLabel}</button>
      <button role="menuitem" tabIndex={-1} disabled={grouped}
        title={grouped ? "Ungroup before duplicating a Clip Group" : undefined}
        onClick={() => run(() => void exec("duplicate_clip", { clipId: clip.id }))}>Duplicate</button>
      {/* #554 — select every copy of this loop, project-wide. UI-LOCAL: selection never
          crosses the seam, so there is no command here and never will be. Keyed on the
          SOURCE file (name only for MIDI, which has none), matching Reaper and Pro Tools.
          Lives beside Duplicate because both answer "act on more than just this one". */}
      <button role="menuitem" tabIndex={-1} data-testid="clip-select-similar"
        onClick={() => run(() => {
          const ids = selectSimilarIds(useStore.getState().snapshot, clip.id);
          useStore.getState().select(ids, false);
        })}>Select similar</button>
      {drumClip && memoryOn && (
        <button role="menuitem" tabIndex={-1} data-testid="clip-save-pattern" onClick={() => run(() => void savePattern())}>
          Save pattern to memory
        </button>
      )}
      {clip.type === "wave" && (
        <button role="menuitem" tabIndex={-1} disabled={!aiReady} title={aiHint}
          onClick={() => run(() => void exec("transcribe_clip", { clipId: clip.id, mode: "mono" }))}>Convert to MIDI</button>
      )}
      {clip.type === "wave" && (
        <button role="menuitem" tabIndex={-1} data-testid="clip-build-lyrics" disabled={!aiReady} title={aiHint}
          onClick={() => run(() => void exec("build_lyrics_from_clip", { clipId: clip.id }))}>Build lyrics from this take</button>
      )}
      {clip.type === "wave" && (
        <button role="menuitem" tabIndex={-1} data-testid="clip-build-flow" disabled={!aiReady} title={aiHint}
          onClick={() => run(() => void exec("build_skeleton_from_clip", { clipId: clip.id }))}>Build flow from this take</button>
      )}
      <div className="v2-clipmenu-sep" />
      <button role="menuitem" tabIndex={-1} className="danger"
        onClick={() => run(() => void removeTargets())}>{grouped ? "Remove Clip Group" : "Remove"}</button>
    </div>,
    document.body,
  );
}
