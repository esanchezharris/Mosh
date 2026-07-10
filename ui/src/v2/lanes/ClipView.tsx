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

import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useStore } from "../../store";
import { useShell } from "../shellState";
import { beatSeconds, meterAt, tempoMapFrom, snapStepBeats, activeGridDivision } from "../../time";
import { meterOf } from "../timeline/geom";
import { EditorAction as EA, type Mods } from "../../interaction/actions";
import { resolveGesture } from "../../interaction/gestures";
import { classifyClipRegion } from "../../interaction/region";
import { getGestureTable } from "../../interaction/gestureTables";
import { liveFeel } from "../../interaction/config";
import { passedDragThreshold, isDoubleClick } from "../../interaction/feel";
import { commitClipDrag, type DragPos } from "../../ui/clipDrag";
// Reuse the proven legacy canvas renderers so drum clips show a true fixed-lane step
// grid + MIDI shows note blocks (identical to the classic shell), not sparse dots.
import { ClipWave, ClipMidi, ClipDrumGrid, isDrumClip } from "../../ui/Arrange";
import type { Clip, Snapshot } from "../../types";

const MIN_LEN = 0.05; // shortest clip / trim, seconds
const TABLE = () => getGestureTable("mosh"); // v2 = single Mosh interaction model

const modsOf = (e: { shiftKey?: boolean; altKey?: boolean; metaKey?: boolean; ctrlKey?: boolean }): Mods =>
  ({ shift: !!e.shiftKey, alt: !!e.altKey, meta: !!(e.metaKey || e.ctrlKey) });
const capturePointer = (el: Element, id: number) => { try { (el as HTMLElement).setPointerCapture(id); } catch { /* no-op */ } };
const releasePointer = (el: Element, id: number) => { try { (el as HTMLElement).releasePointerCapture(id); } catch { /* no-op */ } };

type DragKind = "move" | "trim-l" | "trim-r";

