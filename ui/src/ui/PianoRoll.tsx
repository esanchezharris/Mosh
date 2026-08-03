// Piano-roll MIDI editor (ported from the legacy component into the new UI).
// Opens on a MIDI clip (store.editingClipId). Every edit is a command:
// add_note / set_note (move + resize + velocity) / remove_note / quantize_notes.
// Note positions are in BEATS (the seam stays in musical/seconds terms); the grid
// is derived through time.ts from the clip-local meter.

import { useEffect, useRef, useState } from "react";
import { useStore } from "../store";
import { useSettings } from "../settings/store";
import type { MidiNote } from "../types";
import { meterAt, tempoMapFrom, beatSeconds, snapStepBeats } from "../time";
import { noteName, pitchClass, resolveKey, scaleMask, snapToScale, keyLabel } from "../musicalKey";
import { liveFeel } from "../interaction/config";
import { DrumSequencer } from "./DrumSequencer";
import { centerScrollTopForNotes } from "./pianoRollScroll";
import { gridBeatsFor, rulerStride, zoomAnchored, clampBeatPx } from "./pianoRollGeom";
import { velocityFromFraction } from "./drumGrid";
import { useEscapeStack } from "../hooks/useEscapeToClose";
import { applyNoteEdits, removeNotes, addNotes } from "./noteCommands";
import { moveEdits, resizeEdits, previewFrom, type GestureGeom } from "./pianoRollEdit";
import { marqueeHit, toggleSelection, noteIdentity, reselectByIdentity } from "./pianoRollSelection";

const ROW_H = 15;
const LOW = 36, HIGH = 96;
const isBlack = (p: number) => [1, 3, 6, 8, 10].includes(((p % 12) + 12) % 12);

// "copy" is a move that leaves the originals behind — Ableton's Option-drag. It is latched
// at POINTERDOWN, not read live during the drag, because Option during a move already means
// "bypass snap" and the two must not fight over the same key mid-gesture.
type DragKind = "move" | "resize" | "copy";
type Drag = {
  kind: DragKind;
  anchorI: number;                    // the note actually grabbed
  orig: Map<number, MidiNote>;        // the whole selection, frozen at pointerdown
  startX: number;
  startY: number;
};
type GridDrag = { pointerId: number; x0: number; y0: number; moved: boolean };