export function ClipView({ clip, trackType, snapshot }: { clip: Clip; trackType: string; snapshot: Snapshot }) {
  const pxPerSec = useStore((s) => s.pxPerSec);
  const selection = useStore((s) => s.selection);
  const select = useStore((s) => s.select);
  const exec = useStore((s) => s.exec);
  const tool = useStore((s) => s.tool);
  const snapTime = useStore((s) => s.snapTime);
  const openPianoRoll = useStore((s) => s.openPianoRoll);
  const setSelectedClip = useShell((s) => s.setSelectedClip);

  const ensurePeaks = useStore((s) => s.ensurePeaks);
  const peaks = useStore((s) => s.peaks[clip.id]);
  const pxToSec = (px: number) => px / pxPerSec;
  const secToPx = (s: number) => s * pxPerSec;
  const bs = beatSeconds(meterOf(snapshot)); // seconds per beat (renderers map beats→px)
  useEffect(() => { if (clip.type === "wave") ensurePeaks(clip.id); }, [clip.id, clip.type, ensurePeaks]);

  // Optimistic preview during a drag; cleared when the committed props arrive.
  const [preview, setPreview] = useState<DragPos | null>(null);
  const drag = useRef<{ kind: DragKind; startX: number; startY: number; engaged: boolean; orig: DragPos } | null>(null);
  const lastUp = useRef<number | null>(null);
  const [menu, setMenu] = useState<{ x: number; y: number; time: number } | null>(null);
  useEffect(() => { setPreview(null); }, [clip.start, clip.length, clip.offset]);

  const pos: DragPos = preview ?? { start: clip.start, length: clip.length, offset: clip.offset };
  const left = pos.start * pxPerSec;
  const width = Math.max(4, pos.length * pxPerSec);
  const selected = selection.has(clip.id);
  // Drum vs melodic by the clip's own pitches (GM percussion), with the drum track as a
  // fallback for an empty/ambiguous clip — matches the legacy detection.
  const drumClip = clip.type === "midi" && (isDrumClip(clip.notes) || trackType === "drum");
  const kind = clip.type === "wave" ? "wave" : clip.type === "midi" ? (drumClip ? "drum" : "midi") : "block";

  const selectClip = (additive: boolean) => { select([clip.id], additive); setSelectedClip(clip.id); };
  const edgeGrab = liveFeel().edgeGrabPx;

  const regionOf = (e: React.PointerEvent | React.MouseEvent) => {
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const localX = e.clientX - rect.left, localY = e.clientY - rect.top;
    const edgePx = liveFeel().edgeGrabPx;
    const region = classifyClipRegion({ x: localX, y: localY, width: rect.width, height: rect.height, edgeGrabPx: edgePx, headerPx: 0 });
    return { region, localX, edgePx };
  };

  const onDown = (e: React.PointerEvent) => {
    e.stopPropagation();
    if (e.button !== 0) return; // right-click handled by onContextMenu
    const { region, localX, edgePx } = regionOf(e);
    const mods = modsOf(e);
    const clickAction = resolveGesture(TABLE(), { region, gesture: "click", mods, tool });
    const dragAction = resolveGesture(TABLE(), { region, gesture: "drag", mods, tool });
    if (clickAction === EA.SELECT) selectClip(false);
    else if (clickAction === EA.ADDITIVE_SELECT) selectClip(true);
    let dk: DragKind | null = null;
    if (dragAction === EA.MOVE) dk = "move";
    else if (dragAction === EA.TRIM) dk = localX <= edgePx ? "trim-l" : "trim-r";
    if (!dk) return;
    capturePointer(e.target as HTMLElement, e.pointerId);
    drag.current = { kind: dk, startX: e.clientX, startY: e.clientY, engaged: false, orig: { start: clip.start, length: clip.length, offset: clip.offset } };
  };

  const onMove = (e: React.PointerEvent) => {
    const d = drag.current; if (!d) return;
    const dx = e.clientX - d.startX, dy = e.clientY - d.startY;
    if (!d.engaged) { if (!passedDragThreshold(dx, dy, liveFeel().dragThreshold)) return; d.engaged = true; }
    const delta = pxToSec(dx), o = d.orig;
    if (d.kind === "move") {
      setPreview({ ...o, start: Math.max(0, snapTime(o.start + delta)) });
    } else if (d.kind === "trim-r") {
      const end = snapTime(o.start + o.length + delta);
      setPreview({ ...o, length: Math.max(MIN_LEN, end - o.start) });
    } else {
      const start = Math.max(0, Math.min(o.start + o.length - MIN_LEN, snapTime(o.start + delta)));
      const used = start - o.start;
      setPreview({ start, length: o.length - used, offset: Math.max(0, o.offset + used) });
    }
  };

  const onUp = (e: React.PointerEvent) => {
    const d = drag.current; drag.current = null;
    releasePointer(e.target as HTMLElement, e.pointerId);
    if (d && d.engaged) {
      lastUp.current = null;
      commitClipDrag(d.kind, preview, d.orig.start, clip.id, exec, setPreview);
      return;
    }
    // pure click → manual double-click detection (feel.doubleClickMs) → open editor
    const now = performance.now();
    if (isDoubleClick(lastUp.current, now, liveFeel().doubleClickMs)) {
      lastUp.current = null;
      const { region } = regionOf(e);
      const action = resolveGesture(TABLE(), { region, gesture: "dblclick", mods: modsOf(e), tool });
      if (action === EA.OPEN && clip.type === "midi") openPianoRoll(clip.id);
    } else {
      lastUp.current = now;
    }
  };

  const onContext = (e: React.MouseEvent) => {
    const { region, localX } = regionOf(e);
    const action = resolveGesture(TABLE(), { region, gesture: "contextmenu", mods: modsOf(e), tool });
    if (action !== EA.CONTEXT_MENU) return;
    e.preventDefault();
    selectClip(false);
    setMenu({ x: e.clientX, y: e.clientY, time: snapTime(clip.start + pxToSec(localX)) });
  };

  return (
    <div
      className={`v2-clip ${kind}${selected ? " sel" : ""}`}
      style={{ left, width }}
      onPointerDown={onDown} onPointerMove={onMove} onPointerUp={onUp} onContextMenu={onContext}
      data-testid="v2-clip" data-clip-id={clip.id} title={clip.name}
    >
      {clip.type === "wave" && <ClipWave peaks={peaks} width={width} />}
      {clip.type === "midi" && (drumClip
        ? <ClipDrumGrid notes={clip.notes} width={width} bs={bs} secToPx={secToPx} />
        : <ClipMidi notes={clip.notes} width={width} bs={bs} secToPx={secToPx} />)}
      <span className="v2-clip-label">{clip.name}</span>
      {clip.renderLayer?.reimagineActive && (
        <span className="v2-clip-badge reimagine" data-testid="v2-clip-reimagine"
          title="A re-imagined render is playing beneath this clip; the MIDI is muted but still editable. Reset in the generative drawer to restore it.">✨</span>
      )}
      {/* edge cursor affordance — pointerdown bubbles up to the clip handler, which
          classifies the edge by position (move tool trims). */}
      <div className="v2-trim l" style={{ width: edgeGrab }} />
      <div className="v2-trim r" style={{ width: edgeGrab }} />
      {menu && <ClipMenu clip={clip} snapshot={snapshot} x={menu.x} y={menu.y} time={menu.time} onClose={() => setMenu(null)} />}
    </div>
  );
}

function ClipMenu({ clip, snapshot, x, y, time, onClose }: { clip: Clip; snapshot: Snapshot; x: number; y: number; time: number; onClose: () => void }) {
  const exec = useStore((s) => s.exec);
  const pxPerSec = useStore((s) => s.pxPerSec);
  const gridMode = useStore((s) => s.gridMode);
  const setGridMode = useStore((s) => s.setGridMode);
  const snapDivision = useStore((s) => s.snapDivision);
  const setSnapDivision = useStore((s) => s.setSnapDivision);
  const m = meterAt(tempoMapFrom(snapshot.session), clip.start);
  const activeDivision = activeGridDivision(m, pxPerSec, gridMode, snapDivision);
  useEffect(() => {
    const close = () => onClose();
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    const t = window.setTimeout(() => { window.addEventListener("pointerdown", close); window.addEventListener("keydown", onKey); }, 0);
    return () => { window.clearTimeout(t); window.removeEventListener("pointerdown", close); window.removeEventListener("keydown", onKey); };
  }, [onClose]);
  const run = (fn: () => void) => { fn(); onClose(); };
  return createPortal(
    <div className="v2-clipmenu" role="menu" data-testid="v2-clip-menu" style={{ left: x, top: y }} onPointerDown={(e) => e.stopPropagation()}>
      <button role="menuitem" onClick={() => run(() => void exec("split_clip", { clipId: clip.id, time }))}>Split here</button>
      <button role="menuitem" onClick={() => run(() => void exec("duplicate_clip", { clipId: clip.id }))}>Duplicate</button>
      {clip.type === "midi" && (
        <>
          <div className="v2-clipmenu-sep" />
          <div className="v2-clipmenu-head">Grid</div>
          <button role="menuitem" aria-pressed={gridMode === "fixed"} onClick={() => run(() => setGridMode("fixed"))}>Fixed grid</button>
          <button role="menuitem" aria-pressed={gridMode === "adaptive"} onClick={() => run(() => setGridMode("adaptive"))}>Adaptive grid</button>
          <div className="v2-clipmenu-grid">
            {(["bar", "1/4", "1/8", "1/8T", "1/16", "1/16T"] as const).map((div) => (
              <button key={div} role="menuitem" aria-pressed={snapDivision === div}
                onClick={() => run(() => { setSnapDivision(div); setGridMode("fixed"); })}>{div}</button>
            ))}
          </div>
          <button role="menuitem" onClick={() => run(() => void exec("quantize_notes", { clipId: clip.id, division: snapStepBeats(m, activeDivision), strength: 1 }))}>
            Quantize current grid
          </button>
        </>
      )}
      {clip.type === "wave" && (
        <button role="menuitem" onClick={() => run(() => void exec("transcribe_clip", { clipId: clip.id, mode: "mono" }))}>Convert to MIDI</button>
      )}
      {clip.type === "wave" && (
        <button role="menuitem" data-testid="clip-build-lyrics"
          onClick={() => run(() => void exec("build_lyrics_from_clip", { clipId: clip.id }))}>Build lyrics from this take</button>
      )}
      {clip.type === "wave" && (
        <button role="menuitem" data-testid="clip-build-flow"
          onClick={() => run(() => void exec("build_skeleton_from_clip", { clipId: clip.id }))}>Build flow from this take</button>
      )}
      <div className="v2-clipmenu-sep" />
      <button role="menuitem" className="danger" onClick={() => run(() => void exec("remove_clip", { clipId: clip.id }))}>Remove</button>
    </div>,
    document.body,
  );
}