export function PianoRoll() {
  const editingClipId = useStore((s) => s.editingClipId);
  const close = useStore((s) => s.closePianoRoll);
  const snapshot = useStore((s) => s.snapshot);
  const exec = useStore((s) => s.exec);
  const snap = useStore((s) => s.snap);
  const snapDivision = useStore((s) => s.snapDivision);
  const scaleLock = useSettings((s) => Boolean(s.get("scaleLock")));

  const clip = snapshot?.tracks.flatMap((t) => t.clips).find((c) => c.id === editingClipId) ?? null;

  const [mode, setMode] = useState<"piano" | "drums">("piano");
  const [selectedNotes, setSelectedNotes] = useState<Set<number>>(() => new Set());
  const [previews, setPreviews] = useState<Map<number, MidiNote>>(() => new Map());
  const [lasso, setLasso] = useState<{ x0: number; y0: number; x1: number; y1: number } | null>(null);
  const [velocityDraft, setVelocityDraft] = useState<number | null>(null);
  // In-flight velocity-lane edits, keyed by note index. The REF is authoritative and the
  // state is only a mirror for rendering: pointerdown/move/up can arrive in one
  // synchronous batch, and React would not have flushed a state update before the commit
  // in pointerup read it back — so a whole drag could commit nothing.
  const [velDrafts, setVelDrafts] = useState<Record<number, number>>({});
  const velDragRef = useRef<{ active: boolean; startX: number; drafts: Map<number, number> }>({ active: false, startX: 0, drafts: new Map() });
  const dragRef = useRef<Drag | null>(null);
  const gridDragRef = useRef<GridDrag | null>(null);
  const previewRef = useRef<Map<number, MidiNote>>(new Map());
  // Declared UP HERE, above the `if (!clip) return null` guard further down, because the
  // effects below call it — and an effect closes over the render that scheduled it. On a
  // render where the clip is momentarily absent (a refresh landing mid-gesture) the guard
  // returns before any later const is initialised, so a helper defined below it would be
  // in the temporal dead zone by the time the effect ran.
  const setPreviewNotes = (m: Map<number, MidiNote>) => { previewRef.current = m; setPreviews(m); };
  const velocityDraftRef = useRef<number | null>(null);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const keysRef = useRef<HTMLDivElement | null>(null);
  const panelRef = useRef<HTMLDivElement | null>(null);
  const rulerRef = useRef<HTMLDivElement | null>(null);
  const velRef = useRef<HTMLDivElement | null>(null);
  const bodyRef = useRef<HTMLDivElement | null>(null);
  const beatPx = useStore((s) => s.pianoRollBeatPx);
  const setBeatPx = useStore((s) => s.setPianoRollBeatPx);

  useEffect(() => { if (editingClipId && !clip) close(); }, [editingClipId, clip, close]);
  useEffect(() => { setMode("piano"); }, [editingClipId]);
  // Move focus into the dialog on open so aria-modal is honest (outside is inert) and
  // keyboard users land inside the editor rather than on the trigger behind the backdrop.
  useEffect(() => { if (editingClipId) panelRef.current?.focus(); }, [editingClipId]);
  // On open (and when returning to Piano from the Drums view), centre the
  // vertical scroll on the clip's notes so off-screen material (e.g. a low
  // bassline near E2/A2) is framed instead of an apparently empty grid scrolled
  // to the top (C7). No-op in Drums mode (the scroll grid isn't mounted) and for
  // empty clips. Keys column is synced to match.
  useEffect(() => {
    if (mode !== "piano") return;
    const sc = scrollRef.current;
    if (!sc) return;
    const top = centerScrollTopForNotes(clip?.notes ?? [], {
      high: HIGH, rowH: ROW_H, clientHeight: sc.clientHeight, scrollHeight: sc.scrollHeight,
    });
    if (top == null) return;
    sc.scrollTop = top;
    if (keysRef.current) keysRef.current.scrollTop = top;
  }, [editingClipId, mode]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    setPreviewNotes(new Map()); setLasso(null); gridDragRef.current = null;
    setSelectedNotes((prev) => {
      const available = new Set((clip?.notes ?? []).map((n) => n.i));
      const next = new Set([...prev].filter((i) => available.has(i)));
      return next.size === prev.size ? prev : next;
    });
  }, [clip?.notes]);
  useEffect(() => { setVelocityDraft(null); velocityDraftRef.current = null; }, [editingClipId, selectedNotes]);

  // Escape goes through the shared stack (AL-001), not a private window listener.
  // This component was the one holdout — every other overlay adopted the stack and
  // cites *this* file as the pattern it mirrors, but the migration never reached it,
  // so with the piano roll under another overlay a single Escape closed both. The
  // stack listens in CAPTURE phase and stopPropagation()s, which is why the
  // Delete/Backspace listener below (bubble phase) is unaffected.
  useEscapeStack(Boolean(editingClipId && clip), close);

  // Keyboard while the piano roll is open: Delete/Backspace removes the SELECTED
  // NOTES (the arrangement's global handler bails when editingClipId is set, so the
  // clip is never deleted here). Removing in descending index order keeps each
  // noteIndex valid as the backend reindexes after every removal.
  useEffect(() => {
    if (!editingClipId || !clip) return;
    const clipId = clip.id;
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement | null;
      if (el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.tagName === "SELECT" || el.isContentEditable)) return;
      if (e.key === "Delete" || e.key === "Backspace") {
        if (selectedNotes.size === 0) return;
        e.preventDefault(); e.stopPropagation();
        void removeNotes(exec, clipId, [...selectedNotes]);
        setSelectedNotes(new Set());
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [editingClipId, clip, selectedNotes, exec, close]);

  // The grid's width came from the CLIP alone, so a short clip left the right third
  // of the panel unpainted: the grid element simply ended before its container did,
  // revealing the panel's own background beside it. Measure the viewport so the grid
  // can be extended to cover it. `min-width: 100%` in CSS handles the first paint,
  // before this has measured (and jsdom, which has no ResizeObserver).
  const [viewportW, setViewportW] = useState(0);
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    setViewportW(el.clientWidth);
    if (typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(() => setViewportW(el.clientWidth));
    ro.observe(el);
    return () => ro.disconnect();
  }, [mode, editingClipId]);

  // Playhead. Transport is a decimated 30Hz event feed kept deliberately OUT of the
  // snapshot, and subscribing to it here would re-render the whole note tree 30 times a
  // second. So: read it imperatively inside a rAF loop and write ONE CSS custom property
  // — the same discipline as Meter.tsx and TrackLaneList's per-track level glow. Geometry
  // travels through a ref (written during render, below) so the effect never re-subscribes.
  const geomRef = useRef({ start: 0, beatSec: 0.5, beatPx: 42, len: 0 });
  useEffect(() => {
    let raf = 0;
    const tick = () => {
      const { position } = useStore.getState().transport;
      const g = geomRef.current;
      const el = bodyRef.current;
      if (el && g.beatSec > 0) {
        const x = ((position - g.start) / g.beatSec) * g.beatPx;
        el.style.setProperty("--pr-play-x", `${x.toFixed(1)}px`);
        // Only show it while the playhead is actually over this clip.
        el.classList.toggle("pr-playing", position >= g.start && position <= g.start + g.len);
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, []);

  if (!editingClipId || !clip) return null;

  const m = meterAt(tempoMapFrom(snapshot?.session), clip.start);
  const stepBeats = snap ? snapStepBeats(m, snapDivision) : 0;
  const snapBeat = (b: number, bypass = false) => (!bypass && stepBeats > 0 ? Math.round(b / stepBeats) * stepBeats : b);
  const pitches = Array.from({ length: HIGH - LOW + 1 }, (_, k) => HIGH - k);
  const gridBeats = gridBeatsFor({
    clipBeats: clip.length / beatSeconds(m),
    beatsPerBar: m.num,
    beatPx,
    viewportW,
  });
  const gridW = gridBeats * beatPx;
  // Feed the playhead loop this render's geometry (see the rAF effect above).
  geomRef.current = { start: clip.start, beatSec: beatSeconds(m), beatPx, len: clip.length };
  const yOf = (pitch: number) => (HIGH - pitch) * ROW_H;
  const pitchAt = (y: number) => HIGH - Math.floor(y / ROW_H);
  // Scale lock (invariant 88) — an INPUT AID, exactly like snap-to-grid above:
  // it constrains the pitch of notes you draw or drag BEFORE the command is sent,
  // so notes you never touched are never rewritten. Off ⇒ this whole block is
  // inert and the roll renders exactly as it did before.
  const songKey = resolveKey(snapshot?.session.key);
  const keyMask = scaleMask(songKey);
  const lockPitch = (pitch: number) => (scaleLock ? snapToScale(pitch, keyMask) : pitch);
  const noteBox = (n: MidiNote) => ({ x: n.start * beatPx, y: yOf(n.pitch) + 1, w: Math.max(6, n.length * beatPx - 1), h: ROW_H - 2 });
  // The gesture arithmetic all lives in pianoRollEdit.ts; this is the geometry it needs.
  // minLengthBeats follows the Option key for the same reason snapping does — Option means
  // "let me off the grid", which has to include the grid's minimum length.
  const gestureGeom = (bypassSnap: boolean): GestureGeom => ({
    beatPx, rowH: ROW_H, dragThreshold: liveFeel().dragThreshold,
    snapBeat, lockPitch,
    minLengthBeats: bypassSnap ? 0.25 : stepBeats || 0.25,
  });

  const notes: MidiNote[] = (clip.notes ?? []).map((n) => {
    const base = previews.get(n.i) ?? n;
    const v = velDrafts[n.i];
    return v == null ? base : { ...base, velocity: v };
  });

  const onGridDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if ((e.target as HTMLElement).closest(".pr-note")) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const x = Math.max(0, e.clientX - rect.left), y = Math.max(0, e.clientY - rect.top);
    gridDragRef.current = { pointerId: e.pointerId, x0: x, y0: y, moved: false };
    try { e.currentTarget.setPointerCapture(e.pointerId); } catch { /* noop */ }
    setSelectedNotes(new Set());
  };
  const onNoteDown = (kind: "move" | "resize", n: MidiNote) => (e: React.PointerEvent) => {
    e.stopPropagation();
    // Shift-click edits the SELECTION and starts no drag — otherwise the same gesture
    // would both extend the selection and immediately begin moving it.
    if (e.shiftKey) { setSelectedNotes(toggleSelection(selectedNotes, n.i, true)); return; }

    // Grabbing a note that is already selected drags the WHOLE selection; grabbing an
    // unselected one selects just it first. (Replacing the selection unconditionally, as
    // this used to, is what made multi-note editing impossible.)
    const sel = selectedNotes.has(n.i) ? selectedNotes : new Set([n.i]);
    if (sel !== selectedNotes) setSelectedNotes(sel);

    const byIndex = new Map((clip.notes ?? []).map((x) => [x.i, x]));
    const orig = new Map<number, MidiNote>();
    for (const i of sel) { const x = byIndex.get(i); if (x) orig.set(i, x); }

    try { (e.target as HTMLElement).setPointerCapture(e.pointerId); } catch { /* noop */ }
    dragRef.current = {
      kind: kind === "move" && e.altKey ? "copy" : kind,
      anchorI: n.i, orig, startX: e.clientX, startY: e.clientY,
    };
  };
  const onGridMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const d = dragRef.current;
    if (d) {
      // The two axes are guarded symmetrically: an axis you did not move is never
      // rewritten (see pianoRollEdit.ts, which owns that rule now). Pitch gets its
      // deadzone for free from rounding to whole rows; TIME is continuous, so it needs an
      // explicit drag threshold — without it a 1px hand-wobble during a vertical drag
      // would re-snap the start, and a deliberately off-grid note (a pushed hit, a swung
      // 16th) must survive a pitch nudge with its timing intact.
      //
      // Option during a COPY drag is the modifier that started the copy, not a snap
      // bypass — reading it as both would make an Option-drag silently off-grid too.
      const bypassSnap = d.kind !== "copy" && e.altKey;
      const input = { orig: d.orig, dxPx: e.clientX - d.startX, dyPx: e.clientY - d.startY, bypassSnap };
      const edits = d.kind === "resize" ? resizeEdits(input, gestureGeom(bypassSnap))
                                        : moveEdits (input, gestureGeom(bypassSnap));
      // Inside the deadzone the preview is CLEARED, not merely left unwritten: dragging
      // out and back to the origin would otherwise release with the abandoned preview
      // still standing and commit the trip anyway.
      setPreviewNotes(previewFrom(d.orig, edits));
      return;
    }
    const gd = gridDragRef.current;
    if (!gd || e.buttons === 0) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const x = Math.max(0, e.clientX - rect.left), y = Math.max(0, e.clientY - rect.top);
    if (Math.hypot(x - gd.x0, y - gd.y0) > 4) gd.moved = true;
    if (gd.moved) setLasso({ x0: gd.x0, y0: gd.y0, x1: x, y1: y });
  };
  const onGridUp = (e: React.PointerEvent<HTMLDivElement>) => {
    const d = dragRef.current;
    if (d) {
      const final = previewRef.current;
      dragRef.current = null; setPreviewNotes(new Map());
      if (final.size === 0) return;

      if (d.kind === "copy") {
        // Option-drag drops a COPY at the new position and leaves the originals alone.
        // The new notes' indices are unknowable ahead of time (MidiList re-sorts on
        // insert), so the selection is re-derived by value once the snapshot lands —
        // otherwise the producer is left with the originals selected, or with indices
        // pointing at whichever notes happen to occupy them now.
        const made = [...final.values()].map((n) => ({ pitch: n.pitch, start: n.start, length: n.length, velocity: n.velocity }));
        const ids = made.map(noteIdentity);
        void (async () => {
          await addNotes(exec, clip.id, made);
          await useStore.getState().refresh();
          const fresh = useStore.getState().snapshot?.tracks.flatMap((t) => t.clips).find((c) => c.id === clip.id)?.notes ?? [];
          setSelectedNotes(reselectByIdentity(fresh, ids));
        })();
        return;
      }

      const edits = [...final.values()].map((n) =>
        d.kind === "resize" ? { i: n.i, length: n.length } : { i: n.i, start: n.start, pitch: n.pitch });
      void applyNoteEdits(exec, clip.id, edits);
      return;
    }
    const gd = gridDragRef.current; if (!gd) return;
    gridDragRef.current = null;
    try { e.currentTarget.releasePointerCapture(gd.pointerId); } catch { /* noop */ }
    const rect = e.currentTarget.getBoundingClientRect();
    const x = Math.max(0, e.clientX - rect.left), y = Math.max(0, e.clientY - rect.top);
    const wasMoved = gd.moved || Math.hypot(x - gd.x0, y - gd.y0) > 4;
    setLasso(null);
    if (!wasMoved) {
      const start = Math.max(0, snapBeat(x / beatPx, e.altKey)), pitch = lockPitch(pitchAt(y)), length = stepBeats > 0 ? stepBeats : 1;
      void exec("add_note", { clipId: clip.id, pitch, start, length, velocity: 100 });
      return;
    }
    // Shift-marquee ADDS to the selection rather than replacing it, so several sweeps can
    // build one selection up (Ableton behaves this way and it is muscle memory).
    const hit = marqueeHit(clip.notes ?? [], { x0: gd.x0, y0: gd.y0, x1: x, y1: y }, noteBox);
    setSelectedNotes(e.shiftKey ? new Set([...selectedNotes, ...hit]) : new Set(hit));
  };
  const onGridCancel = () => { dragRef.current = null; gridDragRef.current = null; setPreviewNotes(new Map()); setLasso(null); };

  // ── velocity lane ──────────────────────────────────────────────────────────
  // Which notes a single drag has touched, and the velocity it last painted on each.
  // The whole gesture commits on release: one set_note per touched note, so an
  // eight-note sweep is one undo step, not eight. (Committing on pointermove would
  // also flood the JSONL command log at frame rate.)
  const velFromEvent = (e: React.PointerEvent<HTMLDivElement>): number => {
    const rect = e.currentTarget.getBoundingClientRect();
    const frac = rect.height > 0 ? 1 - (e.clientY - rect.top) / rect.height : 0;
    return velocityFromFraction(Math.max(0, Math.min(1, frac)));
  };
  const paintVelocity = (e: React.PointerEvent<HTMLDivElement>, indices: number[]) => {
    if (indices.length === 0) return;
    const v = velFromEvent(e);
    for (const i of indices) velDragRef.current.drafts.set(i, v);
    setVelDrafts(Object.fromEntries(velDragRef.current.drafts));
  };
  const noteIndexAt = (target: EventTarget | null): number | null => {
    const bar = (target as HTMLElement | null)?.closest?.(".pr-vel-bar") as HTMLElement | null;
    const raw = bar?.dataset.noteIndex;
    return raw == null ? null : Number(raw);
  };
  const onVelDown = (e: React.PointerEvent<HTMLDivElement>) => {
    const i = noteIndexAt(e.target);
    if (i == null) return;
    try { e.currentTarget.setPointerCapture(e.pointerId); } catch { /* noop */ }
    velDragRef.current = { active: true, startX: e.clientX, drafts: new Map() };
    // Dragging a bar that is part of the current multi-selection edits the whole
    // selection; otherwise it selects and edits just that note.
    const targets = selectedNotes.has(i) && selectedNotes.size > 1 ? [...selectedNotes] : [i];
    if (targets.length === 1) setSelectedNotes(new Set(targets));
    paintVelocity(e, targets);
  };
  const onVelMove = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!velDragRef.current.active || e.buttons === 0) return;
    const touched = [...velDragRef.current.drafts.keys()];
    // Sweep-paint picks up bars the pointer travels ACROSS — so it is gated on horizontal
    // movement. Notes can overlap in time, which means several bars can stack at one x;
    // without this gate a purely vertical drag (the common "set this one note's velocity"
    // gesture) re-samples elementFromPoint at each new height and silently grabs whichever
    // neighbour happened to be on top, editing notes the producer never touched.
    const swept = Math.abs(e.clientX - velDragRef.current.startX) > 2;
    const under = swept ? noteIndexAt(document.elementFromPoint(e.clientX, e.clientY)) : null;
    paintVelocity(e, under != null && !touched.includes(under) ? [...touched, under] : touched);
  };
  const onVelUp = () => {
    const { active, drafts } = velDragRef.current;
    velDragRef.current = { active: false, startX: 0, drafts: new Map() };
    setVelDrafts({});
    if (!active) return;
    const byIndex = new Map((clip.notes ?? []).map((n) => [n.i, n.velocity]));
    // Only the notes whose velocity actually CHANGED, committed on release, through the
    // same seam every other multi-note edit uses — so an eight-note sweep is one undo
    // step rather than eight, and never a flood of no-op commands.
    const edits = [...drafts.entries()]
      .filter(([i, v]) => v != null && v !== byIndex.get(i))
      .map(([i, v]) => ({ i, velocity: v }));
    void applyNoteEdits(exec, clip.id, edits);
  };
  const onVelCancel = () => { velDragRef.current = { active: false, startX: 0, drafts: new Map() }; setVelDrafts({}); };

  const selectedIndex = selectedNotes.values().next().value as number | undefined;
  const selNote = selectedIndex != null ? (clip.notes ?? []).find((n) => n.i === selectedIndex) : undefined;
  const velocityValue = velocityDraft ?? selNote?.velocity ?? 100;
  const setDraftVelocity = (value: number) => { const next = Math.round(Math.min(127, Math.max(1, value))); velocityDraftRef.current = next; setVelocityDraft(next); };
  const commitVelocity = () => {
    if (!selNote) return;
    const next = velocityDraftRef.current;
    if (next == null || next === selNote.velocity) return;
    velocityDraftRef.current = null; setVelocityDraft(null);
    void exec("set_note", { clipId: clip.id, noteIndex: selNote.i, velocity: next });
  };

  return (
    <div className="modal-backdrop" onClick={close}>
      <div className="pr" data-testid="piano-roll" role="dialog" aria-modal="true"
        ref={panelRef} tabIndex={-1} style={{ outline: "none" }}
        aria-label={`${mode === "drums" ? "Drum machine" : "Piano roll"} · ${clip.name}`} onClick={(e) => e.stopPropagation()}>
        <div className="pr-head">
          <strong className="display">{mode === "drums" ? "Drum Machine" : "Piano Roll"} · {clip.name}</strong>
          <span className="pr-meta tc">{(clip.notes ?? []).length} notes · {m.tempo} BPM · {m.num}/{m.den}</span>
          <div className="seg" role="group" aria-label="Editor mode">
            <button className="btn" aria-pressed={mode === "piano"} onClick={() => setMode("piano")}>Piano</button>
            <button className="btn" aria-pressed={mode === "drums"} onClick={() => setMode("drums")}>Drums</button>
          </div>
          <span className="spacer" />
          {mode === "piano" && selNote && (
            <label className="pr-vel" title="Velocity of the selected note">vel
              <input aria-label="Selected note velocity" type="range" min={1} max={127} step={1} value={velocityValue}
                onChange={(e) => setDraftVelocity(Number(e.target.value))} onPointerUp={commitVelocity} onKeyUp={commitVelocity} onBlur={commitVelocity} />
              <span className="tc">{velocityValue}</span>
            </label>
          )}
          {mode === "piano" && (
            <button className="btn" data-testid="pr-scale-lock" aria-pressed={scaleLock}
              onClick={() => useSettings.getState().set("scaleLock", !scaleLock)}
              title={scaleLock
                ? `Scale lock ON — a note you draw, or drag to a new pitch, snaps to ${keyLabel(snapshot?.session.key ?? {})}. Notes you don't move keep their pitch, and so does a note you only slide in time.`
                : `Scale lock OFF — click to snap notes you draw or re-pitch to ${keyLabel(snapshot?.session.key ?? {})} (set the key in the topbar).`}>
              Scale {keyLabel(snapshot?.session.key ?? {})}
            </button>
          )}
          {mode === "piano" && (
            <span className="seg pr-zoom" role="group" aria-label="Zoom">
              <button className="btn" data-testid="pr-zoom-out" aria-label="Zoom out"
                onClick={() => setBeatPx(clampBeatPx(beatPx / 1.25))}>−</button>
              <button className="btn" data-testid="pr-zoom-in" aria-label="Zoom in"
                onClick={() => setBeatPx(clampBeatPx(beatPx * 1.25))}>+</button>
            </span>
          )}
          {mode === "piano" && (
            <button className="btn" onClick={() => exec("quantize_notes", { clipId: clip.id, division: snapStepBeats(m, snapDivision) })}>Quantize {snapDivision === "bar" ? "Bar" : snapDivision}</button>
          )}
          <button className="btn x" onClick={close}>✕</button>
        </div>
        {mode === "drums" ? <DrumSequencer clip={clip} /> : (
        <><div className="pr-body" ref={bodyRef}>
          {/* Ruler. Bar numbers are CLIP-LOCAL (bar 1 = the clip's start), because note
              positions are clip-local beats — session-absolute numbering would disagree
              with the coordinates every other affordance here uses. */}
          <div className="pr-corner" />
          <div className="pr-ruler-vp">
            <div className="pr-ruler" ref={rulerRef} style={{ width: gridW }} role="group" aria-label="Bars"
              onPointerDown={(e) => {
                const rect = e.currentTarget.getBoundingClientRect();
                const beat = Math.max(0, (e.clientX - rect.left) / beatPx);
                void exec("set_transport", { position: clip.start + beat * beatSeconds(m) });
              }}>
              {Array.from({ length: Math.floor(gridBeats / m.num) + 1 }, (_, bar) => (
                <div key={`b${bar}`} className="pr-rtick" style={{ left: bar * m.num * beatPx }}>
                  {bar % rulerStride(m.num * beatPx) === 0 && <span>{bar + 1}</span>}
                </div>
              ))}
              <div className="pr-playhead pr-playhead-head" aria-hidden />
            </div>
          </div>

          <div className="pr-keys-vp" ref={keysRef}>
            <div className="pr-keys">
              {pitches.map((p) => (
                <div key={p} className={`pr-key ${isBlack(p) ? "black" : "white"}`} style={{ height: ROW_H }}>{p % 12 === 0 && <span>{noteName(p)}</span>}</div>
              ))}
            </div>
          </div>
          <div className="pr-scroll" ref={scrollRef} onScroll={(e) => {
            const { scrollTop, scrollLeft } = e.currentTarget;
            // VERTICAL: assign scrollTop, because centerScrollTopForNotes drives the same
            // property on open (pianoRollScroll.ts) and both must agree.
            if (keysRef.current) keysRef.current.scrollTop = scrollTop;
            // HORIZONTAL: translate the content rather than assigning scrollLeft. Each
            // viewport clamps scrollLeft to ITS own max, and .pr-scroll is the only one
            // with a vertical scrollbar — so its client width is narrower and the lanes
            // drift apart at the right-hand end. That is 1px with macOS overlay
            // scrollbars and ~15px with classic Windows ones. A transform cannot clamp.
            const x = `translateX(${-scrollLeft}px)`;
            if (rulerRef.current) rulerRef.current.style.transform = x;
            if (velRef.current) velRef.current.style.transform = x;
          }}
            onWheel={(e) => {
              // Cmd/Ctrl+wheel zooms about the pointer so the note under the cursor
              // stays put; a plain wheel keeps native scrolling.
              if (!e.ctrlKey && !e.metaKey) return;
              e.preventDefault();
              const el = e.currentTarget;
              const anchorX = e.clientX - el.getBoundingClientRect().left;
              const factor = Math.exp(-e.deltaY * 0.0015 * liveFeel().zoomSensitivity);
              const next = zoomAnchored({ beatPx, factor, scrollLeft: el.scrollLeft, anchorX });
              setBeatPx(next.beatPx);
              el.scrollLeft = next.scrollLeft;
            }}>
            <div className="pr-grid" role="group" aria-label="Piano roll grid" style={{ width: gridW, height: pitches.length * ROW_H }}
              onPointerDown={onGridDown} onPointerMove={onGridMove} onPointerUp={onGridUp} onPointerCancel={onGridCancel} onLostPointerCapture={onGridCancel}>
              {pitches.map((p) => {
                // Only shade for the key while the lock is on, so the roll is
                // pixel-identical to before when the feature is off.
                const off = scaleLock && !keyMask[pitchClass(p)];
                const root = scaleLock && pitchClass(p) === songKey.tonic;
                return <div key={`r${p}`} className={`pr-row ${isBlack(p) ? "black" : ""}${off ? " off-key" : ""}${root ? " root" : ""}`} style={{ top: yOf(p), height: ROW_H }} />;
              })}
              {Array.from({ length: gridBeats + 1 }, (_, b) => <div key={`c${b}`} className={`pr-gl ${b % m.num === 0 ? "bar" : ""}`} style={{ left: b * beatPx }} />)}
              {notes.map((n) => {
                const b = noteBox(n);
                return (
                  <div key={n.i} className={`pr-note ${selectedNotes.has(n.i) ? "sel" : ""}`} data-testid="pr-note" role="button"
                    aria-label={`${noteName(n.pitch)} note start ${n.start.toFixed(2)} length ${n.length.toFixed(2)} velocity ${n.velocity}`}
                    style={{ left: b.x, top: b.y, width: b.w, height: b.h }}
                    onPointerDown={onNoteDown("move", n)}
                    onDoubleClick={(e) => { e.preventDefault(); e.stopPropagation(); void exec("remove_note", { clipId: clip.id, noteIndex: n.i }); }}
                    title={`${noteName(n.pitch)} · vel ${n.velocity} · dbl-click to delete`}>
                    <span className="pr-note-grip" role="separator" aria-label={`Resize ${noteName(n.pitch)} note`} onPointerDown={onNoteDown("resize", n)} />
                  </div>
                );
              })}
              {lasso && <div className="pr-lasso" style={{ left: Math.min(lasso.x0, lasso.x1), top: Math.min(lasso.y0, lasso.y1), width: Math.abs(lasso.x1 - lasso.x0), height: Math.abs(lasso.y1 - lasso.y0) }} />}
              <div className="pr-playhead" data-testid="pr-playhead" aria-hidden />
            </div>
          </div>

          {/* Velocity lane. One bar per note, bottom-anchored, same grammar as the drum
              sequencer's velocity graph so the two editors read as one family. Dragging
              updates PREVIEW state only; exactly one set_note per touched note is sent on
              release, so a gesture is one undo step instead of a flood. */}
          <div className="pr-vel-gutter"><span>vel</span></div>
          <div className="pr-vel-vp">
            <div className="pr-vel-lane" ref={velRef} style={{ width: gridW }} data-testid="pr-vel-lane"
              onPointerDown={onVelDown} onPointerMove={onVelMove} onPointerUp={onVelUp}
              onPointerCancel={onVelCancel} onLostPointerCapture={onVelCancel}>
              {notes.map((n) => (
                <div key={n.i} className={`pr-vel-bar ${selectedNotes.has(n.i) ? "sel" : ""}`}
                  data-testid="pr-vel-bar" data-note-index={n.i}
                  title={`${noteName(n.pitch)} · vel ${n.velocity}`}
                  style={{ left: n.start * beatPx, height: `${(n.velocity / 127) * 100}%` }} />
              ))}
            </div>
          </div>
        </div>
        <div className="pr-foot">click to add · drag to move · Option-drag to bypass snap · drag the right edge to resize · drag a velocity bar below · ⌘-scroll to zoom · Esc to close</div></>
        )}
      </div>
    </div>
  );
}
