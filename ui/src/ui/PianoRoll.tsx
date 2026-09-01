// Piano-roll MIDI editor (ported from the legacy component into the new UI).
// Opens on a MIDI clip (store.editingClipId). Every edit is a command:
// add_note / set_note (move + resize + velocity) / remove_note / quantize_notes.
// Note positions are in BEATS (the seam stays in musical/seconds terms); the grid
// is derived through time.ts from the clip-local meter.

import { useEffect, useMemo, useRef, useState } from "react";
import { useStore } from "../store";
import { isRealNative } from "../bridge";
import { useSettings } from "../settings/store";
import type { MidiNote } from "../types";
import { meterAt, tempoMapFrom, beatSeconds } from "../time";
import { noteName, pitchClass, resolveKey, scaleMask, snapToScale, keyLabel } from "../musicalKey";
import { liveFeel } from "../interaction/config";
import { DrumSequencer } from "./DrumSequencer";
import { DrumPads } from "./drum/DrumPads";
import { centerScrollTopForNotes } from "./pianoRollScroll";
import { gridBeatsFor, rulerStride, zoomAnchored, clampBeatPx, snapDownBeat } from "./pianoRollGeom";
import { velocityFromFraction } from "./drumGrid";
import { useEscapeStack } from "../hooks/useEscapeToClose";
import { editorKeyFocused } from "../hooks/editorFocus";
import { applyNoteEdits, removeNotes, addNotes, type NewNote, type NoteEdit } from "./noteCommands";
import { moveEdits, resizeEdits, resizeStartEdits, previewFrom, transposeEdits, nudgeEdits, lengthEdits, velocityEdits, toggleActiveEdits, drawNoteSpan, type GestureGeom } from "./pianoRollEdit";
import { expandLoopedNotes } from "../midi/midiLoop";
import { ClipLoopBar } from "../live/ClipLoopBar";
import { marqueeHit, toggleSelection, selectAtPitch, selectAll, invertSelection, stepSelection, noteIdentity, reselectByIdentity } from "./pianoRollSelection";
import { notePreview } from "../audio/notePreview";
import { MoshTip } from "../chrome/Tooltip";
import { wireNotePreview } from "../audio/wireNotePreview";
import { qwertyState, onQwertyChange, setQwertyActive } from "../hooks/useQwertyMidi";
import type { QwertyState } from "../interaction/qwertyMidi";
import { stepReduce, STEP_INITIAL, type StepState } from "./stepRecord";
import { visiblePitches, pitchAxis, PITCH_MIN, PITCH_MAX, type FoldMode } from "./pianoRollView";
import { copyNotes, pasteAt, duplicateAfter, setClipboard, getClipboard } from "./pianoRollClipboard";
import { editorGridProjection, effectiveStepBeats, gridLabel, GRID_DIVISIONS, GRID_DEFAULT, type EditorGrid } from "./pianoRollGrid";
import { PianoRollContextNotes, type PianoRollContextNote } from "./PianoRollContextNotes";
import { pianoRollCursorCss, useNativeEditorCursor, type PianoRollCursor } from "./useNativeEditorCursor";
// Live shell's draw mode (the control-bar pencil, live/liveState.ts). Read here
// rather than passed as a prop so the docked editor and the control bar can't drift;
// the slice defaults false and only the live shell ever toggles it, so the modal
// mounts in classic/v2 are never affected. `docked &&` below is the second gate.
import { useLive } from "../live/liveState";

const ROW_H = 15;
// The roll spans the FULL MIDI range: it used to stop at 36..96, so notes outside that
// existed in the clip but could not be seen or edited. Folding (below) is what keeps 128
// rows navigable.
const LOW = PITCH_MIN, HIGH = PITCH_MAX;
const isBlack = (p: number) => [1, 3, 6, 8, 10].includes(((p % 12) + 12) % 12);

// "copy" is a move that leaves the originals behind — Ableton's Option-drag. It is latched
// at POINTERDOWN, not read live during the drag, because Option during a move already means
// "bypass snap" and the two must not fight over the same key mid-gesture.
type DragKind = "move" | "resize-start" | "resize-end" | "copy";
type NoteHitKind = Exclude<DragKind, "copy">;

export const pianoRollNoteGripWidth = (noteWidth: number): number =>
  Math.min(10, Math.max(1, (noteWidth - 4) / 2));

export const pianoRollNoteHitAtX = (noteWidth: number, localX: number): NoteHitKind => {
  const gripWidth = pianoRollNoteGripWidth(noteWidth);
  if (localX <= gripWidth) return "resize-start";
  if (localX >= noteWidth - gripWidth) return "resize-end";
  return "move";
};

const noteHitAt = (target: EventTarget | null, clientX?: number): NoteHitKind | null => {
  const element = target instanceof Element ? target : null;
  const note = element?.closest<HTMLElement>(".pr-note");
  if (note && clientX != null) {
    const rect = note.getBoundingClientRect();
    if (rect.width > 0)
      return pianoRollNoteHitAtX(rect.width, clientX - rect.left);
  }
  const raw = target instanceof Element
    ? target.closest<HTMLElement>("[data-pr-hit]")?.dataset.prHit
    : undefined;
  return raw === "move" || raw === "resize-start" || raw === "resize-end" ? raw : null;
};

const cursorForNoteHit = (hit: NoteHitKind, active = false): PianoRollCursor =>
  hit === "move" ? (active ? "grabbing" : "grab") : "ew-resize";

type Drag = {
  kind: DragKind;
  anchorI: number;                    // the note actually grabbed
  orig: Map<number, MidiNote>;        // the whole selection, frozen at pointerdown
  startX: number;
  startY: number;
  startScrollLeft: number;
  startScrollTop: number;
  lastX: number;
  lastY: number;
  lastAltKey: boolean;
  moved: boolean;
  collapseOnClick: boolean;
  selectionRevision: number;
  editGeneration: number;
};
type EditGuard = { selectionRevision: number; editGeneration: number };
type GridDrag = { pointerId: number; x0: number; y0: number; moved: boolean };

// `docked` is the live shell's clip-view dock (ui/src/live/DetailDock.tsx): the same
// editor, minus the modal trappings — no backdrop, no close-on-backdrop, no pop-in
// animation (live.css's `.live-shell .pr.docked` owns the paint side). Escape still
// clears editingClipId through the shared escape stack either way, and classic/v2
// mount this with the default (modal) — their behaviour is byte-identical.
// A small numeric field for the tool rows: uncontrolled, commits on Enter/blur.
// Defaults keep the velocity row's 1..127 integer clamp byte-identical; the
// Transform row's fields opt into signed (semitones) or decimal (beats) domains.
function ToolField({ testId, ariaLabel, value, onCommit, min = 1, max = 127, integer = true }: {
  testId: string;
  ariaLabel: string;
  value: number;
  onCommit: (v: number) => void;
  min?: number;
  max?: number;
  integer?: boolean;
}) {
  const commit = (el: HTMLInputElement) => {
    let v = Number(el.value);
    if (Number.isFinite(v)) {
      if (integer) v = Math.round(v);
      onCommit(Math.min(max, Math.max(min, v)));
    }
    else el.value = String(value);
  };
  return (
    <input
      className="pr-veltools-field"
      data-testid={testId}
      aria-label={ariaLabel}
      inputMode="numeric"
      key={value}
      defaultValue={value}
      onKeyDown={(e) => { if (e.key === "Enter") { commit(e.currentTarget); e.currentTarget.blur(); } e.stopPropagation(); }}
      onBlur={(e) => commit(e.currentTarget)}
    />
  );
}

export function PianoRoll({ docked = false, expandControl, contextNotes = [] }: {
  docked?: boolean;
  /** Live's Expanded Clip View (⌥⌘E) — the live shell's docked mount passes this;
   *  the modal mounts (classic/v2) never do, so their header is byte-identical. */
  expandControl?: { expanded: boolean; onToggle: () => void };
  /** Read-only notes from other clips. They never enter the active clip's
   *  selection or command index. */
  contextNotes?: readonly PianoRollContextNote[];
}) {
  const editingClipId = useStore((s) => s.editingClipId);
  const close = useStore((s) => s.closePianoRoll);
  const snapshot = useStore((s) => s.snapshot);
  const exec = useStore((s) => s.exec);
  const snap = useStore((s) => s.snap);
  const scaleLock = useSettings((s) => Boolean(s.get("scaleLock")));
  const notePreviewOn = useSettings((s) => Boolean(s.get("notePreview")));
  // The QWERTY instrument's state lives outside React (a keypress must not re-render the
  // app), so the header subscribes to it explicitly just to draw its readout.
  const [qwerty, setQwerty] = useState<QwertyState>({ ...qwertyState });
  useEffect(() => onQwertyChange(setQwerty), []);
  // The roll must be able to sound notes on its own, without depending on any other
  // feature having been mounted first (see wireNotePreview).
  useEffect(() => { wireNotePreview(); }, []);

  const clip = snapshot?.tracks.flatMap((t) => t.clips).find((c) => c.id === editingClipId) ?? null;

  const [mode, setMode] = useState<"piano" | "drums" | "pads">("piano");
  // View state, all editor-LOCAL: the arrangement's own grid and scroll are untouched by
  // anything here, which is the point of having a separate grid at all.
  const [fold, setFold] = useState<FoldMode>("off");
  const [scaleHighlight, setScaleHighlight] = useState(false);
  // The grid PERSISTS (a producer who works in 1/16 wants it there tomorrow) and lives in
  // settings rather than component state — which also means it is independent of the
  // arrangement's snapDivision by construction, not by discipline.
  const grid: EditorGrid = {
    division: (useSettings((s) => s.get("prGridDivision")) as EditorGrid["division"]) ?? GRID_DEFAULT.division,
    adaptive: Boolean(useSettings((s) => s.get("prGridAdaptive"))),
    triplet: Boolean(useSettings((s) => s.get("prGridTriplet"))),
  };
  const setGrid = (next: EditorGrid | ((g: EditorGrid) => EditorGrid)) => {
    const g = typeof next === "function" ? next(grid) : next;
    const st = useSettings.getState();
    st.set("prGridDivision", g.division);
    st.set("prGridAdaptive", g.adaptive);
    st.set("prGridTriplet", g.triplet);
  };
  // Quantize SWING (CAP-MID-004, #552) — 0..100, 0 = straight. The engine delays every
  // second subdivision of the grid and leaves the on-beats put; 100 is the MPC 75% ceiling
  // (MPC% = 50 + swing/4, so a triplet feel is ~67). Editor-LOCAL and not persisted, for
  // the same reason quantize strength isn't: how much groove a pass should add is a
  // decision about THIS take, not a standing preference like the grid.
  const [swingPct, setSwingPct] = useState(0);
  const swingRef = useRef(0);
  swingRef.current = swingPct;
  const [selectedNotes, setSelectedNotes] = useState<Set<number>>(() => new Set());
  const selectionRevisionRef = useRef(0);
  const editGenerationRef = useRef(0);
  const [previews, setPreviews] = useState<Map<number, MidiNote>>(() => new Map());
  const [lasso, setLasso] = useState<{ x0: number; y0: number; x1: number; y1: number } | null>(null);
  // Live draw mode (pencil): while a draw drag is in flight this is the note it will
  // commit on release, rendered as a ghost. null between gestures and whenever the
  // marquee owns the drag (draw mode off / the modal mounts).
  const [drawGhost, setDrawGhost] = useState<{ start: number; length: number; pitch: number } | null>(null);
  // Always subscribed (rules of hooks); only the docked mount acts on it.
  const liveDraw = useLive((s) => s.drawMode);
  const drawActive = docked && liveDraw;
  const [velocityDraft, setVelocityDraft] = useState<number | null>(null);
  // In-flight velocity-lane edits, keyed by note index. The REF is authoritative and the
  // state is only a mirror for rendering: pointerdown/move/up can arrive in one
  // synchronous batch, and React would not have flushed a state update before the commit
  // in pointerup read it back — so a whole drag could commit nothing.
  const [velDrafts, setVelDrafts] = useState<Record<number, number>>({});
  // Live 12 velocity tool row field state — declared UP HERE, above the
  // `if (!clip) return null` guard (hooks must run on every render, clip or not).
  const [randAmt, setRandAmt] = useState(16);
  const [devAmt, setDevAmt] = useState(16);
  const [rampLo, setRampLo] = useState(1);
  const [rampHi, setRampHi] = useState(127);
  // Live 12 Transform row field state (Humanize amount, Live's 10% default) —
  // same hook-order rule as the velocity fields above.
  const [humAmt, setHumAmt] = useState(10);
  // Set Length (null = follow the current grid step) and Add Interval (Live's
  // fifth default) — the straggler fields of Live's Transform panel cluster.
  const [lenBeats, setLenBeats] = useState<number | null>(null);
  const [intervalSemis, setIntervalSemis] = useState(7);
  // MIDI clip loop ghosts (Live's brace repeats) — same hook-order rule: computed
  // above the clip guard, null-safe; display-only, never part of the edit index map.
  const clipBeatsForLoop = clip ? clip.length / Math.max(1.0e-9, beatSeconds(meterAt(tempoMapFrom(snapshot?.session), clip.start))) : 0;
  const loopGhosts = useMemo(
    () => expandLoopedNotes(
      clip?.notes ?? [],
      clipBeatsForLoop,
      clip?.midiLoopStartBeats ?? 0,
      clip?.midiLoopLengthBeats ?? 0,
    ).filter((n) => n.ghost),
    [clip?.notes, clipBeatsForLoop, clip?.midiLoopStartBeats, clip?.midiLoopLengthBeats],
  );
  const velDragRef = useRef<{ active: boolean; startX: number; drafts: Map<number, number> }>({ active: false, startX: 0, drafts: new Map() });
  const dragRef = useRef<Drag | null>(null);
  const gridDragRef = useRef<GridDrag | null>(null);
  const previewRef = useRef<Map<number, MidiNote>>(new Map());
  const applyNativeCursor = useNativeEditorCursor(Boolean(editingClipId && clip));
  // Declared UP HERE, above the `if (!clip) return null` guard further down, because the
  // effects below call it — and an effect closes over the render that scheduled it. On a
  // render where the clip is momentarily absent (a refresh landing mid-gesture) the guard
  // returns before any later const is initialised, so a helper defined below it would be
  // in the temporal dead zone by the time the effect ran.
  const setPreviewNotes = (m: Map<number, MidiNote>) => { previewRef.current = m; setPreviews(m); };
  // The track that owns the clip being edited — where auditioned notes are heard.
  const owningTrack = snapshot?.tracks.find((t) => t.clips.some((c) => c.id === editingClipId)) ?? null;
  const auditionTrackId = owningTrack?.id ?? null;
  // The pad grid only means anything on a track that hosts a sampler.
  const padTrack = (owningTrack?.drumPads?.length ?? 0) > 0 ? owningTrack : null;
  // Every selection change goes through here so audition is opt-IN per call site. Doing it
  // in a useEffect on selectedNotes instead would also fire on the post-refresh pruning
  // below, re-auditioning the whole selection on every snapshot event.
  const applySelection = (next: Set<number>, opts?: { audition?: boolean }) => {
    selectionRevisionRef.current += 1;
    setSelectedNotes(next);
    if (!opts?.audition || !auditionTrackId) return;
    const byIndex = new Map((clip?.notes ?? []).map((n) => [n.i, n]));
    const pitches = [...new Set([...next].map((i) => byIndex.get(i)?.pitch).filter((p): p is number => p != null))];
    // Cap it: selecting a dense bar should not fire fifty simultaneous notes.
    for (const p of pitches.slice(0, 6)) notePreview.tap(auditionTrackId, p);
  };
  const nextEditGuard = (): EditGuard => ({
    selectionRevision: selectionRevisionRef.current,
    editGeneration: ++editGenerationRef.current,
  });
  const notesForClip = (clipId: string): MidiNote[] =>
    useStore.getState().snapshot?.tracks.flatMap((track) => track.clips)
      .find((candidate) => candidate.id === clipId)?.notes ?? [];
  const reconcileSelection = async (
    clipId: string,
    wanted: readonly ReturnType<typeof noteIdentity>[],
    guard: EditGuard,
  ) => {
    const applyFreshSelection = (): boolean => {
      if (useStore.getState().editingClipId !== clipId
          || selectionRevisionRef.current !== guard.selectionRevision
          || editGenerationRef.current !== guard.editGeneration) return true;
      const selected = reselectByIdentity(notesForClip(clipId), wanted);
      if (selected.size !== wanted.length) return false;
      setSelectedNotes(selected);
      return true;
    };
    if (applyFreshSelection()) return;
    if (!isRealNative()) return;
    await useStore.getState().refresh();
    applyFreshSelection();
  };
  const commitNoteEdits = async (
    clipId: string,
    sourceNotes: readonly MidiNote[],
    edits: readonly NoteEdit[],
    guard: EditGuard,
  ) => {
    const byIndex = new Map(sourceNotes.map((note) => [note.i, note]));
    const wanted = edits.flatMap((edit) => {
      const source = byIndex.get(edit.i);
      return source ? [noteIdentity({ ...source, ...edit })] : [];
    });
    await applyNoteEdits(exec, clipId, edits);
    await reconcileSelection(clipId, wanted, guard);
  };
  const addNotesAndSelect = async (
    clipId: string,
    notes: readonly NewNote[],
    guard: EditGuard,
  ) => {
    await addNotes(exec, clipId, notes);
    await reconcileSelection(clipId, notes.map(noteIdentity), guard);
  };
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
  useEffect(() => { selectionRevisionRef.current += 1; }, [editingClipId]);
  useEffect(() => { setMode("piano"); }, [editingClipId]);
  // Move focus into the dialog on open so aria-modal is honest (outside is inert) and
  // keyboard users land inside the editor rather than on the trigger behind the backdrop.
  // The DOCKED mount skips this: it is not modal, and stealing focus from the clip the
  // user just clicked is how the arrangement lost every focus-scoped key (the
  // editorKeyFocused() gates in useKeyboardShortcuts exist on this rule).
  useEffect(() => { if (editingClipId && !docked) panelRef.current?.focus(); }, [editingClipId, docked]);
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

  // STEP RECORD. The QWERTY layer owns "a key went down"; this owns "and here is where it
  // lands". Keeping the insert marker here rather than in the engine is deliberate — it is
  // view state, and a cursor in the engine would be a second model of "where we are" that
  // has to be synced, persisted, undone and multiplayer-locked.
  //
  // The marker advances only when every held key is released (see stepRecord.ts), which is
  // what makes a chord one beat wide and a sequence N beats long.
  // Read at EVENT time through refs so the listener effect never has to re-subscribe on a
  // grid or toggle change (re-subscribing mid-chord would lose the held set).
  const stepRecordOnRef = useRef(false);
  const stepBeatsRef = useRef(1);
  const stepRef = useRef<StepState>(STEP_INITIAL);
  const insertBeatRef = useRef(0);
  const lockPitchRef = useRef<(p: number) => number>((p) => p);
  // Step record is armed exactly when the computer keyboard is on AND the roll is open.
  stepRecordOnRef.current = qwerty.active;
  const [insertBeat, setInsertBeat] = useState(0);
  useEffect(() => { stepRef.current = STEP_INITIAL; setInsertBeat(0); insertBeatRef.current = 0; }, [editingClipId]);
  useEffect(() => {
    if (!editingClipId || !clip) return;
    const clipId = clip.id;
    const onNote = (ev: Event) => {
      if (!stepRecordOnRef.current) return;
      const d = (ev as CustomEvent<{ pitch: number; velocity?: number; down: boolean }>).detail;
      if (!d) return;
      const r = stepReduce(stepRef.current, { t: d.down ? "down" : "up", pitch: d.pitch }, stepBeatsRef.current);
      stepRef.current = r.next;
      setInsertBeat(r.next.insertBeat); insertBeatRef.current = r.next.insertBeat;
      if (r.add)
        void exec("add_note", {
          clipId, pitch: r.add.pitch, start: r.add.start,
          length: stepBeatsRef.current, velocity: d.velocity ?? 100,
        });
    };
    window.addEventListener("mosh-qwerty-note", onNote);
    return () => window.removeEventListener("mosh-qwerty-note", onNote);
  }, [editingClipId, clip, exec]);

  // Escape goes through the shared stack (AL-001), not a private window listener.
  // This component was the one holdout — every other overlay adopted the stack and
  // cites *this* file as the pattern it mirrors, but the migration never reached it,
  // so with the piano roll under another overlay a single Escape closed both. The
  // stack listens in CAPTURE phase and stopPropagation()s, which is why the
  // Delete/Backspace listener below (bubble phase) is unaffected.
  useEscapeStack(Boolean(editingClipId && clip), close);

  // The editor's OWN keyboard layer. Mounted only while the roll is open, in BUBBLE phase,
  // so precedence falls out of where each listener sits rather than from a priority table:
  // the escape stack (capture) → the QWERTY instrument (capture, claims its letters when
  // armed) → this → the app keymap. The app's clip-nudge already bails on editingClipId,
  // so plain arrows are free for us here.
  //
  // Note the letter keys (F/G/K/T/0) deliberately stop working while the computer keyboard
  // is armed — it claims them in capture phase to play notes, which IS Ableton's behaviour.
  useEffect(() => {
    if (!editingClipId || !clip) return;
    const clipId = clip.id;
    const notesNow = clip.notes ?? [];

    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement | null;
      if (el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.tagName === "SELECT" || el.isContentEditable)) return;
      if (docked && !editorKeyFocused()) return;
      const mod = e.metaKey || e.ctrlKey;
      const sel = selectedNotes;
      const take = () => { e.preventDefault(); e.stopPropagation(); };

      // ── selection ──
      if (mod && e.key.toLowerCase() === "a") {
        take();
        applySelection(e.shiftKey ? invertSelection(notesNow, sel) : selectAll(notesNow));
        return;
      }
      // ── clipboard ──
      if (mod && ["c", "x", "v", "d"].includes(e.key.toLowerCase())) {
        const k = e.key.toLowerCase();
        if (k === "c" || k === "x") {
          if (sel.size === 0) return;
          take();
          setClipboard(copyNotes(notesNow, sel));
          if (k === "x") { void removeNotes(exec, clipId, [...sel]); applySelection(new Set()); }
          return;
        }
        if (k === "v") {
          const cb = getClipboard();
          if (!cb) return;
          take();
          void addNotesAndSelect(clipId, pasteAt(cb, insertBeatRef.current), nextEditGuard());
          return;
        }
        if (sel.size === 0) return;   // Cmd+D
        take();
        void addNotesAndSelect(clipId, duplicateAfter(notesNow, sel), nextEditGuard());
        return;
      }
      // ── quantize the clip to the grid shown here (Ableton's Cmd+U) ──
      if (mod && e.key.toLowerCase() === "u") {
        take();
        void exec("quantize_notes", { clipId, division: stepBeatsRef.current, swing: swingRef.current });
        return;
      }
      // ── grid (Cmd+1..4 pick a division, like Ableton) ──
      if (mod && ["1", "2", "3", "4"].includes(e.key)) {
        take();
        const idx = Number(e.key);   // 1 => 1/4 … 4 => 1/32
        setGrid((g) => ({ ...g, adaptive: false, division: GRID_DIVISIONS[idx] ?? g.division }));
        return;
      }
      // ── nudge / transpose / velocity ──
      if (e.key.startsWith("Arrow")) {
        if (sel.size === 0) return;
        const horizontal = e.key === "ArrowLeft" || e.key === "ArrowRight";
        const dir = (e.key === "ArrowRight" || e.key === "ArrowDown") ? 1 : -1;
        if (e.altKey) {          // step the selection to the next/previous note
          take();
          applySelection(stepSelection(notesNow, sel, horizontal ? (dir as 1 | -1) : (dir as 1 | -1)), { audition: true });
          return;
        }
        take();
        if (horizontal) {
          const step = stepBeatsRef.current;
          const edits = e.shiftKey
            ? lengthEdits(notesNow, sel, dir * step, step)
            : nudgeEdits(notesNow, sel, dir * step);
          void commitNoteEdits(clipId, notesNow, edits, nextEditGuard());
        } else if (mod) {
          const edits = velocityEdits(notesNow, sel, -dir * (e.shiftKey ? 1 : 10));
          void commitNoteEdits(clipId, notesNow, edits, nextEditGuard());
        } else {
          const semis = -dir * (e.shiftKey ? 12 : 1);
          const edits = transposeEdits(notesNow, sel, semis, lockPitchRef.current);
          void commitNoteEdits(clipId, notesNow, edits, nextEditGuard());
        }
        return;
      }
      // ── view + note state (single letters — see the header note) ──
      if (!mod && !e.altKey) {
        const k = e.key.toLowerCase();
        if (k === "f") { take(); setFold((f) => (f === "content" ? "off" : "content")); return; }
        if (k === "g") { take(); setFold((f) => (f === "scale" ? "off" : "scale")); return; }
        if (k === "k") { take(); setScaleHighlight((v) => !v); return; }
        if (k === "t") { take(); setGrid((g) => ({ ...g, triplet: !g.triplet })); return; }
        if (e.key === "0" && sel.size > 0) {
          take();
          void commitNoteEdits(clipId, notesNow, toggleActiveEdits(notesNow, sel), nextEditGuard());
          return;
        }
      }
      if (e.key === "Delete" || e.key === "Backspace") {
        if (sel.size === 0) return;
        take();
        void removeNotes(exec, clipId, [...sel]);
        applySelection(new Set());
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [editingClipId, clip, selectedNotes, exec, close]); // eslint-disable-line react-hooks/exhaustive-deps

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
  const gridBeats = gridBeatsFor({
    clipBeats: clip.length / beatSeconds(m),
    beatsPerBar: m.num,
    beatPx,
    viewportW,
  });
  const gridProjection = editorGridProjection(m, grid, beatPx, gridBeats);
  // The editor's OWN grid. `snap` (the global on/off) still applies, but the DIVISION is
  // local — changing it here never re-grids the arrangement, and vice versa.
  const stepBeats = snap ? gridProjection.stepBeats : 0;
  // The step-record listener reads this at event time (see the refs above).
  stepBeatsRef.current = stepBeats > 0 ? stepBeats : 1;
  const snapBeat = (b: number, bypass = false) => (!bypass && stepBeats > 0 ? Math.round(b / stepBeats) * stepBeats : b);
  const gridW = gridBeats * beatPx;
  // Feed the playhead loop this render's geometry (see the rAF effect above).
  geomRef.current = { start: clip.start, beatSec: beatSeconds(m), beatPx, len: clip.length };
  // Scale lock (invariant 88) — an INPUT AID, exactly like snap-to-grid above:
  // it constrains the pitch of notes you draw or drag BEFORE the command is sent,
  // so notes you never touched are never rewritten. Off ⇒ this whole block is
  // inert and the roll renders exactly as it did before.
  const songKey = resolveKey(snapshot?.session.key);
  const keyMask = scaleMask(songKey);
  const lockPitch = (pitch: number) => (scaleLock ? snapToScale(pitch, keyMask) : pitch);
  lockPitchRef.current = lockPitch;
  // Every consumer — rows, gutter, note boxes, marquee hit-testing, click-to-draw — goes
  // through ONE axis object. Once rows can be folded away, (HIGH - pitch) * ROW_H is simply
  // wrong, and any consumer still doing its own arithmetic would silently disagree.
  const axis = pitchAxis(
    visiblePitches({
      low: LOW,
      high: HIGH,
      mode: fold,
      keyMask,
      notes: [
        ...(clip.notes ?? []),
        ...contextNotes.map((note, index) => ({ ...note, i: -(index + 1) })),
      ],
    }),
    ROW_H,
  );
  const pitches = axis.visible;
  const yOf = axis.yOf;
  const pitchAt = axis.pitchAt;

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

  const idleGridCursor: PianoRollCursor = drawActive ? "crosshair" : "default";
  const cursorForTarget = (target: EventTarget | null, clientX?: number): PianoRollCursor => {
    const hit = noteHitAt(target, clientX);
    return hit ? cursorForNoteHit(hit) : idleGridCursor;
  };
  const setGridCursor = (grid: HTMLElement, cursor: PianoRollCursor, refresh = false) => {
    grid.style.cursor = pianoRollCursorCss(cursor);
    applyNativeCursor(cursor, refresh);
  };
  const onGridHover = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!dragRef.current) setGridCursor(e.currentTarget, cursorForTarget(e.target, e.clientX));
  };
  const onGridLeave = (e: React.PointerEvent<HTMLDivElement>) => {
    const active = dragRef.current;
    if (active) {
      setGridCursor(
        e.currentTarget,
        active.kind === "resize-start" || active.kind === "resize-end" ? "ew-resize" : "grabbing",
      );
      return;
    }
    setGridCursor(e.currentTarget, "default");
  };
  const onGridDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if ((e.target as HTMLElement).closest(".pr-note")) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const x = Math.max(0, e.clientX - rect.left), y = Math.max(0, e.clientY - rect.top);
    gridDragRef.current = { pointerId: e.pointerId, x0: x, y0: y, moved: false };
    try { e.currentTarget.setPointerCapture(e.pointerId); } catch { /* noop */ }
    applySelection(new Set());
  };
  const onNoteDown = (kind: NoteHitKind, n: MidiNote) => (e: React.PointerEvent) => {
    e.stopPropagation();
    // Shift-click edits the SELECTION and starts no drag — otherwise the same gesture
    // would both extend the selection and immediately begin moving it.
    if (e.shiftKey) { applySelection(toggleSelection(selectedNotes, n.i, true), { audition: true }); return; }

    // Grabbing a note that is already selected drags the WHOLE selection; grabbing an
    // unselected one selects just it first. (Replacing the selection unconditionally, as
    // this used to, is what made multi-note editing impossible.)
    const wasSelected = selectedNotes.has(n.i);
    const sel = wasSelected ? selectedNotes : new Set([n.i]);
    if (sel !== selectedNotes) applySelection(sel, { audition: true });

    const byIndex = new Map((clip.notes ?? []).map((x) => [x.i, x]));
    const orig = new Map<number, MidiNote>();
    for (const i of sel) { const x = byIndex.get(i); if (x) orig.set(i, x); }

    try { (e.target as HTMLElement).setPointerCapture(e.pointerId); } catch { /* noop */ }
    const scroller = scrollRef.current;
    const dragKind = kind === "move" && e.altKey ? "copy" : kind;
    const guard = nextEditGuard();
    dragRef.current = {
      kind: dragKind,
      anchorI: n.i, orig, startX: e.clientX, startY: e.clientY,
      startScrollLeft: scroller?.scrollLeft ?? 0,
      startScrollTop: scroller?.scrollTop ?? 0,
      lastX: e.clientX, lastY: e.clientY, lastAltKey: e.altKey,
      moved: false,
      collapseOnClick: wasSelected && selectedNotes.size > 1,
      ...guard,
    };
    const grid = (e.currentTarget as HTMLElement).closest<HTMLElement>(".pr-grid");
    if (grid) setGridCursor(grid, cursorForNoteHit(kind, true));
  };
  const onResolvedNoteDown = (n: MidiNote) => (e: React.PointerEvent) =>
    onNoteDown(noteHitAt(e.target, e.clientX) ?? "move", n)(e);
  const updateNoteDrag = (clientX: number, clientY: number, altKey: boolean) => {
    const d = dragRef.current;
    if (d) {
      d.lastX = clientX; d.lastY = clientY; d.lastAltKey = altKey;
      const scroller = scrollRef.current;
      // The two axes are guarded symmetrically: an axis you did not move is never
      // rewritten (see pianoRollEdit.ts, which owns that rule now). Pitch gets its
      // deadzone for free from rounding to whole rows; TIME is continuous, so it needs an
      // explicit drag threshold — without it a 1px hand-wobble during a vertical drag
      // would re-snap the start, and a deliberately off-grid note (a pushed hit, a swung
      // 16th) must survive a pitch nudge with its timing intact.
      //
      // Option during a COPY drag is the modifier that started the copy, not a snap
      // bypass — reading it as both would make an Option-drag silently off-grid too.
      const bypassSnap = d.kind !== "copy" && altKey;
      const input = {
        orig: d.orig,
        dxPx: clientX - d.startX + (scroller?.scrollLeft ?? d.startScrollLeft) - d.startScrollLeft,
        dyPx: clientY - d.startY + (scroller?.scrollTop ?? d.startScrollTop) - d.startScrollTop,
        bypassSnap,
      };
      const edits = d.kind === "resize-start" ? resizeStartEdits(input, gestureGeom(bypassSnap))
                  : d.kind === "resize-end" ? resizeEdits(input, gestureGeom(bypassSnap))
                  : moveEdits(input, gestureGeom(bypassSnap));
      if (edits.length > 0) d.moved = true;
      // AUDITION 1/4 — hear the pitch as you drag up the scale. Driven off the ANCHOR's
      // previewed pitch, and notePreview itself collapses this to at most one command per
      // crossed semitone, so a fast octave drag is a handful of notes rather than a flood.
      if (d.kind !== "resize-start" && d.kind !== "resize-end" && auditionTrackId) {
        const anchor = previewFrom(d.orig, edits).get(d.anchorI);
        if (anchor) notePreview.hold("pr-drag", auditionTrackId, anchor.pitch, anchor.velocity);
      }
      // Inside the deadzone the preview is CLEARED, not merely left unwritten: dragging
      // out and back to the origin would otherwise release with the abandoned preview
      // still standing and commit the trip anyway.
      setPreviewNotes(previewFrom(d.orig, edits));
      return true;
    }
    return false;
  };
  const onGridMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const activeDrag = dragRef.current;
    if (activeDrag) {
      setGridCursor(
        e.currentTarget,
        activeDrag.kind === "resize-start" || activeDrag.kind === "resize-end" ? "ew-resize" : "grabbing",
        true,
      );
    }
    if (updateNoteDrag(e.clientX, e.clientY, e.altKey)) return;
    const gd = gridDragRef.current;
    if (!gd || e.buttons === 0) {
      setGridCursor(e.currentTarget, cursorForTarget(e.target, e.clientX), true);
      return;
    }
    const rect = e.currentTarget.getBoundingClientRect();
    const x = Math.max(0, e.clientX - rect.left), y = Math.max(0, e.clientY - rect.top);
    if (Math.hypot(x - gd.x0, y - gd.y0) > 4) gd.moved = true;
    if (!gd.moved) return;
    if (drawActive) {
      // Draw mode: the drag paints a note, not a marquee. The ghost tracks the drag
      // through the same pure helper the commit uses, so preview and result agree.
      const span = drawNoteSpan({ downBeat: gd.x0 / beatPx, currentBeat: x / beatPx, stepBeats, bypassSnap: e.altKey });
      setDrawGhost({ ...span, pitch: lockPitch(pitchAt(gd.y0)) });
      return;
    }
    setLasso({ x0: gd.x0, y0: gd.y0, x1: x, y1: y });
  };
  const onGridUp = (e: React.PointerEvent<HTMLDivElement>) => {
    const d = dragRef.current;
    if (d) {
      const final = previewRef.current;
      dragRef.current = null; setPreviewNotes(new Map());
      setGridCursor(e.currentTarget, cursorForTarget(e.target, e.clientX));
      notePreview.release("pr-drag");
      if (final.size === 0) {
        if (!d.moved && d.collapseOnClick)
          applySelection(new Set([d.anchorI]), { audition: true });
        return;
      }

      if (d.kind === "copy") {
        // Option-drag drops a COPY at the new position and leaves the originals alone.
        // The new notes' indices are unknowable ahead of time (MidiList re-sorts on
        // insert), so the selection is re-derived by value once the snapshot lands —
        // otherwise the producer is left with the originals selected, or with indices
        // pointing at whichever notes happen to occupy them now.
        const made = [...final.values()].map((n) => ({ pitch: n.pitch, start: n.start, length: n.length, velocity: n.velocity }));
        void (async () => {
          await addNotesAndSelect(clip.id, made, d);
        })();
        return;
      }

      const edits = [...final.values()].map((n) =>
        d.kind === "resize-start" ? { i: n.i, start: n.start, length: n.length }
        : d.kind === "resize-end" ? { i: n.i, length: n.length }
        : { i: n.i, start: n.start, pitch: n.pitch });
      void commitNoteEdits(clip.id, [...d.orig.values()], edits, d);
      return;
    }
    const gd = gridDragRef.current; if (!gd) return;
    gridDragRef.current = null;
    try { e.currentTarget.releasePointerCapture(gd.pointerId); } catch { /* noop */ }
    const rect = e.currentTarget.getBoundingClientRect();
    const x = Math.max(0, e.clientX - rect.left), y = Math.max(0, e.clientY - rect.top);
    const wasMoved = gd.moved || Math.hypot(x - gd.x0, y - gd.y0) > 4;
    setLasso(null);
    setDrawGhost(null);
    if (!wasMoved) {
      // Selection mode follows the shared editor contract: a single empty-ground
      // click moves the insertion point and clears selection; it never creates a
      // note. Pencil mode remains immediate (single click paints).
      if (!drawActive) {
        const beat = Math.max(0, e.altKey ? x / beatPx : snapDownBeat(x / beatPx, stepBeats));
        setInsertBeat(beat); insertBeatRef.current = beat;
        return;
      }
      // Draw-start FLOORS to the grid line at/below the pointer (snapDownBeat — see
      // pianoRollGeom.ts for why round here drops the note half a step from the click).
      const start = Math.max(0, e.altKey ? x / beatPx : snapDownBeat(x / beatPx, stepBeats)), pitch = lockPitch(pitchAt(y)), length = stepBeats > 0 ? stepBeats : 1;
      // AUDITION 2/4 — hear what you just drew.
      if (auditionTrackId) notePreview.tap(auditionTrackId, pitch);
      void exec("add_note", { clipId: clip.id, pitch, start, length, velocity: 100 });
      return;
    }
    // Draw mode: a moved drag commits the painted note (floor-snapped start, snapped
    // length ≥ one grid step — drawNoteSpan owns the arithmetic) instead of opening
    // the marquee. The pitch comes from where the drag STARTED, like every DAW's pencil.
    if (drawActive) {
      const span = drawNoteSpan({ downBeat: gd.x0 / beatPx, currentBeat: x / beatPx, stepBeats, bypassSnap: e.altKey });
      const pitch = lockPitch(pitchAt(gd.y0));
      if (auditionTrackId) notePreview.tap(auditionTrackId, pitch);
      void exec("add_note", { clipId: clip.id, pitch, start: span.start, length: span.length, velocity: 100 });
      return;
    }
    // Shift-marquee ADDS to the selection rather than replacing it, so several sweeps can
    // build one selection up (Ableton behaves this way and it is muscle memory).
    const hit = marqueeHit(clip.notes ?? [], { x0: gd.x0, y0: gd.y0, x1: x, y1: y }, noteBox);
    applySelection(e.shiftKey ? new Set([...selectedNotes, ...hit]) : new Set(hit));
  };
  const onGridDoubleClick = (e: React.MouseEvent<HTMLDivElement>) => {
    if (drawActive || (e.target as HTMLElement).closest(".pr-note")) return;
    e.preventDefault();
    const rect = e.currentTarget.getBoundingClientRect();
    const x = Math.max(0, e.clientX - rect.left), y = Math.max(0, e.clientY - rect.top);
    const start = Math.max(0, e.altKey ? x / beatPx : snapDownBeat(x / beatPx, stepBeats));
    const pitch = lockPitch(pitchAt(y));
    const length = stepBeats > 0 ? stepBeats : 1;
    setInsertBeat(start); insertBeatRef.current = start;
    if (auditionTrackId) notePreview.tap(auditionTrackId, pitch);
    void exec("add_note", { clipId: clip.id, pitch, start, length, velocity: 100 });
  };
  // The single cancel funnel for pointercancel + lostpointercapture, which is why the
  // stuck-note release is one line rather than one per exit.
  const onGridCancel = (e: React.PointerEvent<HTMLDivElement>) => {
    dragRef.current = null; gridDragRef.current = null;
    setPreviewNotes(new Map()); setLasso(null); setDrawGhost(null);
    notePreview.release("pr-drag");
    setGridCursor(e.currentTarget, "default");
  };

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
    if (targets.length === 1) applySelection(new Set(targets));
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
    void commitNoteEdits(clip.id, clip.notes ?? [], edits, nextEditGuard());
  };
  const onVelCancel = () => { velDragRef.current = { active: false, startX: 0, drafts: new Map() }; setVelDrafts({}); };

  const selectedIndex = selectedNotes.values().next().value as number | undefined;
  const selNote = selectedIndex != null ? (clip.notes ?? []).find((n) => n.i === selectedIndex) : undefined;
  const velocityValue = velocityDraft ?? selNote?.velocity ?? 100;
  const setDraftVelocity = (value: number) => { const next = Math.round(Math.min(127, Math.max(1, value))); velocityDraftRef.current = next; setVelocityDraft(next); };

  // Live 12 velocity tool row state + the single-command apply (one undo step).
  const applyVelocityTool = (mode: "randomize" | "ramp" | "deviate") => {
    const args: Record<string, unknown> = { clipId: clip.id, mode };
    if (mode === "ramp") { args.lo = rampLo; args.hi = rampHi; }
    else args.amount = mode === "randomize" ? randAmt : devAmt;
    // Live's rule: the selection if any, else every note in the clip.
    if (selectedNotes.size > 0) args.noteIndexes = [...selectedNotes];
    void exec("transform_velocities", args);
  };
  // Live 12 Transform tool row — same single-command apply (one undo step), same
  // target rule (the selection if any, else every note). The engine owns the math.
  const applyTransformTool = (mode: "reverse" | "invert" | "legato" | "humanize" | "x2" | "d2"
                                    | "setLength" | "addInterval" | "fitToScale") => {
    const args: Record<string, unknown> = { clipId: clip.id, mode };
    if (mode === "humanize") args.amount = humAmt;
    // Set Length defaults to the CURRENT GRID STEP (Live's field follows the grid);
    // a typed value sticks until cleared. Snap off ⇒ 1 beat.
    if (mode === "setLength") args.lengthBeats = lenBeats ?? (stepBeats > 0 ? stepBeats : 1);
    if (mode === "addInterval") args.semitones = intervalSemis;
    if (selectedNotes.size > 0) args.noteIndexes = [...selectedNotes];
    void exec("transform_notes", args);
  };
  const commitVelocity = () => {
    if (!selNote) return;
    const next = velocityDraftRef.current;
    if (next == null || next === selNote.velocity) return;
    velocityDraftRef.current = null; setVelocityDraft(null);
    void commitNoteEdits(
      clip.id,
      clip.notes ?? [],
      [{ i: selNote.i, velocity: next }],
      nextEditGuard(),
    );
  };

  // The panel's content is identical in both mounts; only the frame differs.
  const prContent = (
    <>
        <div className="pr-head">
          <strong className="display">{mode === "drums" ? "Drum Machine" : "Piano Roll"} · {clip.name}</strong>
          <span className="pr-meta tc">{(clip.notes ?? []).length} notes · {m.tempo} BPM · {m.num}/{m.den}</span>
          <div className="seg" role="group" aria-label="Editor mode">
            <button className="btn" aria-pressed={mode === "piano"} onClick={() => setMode("piano")}>Piano</button>
            <button className="btn" aria-pressed={mode === "drums"} onClick={() => setMode("drums")}>Drums</button>
            {/* The pad grid is for building and PLAYING a kit; the step grid beside it is
                for writing patterns. Ableton has no step grid, so this is additive rather
                than a replacement. Only offered on a track that actually has a sampler. */}
            {padTrack && (
              <button className="btn" data-testid="pr-tab-pads" aria-pressed={mode === "pads"} onClick={() => setMode("pads")}>Pads</button>
            )}
          </div>
          {/* Live 12's loop brace sits in the clip panel's header — here, in the
              roll's own header row (no extra dock row; the fixed-height dock's grid
              keeps its room). MIDI clips only; set_clip_loop's MIDI branch. */}
          {mode === "piano" && clip.type === "midi" && (
            <span className="pr-loopbar" data-testid="live-dock-loopbar">
              <ClipLoopBar clip={clip} />
            </span>
          )}
          <span className="spacer" />
          {/* The velocity control is ALWAYS mounted in piano mode — visibility-hidden
              without a selection, never unmounted. The "editor jumps when I delete a
              note" jank was this block appearing/disappearing and reflowing every
              header control to its right on each select/delete. */}
          {mode === "piano" && (
            <label className="pr-vel" style={{ visibility: selNote ? "visible" : "hidden" }}
              aria-hidden={!selNote}>vel
              <input aria-label="Selected note velocity" type="range" min={1} max={127} step={1} value={velocityValue}
                onChange={(e) => setDraftVelocity(Number(e.target.value))} onPointerUp={commitVelocity} onKeyUp={commitVelocity} onBlur={commitVelocity} />
              <span className="tc">{velocityValue}</span>
            </label>
          )}
          {/* Ableton's Preview switch (the headphone) and the computer-keyboard toggle.
              Both are producer preferences, so they live in settings and persist. */}
          <MoshTip side="bottom" label={notePreviewOn
            ? "Preview ON — notes sound through the track's instrument as you draw, drag, or select them."
            : "Preview OFF — editing is silent. Click to hear notes as you edit."}>
            <button className="btn" data-testid="pr-preview" aria-pressed={notePreviewOn}
              onClick={() => {
                const next = !notePreviewOn;
                useSettings.getState().set("notePreview", next);
                if (!next) notePreview.releaseAll();
              }}>
              {notePreviewOn ? "🎧" : "🎧̸"} Preview
            </button>
          </MoshTip>
          <MoshTip side="bottom" label={qwerty.active
            ? `Computer MIDI keyboard ON — A-K play white keys, W/E/T/Y/U black. Z/X octave, C/V velocity. While it is on, single-letter shortcuts need Shift.`
            : "Play notes with the computer keyboard (Ableton's M)."}>
            <button className="btn" data-testid="pr-qwerty" aria-pressed={qwerty.active}
              onClick={() => setQwertyActive(!qwerty.active)}>
              ⌨ {qwerty.active ? `C${qwerty.octave} · v${qwerty.velocity}` : "Keys"}
            </button>
          </MoshTip>
          {mode === "piano" && (
            <span className="seg" role="group" aria-label="Fold">
              <MoshTip side="bottom" label="Fold (F) — show only the pitches this clip actually uses. Essential on a drum clip: eight rows instead of 128.">
                <button className="btn" data-testid="pr-fold" aria-pressed={fold === "content"}
                  onClick={() => setFold(fold === "content" ? "off" : "content")}>Fold</button>
              </MoshTip>
              <MoshTip side="bottom" label={`Fold to Scale (G) — show only rows in ${keyLabel(snapshot?.session.key ?? {})}, plus any pitch that already has a note (so nothing you wrote can be hidden).`}>
                <button className="btn" data-testid="pr-fold-scale" aria-pressed={fold === "scale"}
                  onClick={() => setFold(fold === "scale" ? "off" : "scale")}>Scale</button>
              </MoshTip>
            </span>
          )}
          {mode === "piano" && (
            <MoshTip side="bottom" label="Highlight scale (K) — dim the out-of-key rows without constraining what you draw.">
              <button className="btn" data-testid="pr-scale-highlight" aria-pressed={scaleHighlight}
                onClick={() => setScaleHighlight(!scaleHighlight)}>Key</button>
            </MoshTip>
          )}
          {mode === "piano" && (
            <MoshTip side="bottom" label="Repair legacy same-pitch overlaps in this clip. Later notes win; chords stay intact. This is one undoable step.">
              <button className="btn" data-testid="pr-resolve-overlaps"
                onClick={() => void exec("resolve_note_overlaps", { clipId: clip.id })}>Repair overlaps</button>
            </MoshTip>
          )}
          {mode === "piano" && (
            <span className="seg pr-grid-ctl" role="group" aria-label="Grid">
              <MoshTip side="bottom" label="Adaptive grid — follow the zoom instead of a fixed division.">
                <button className="btn" data-testid="pr-grid-adaptive" aria-pressed={grid.adaptive}
                  onClick={() => setGrid({ ...grid, adaptive: !grid.adaptive })}>
                  {gridLabel(m, grid, beatPx)}
                </button>
              </MoshTip>
              <MoshTip side="bottom" label="Triplet grid (T)">
                <button className="btn" data-testid="pr-grid-triplet" aria-pressed={grid.triplet}
                  onClick={() => setGrid({ ...grid, triplet: !grid.triplet })}>T</button>
              </MoshTip>
            </span>
          )}
          {mode === "piano" && (
            <MoshTip side="bottom" label={scaleLock
              ? `Scale lock ON — a note you draw, or drag to a new pitch, snaps to ${keyLabel(snapshot?.session.key ?? {})}. Notes you don't move keep their pitch, and so does a note you only slide in time.`
              : `Scale lock OFF — click to snap notes you draw or re-pitch to ${keyLabel(snapshot?.session.key ?? {})} (set the key in the topbar).`}>
              <button className="btn" data-testid="pr-scale-lock" aria-pressed={scaleLock}
                onClick={() => useSettings.getState().set("scaleLock", !scaleLock)}>
                Scale {keyLabel(snapshot?.session.key ?? {})}
              </button>
            </MoshTip>
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
            <span className="seg pr-swing-ctl" role="group" aria-label="Quantize swing">
              {/* #552 — the engine's `swing` term, which cmdQuantizeNotes gained with this
                  control (never the other way round: a swing slider over an engine with no
                  swing is an inert surface). 0 is straight, so leaving it alone is exactly
                  the quantize this button has always done. */}
              <MoshTip side="bottom" label="Swing — delay every second subdivision of the grid and leave the on-beats where they are. 0 is straight; 100 is the MPC 75% maximum, where the off-beat sits exactly halfway to the next on-beat. Around 67 is the classic triplet feel.">
                <input
                  type="range" min={0} max={100} step={1} value={swingPct}
                  data-testid="pr-quantize-swing"
                  aria-label="Quantize swing (percent)"
                  onChange={(e) => setSwingPct(Number(e.target.value))}
                />
              </MoshTip>
              <span className="pr-swing-val" data-testid="pr-quantize-swing-val">
                {swingPct === 0 ? "straight" : `swing ${swingPct}`}
              </span>
            </span>
          )}
          {mode === "piano" && (
            <MoshTip side="bottom" label="Snap every note in the clip to the grid shown here, using the swing amount beside this button">
              <button className="btn" data-testid="pr-quantize"
                onClick={() => exec("quantize_notes", {
                  clipId: clip.id, division: effectiveStepBeats(m, grid, beatPx), swing: swingPct,
                })}>
                Quantize {gridLabel(m, grid, beatPx)}
              </button>
            </MoshTip>
          )}
          {expandControl && (
            <MoshTip side="bottom" label={expandControl.expanded
              ? "Shrink the clip view (⌥⌘E) — bring the arrangement back"
              : "Expand Clip View (⌥⌘E) — the editor fills the window"}>
              <button className="btn" data-testid="pr-expand" aria-pressed={expandControl.expanded}
                onClick={expandControl.onToggle}>⤢</button>
            </MoshTip>
          )}
          <button className="btn x" onClick={close}>✕</button>
        </div>
        {mode === "pads" && padTrack ? <DrumPads track={padTrack} clipId={clip.id} /> : mode === "drums" ? <DrumSequencer clip={clip} /> : (
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
                // AUDITION 3/4 — the gutter is playable: click a key to hear that pitch.
                // Shift-click selects every note at that pitch instead (Ableton's gesture).
                <div key={p} className={`pr-key ${isBlack(p) ? "black" : "white"}`} style={{ height: ROW_H }}
                  data-testid="pr-key" data-pitch={p}
                  title={`${noteName(p)} — click to hear it, shift-click to select its notes`}
                  onPointerDown={(e) => {
                    e.preventDefault();
                    if (e.shiftKey) applySelection(selectAtPitch(clip.notes ?? [], p, true, selectedNotes));
                    else if (auditionTrackId) notePreview.tap(auditionTrackId, p);
                  }}>{p % 12 === 0 && <span>{noteName(p)}</span>}</div>
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
            // A captured pointer is expressed in VIEWPORT coordinates, while notes live in
            // this scroller's CONTENT coordinates. Re-run the gesture with the last pointer
            // sample whenever the viewport moves so a note held at the edge travels with the
            // content beneath the stationary pointer instead of accumulating a visible gap.
            const d = dragRef.current;
            if (d) {
              updateNoteDrag(d.lastX, d.lastY, d.lastAltKey);
              setGridCursor(
                e.currentTarget.querySelector<HTMLElement>(".pr-grid") ?? e.currentTarget,
                d.kind === "resize-start" || d.kind === "resize-end" ? "ew-resize" : "grabbing",
              );
            }
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
            <div className="pr-grid" role="group" aria-label="Piano roll grid" style={{ width: gridW, height: axis.height, cursor: idleGridCursor }}
              onPointerOver={onGridHover} onPointerLeave={onGridLeave}
              onPointerDown={onGridDown} onPointerMove={onGridMove} onPointerUp={onGridUp} onPointerCancel={onGridCancel} onLostPointerCapture={onGridCancel}
              onDoubleClick={onGridDoubleClick}>
              {pitches.map((p) => {
                // Only shade for the key while the lock is on, so the roll is
                // pixel-identical to before when the feature is off.
                // Shading is driven by EITHER the input aid (scale lock) or the pure view
                // preference (scale highlight) — they were the same flag, so you could not
                // see the key without also constraining what you drew.
                const shade = scaleLock || scaleHighlight;
                const off = shade && !keyMask[pitchClass(p)];
                const root = shade && pitchClass(p) === songKey.tonic;
                return <div key={`r${p}`} className={`pr-row ${isBlack(p) ? "black" : ""}${off ? " off-key" : ""}${root ? " root" : ""}`} style={{ top: yOf(p), height: ROW_H }} />;
              })}
              {gridProjection.lines.map((line) => (
                <div key={`c${line.beat}`} className={`pr-gl ${line.kind}`}
                  data-grid-kind={line.kind} data-grid-beat={line.beat}
                  style={{ left: line.beat * beatPx }} />
              ))}
              {/* MIDI clip loop ghosts — the loop region's repeats painted dimmer and
                  DISARMED (Live's editor ghosts): display-only, never selectable —
                  editing stays indexed into the real notes. */}
              {loopGhosts.map((n, gi) => {
                const b = noteBox(n);
                return (
                  <div key={`ghost-${gi}`} className="pr-note pr-loop-ghost" aria-hidden
                    style={{ left: b.x, top: b.y, width: b.w, height: b.h }} />
                );
              })}
              <PianoRollContextNotes
                notes={contextNotes}
                beatPx={beatPx}
                rowHeight={ROW_H}
                yOf={yOf}
              />
              {notes.map((n) => {
                const b = noteBox(n);
                // Ten pixels is forgiving at ordinary zoom; reserving at least four pixels
                // in the middle keeps even a minimum-width note available for moving.
                const gripWidth = pianoRollNoteGripWidth(b.w);
                return (
                  <div key={n.i} className={`pr-note ${selectedNotes.has(n.i) ? "sel" : ""}`} data-testid="pr-note" data-pr-hit="move" role="button"
                    aria-pressed={selectedNotes.has(n.i)}
                    aria-label={`${noteName(n.pitch)} note start ${n.start.toFixed(2)} length ${n.length.toFixed(2)} velocity ${n.velocity}`}
                    style={{ left: b.x, top: b.y, width: b.w, height: b.h }}
                    onPointerDown={onResolvedNoteDown(n)}
                    onDoubleClick={(e) => { e.preventDefault(); e.stopPropagation(); void exec("remove_note", { clipId: clip.id, noteIndex: n.i }); }}
                    title={`${noteName(n.pitch)} · vel ${n.velocity} · dbl-click to delete`}>
                    <span className="pr-note-grip pr-note-grip-start" data-pr-hit="resize-start" style={{ width: gripWidth }} role="separator" aria-label={`Resize start of ${noteName(n.pitch)} note`} />
                    <span className="pr-note-grip pr-note-grip-end" data-pr-hit="resize-end" style={{ width: gripWidth }} role="separator" aria-label={`Resize end of ${noteName(n.pitch)} note`} />
                  </div>
                );
              })}
              {lasso && <div className="pr-lasso" style={{ left: Math.min(lasso.x0, lasso.x1), top: Math.min(lasso.y0, lasso.y1), width: Math.abs(lasso.x1 - lasso.x0), height: Math.abs(lasso.y1 - lasso.y0) }} />}
              {/* Draw-mode ghost: the note a pencil drag will commit on release. Same
                  box math as a real note, painted through the same tokens (the ghost
                  rule in mosh.css only dims + disarms it — no literals, per the
                  pianoRollCss guard). */}
              {drawGhost && (
                <div className="pr-note pr-draw-ghost" data-testid="pr-draw-ghost" aria-hidden
                  style={{
                    left: drawGhost.start * beatPx,
                    top: yOf(drawGhost.pitch) + 1,
                    width: Math.max(6, drawGhost.length * beatPx - 1),
                    height: ROW_H - 2,
                  }} />
              )}
              <div className="pr-playhead" data-testid="pr-playhead" aria-hidden />
              {/* Step-record insert marker — where the next typed note lands. Shown only
                  while the computer keyboard is armed, so it never clutters mouse editing. */}
              {qwerty.active && (
                <div className="pr-insert" data-testid="pr-insert" aria-hidden
                  style={{ left: insertBeat * beatPx }} />
              )}
            </div>
          </div>

          {/* Velocity lane. One bar per note, bottom-anchored, same grammar as the drum
              sequencer's velocity graph so the two editors read as one family. Dragging
              updates PREVIEW state only; exactly one set_note per touched note is sent on
              release, so a gesture is one undo step instead of a flood. */}
          <div className="pr-vel-gutter"><span>vel</span></div>
          <div className="pr-vel-vp">
            {/* Live 12's Transform tools row (docked mount only): Reverse / Invert /
                Legato / Humanize ±amount / ×2 / /2, then the panel's second cluster
                Set Length / Add Interval / Fit to Scale — one transform_notes
                command per apply, so one undo step. Targets: the selection if any,
                else every note (Live's rule, same as the velocity tools below). */}
            {docked && mode === "piano" && (
              <div className="pr-veltools" data-testid="pr-transformtools" role="group" aria-label="Transform tools">
                <span className="pr-veltools-label">Transform</span>
                <button className="btn" data-testid="pr-xf-reverse" title="Mirror the targets in time inside their own span (pitches and lengths kept)"
                  onClick={() => applyTransformTool("reverse")}>Reverse</button>
                <button className="btn" data-testid="pr-xf-invert" title="Flip pitches around the highest target pitch"
                  onClick={() => applyTransformTool("invert")}>Invert</button>
                <button className="btn" data-testid="pr-xf-legato" title="Extend each note to the next note's start (the last reaches the span end)"
                  onClick={() => applyTransformTool("legato")}>Legato</button>
                <button className="btn" data-testid="pr-xf-humanize" title="Small random timing + velocity deviation (deterministic per command)"
                  onClick={() => applyTransformTool("humanize")}>Humanize</button>
                <ToolField testId="pr-xf-humanize-amt" ariaLabel="Humanize amount" value={humAmt} onCommit={setHumAmt} />
                <button className="btn" data-testid="pr-xf-x2" title="Double starts (relative to the span) and lengths"
                  onClick={() => applyTransformTool("x2")}>×2</button>
                <button className="btn" data-testid="pr-xf-d2" title="Halve starts (relative to the span) and lengths"
                  onClick={() => applyTransformTool("d2")}>/2</button>
                {/* Live's second cluster: Set Length (field follows the grid step
                    until typed), Add Interval (signed semitones, Live's fifth
                    default), Fit to Scale (snaps to the session key). */}
                <ToolField testId="pr-xf-setlen-beats" ariaLabel="Set Length (beats)" min={0.0625} max={64} integer={false}
                  value={lenBeats ?? (stepBeats > 0 ? stepBeats : 1)} onCommit={(v) => setLenBeats(v)} />
                <button className="btn" data-testid="pr-xf-setlen" title="Set every target note's length to the field value (starts unchanged)"
                  onClick={() => applyTransformTool("setLength")}>Set Length</button>
                <ToolField testId="pr-xf-interval-semis" ariaLabel="Add Interval (semitones)" min={-24} max={24}
                  value={intervalSemis} onCommit={setIntervalSemis} />
                <button className="btn" data-testid="pr-xf-interval" title="Add a chord tone at +N semitones above each target note (skips duplicates)"
                  onClick={() => applyTransformTool("addInterval")}>Add Interval</button>
                <button className="btn" data-testid="pr-xf-fitscale" title="Snap every target pitch to the session key (nearest in-scale, ties down)"
                  onClick={() => applyTransformTool("fitToScale")}>Fit to Scale</button>
              </div>
            )}
            {/* Live 12's velocity tool row (docked mount only): Randomize ±n, Ramp
                lo→hi across the targets in time order, Deviation ±offset — one
                transform_velocities command per apply, so one undo step. Targets:
                the selection if any, else every note (Live's rule). */}
            {docked && mode === "piano" && (
              <div className="pr-veltools" data-testid="pr-veltools" role="group" aria-label="Velocity tools">
                <span className="pr-veltools-label">Velocity</span>
                <button className="btn" data-testid="pr-vt-randomize" title="Randomize velocities by ±amount around each note's current value"
                  onClick={() => applyVelocityTool("randomize")}>Randomize</button>
                <ToolField testId="pr-vt-randomize-amt" ariaLabel="Randomize amount" value={randAmt} onCommit={setRandAmt} />
                <button className="btn" data-testid="pr-vt-ramp" title="Ramp velocities from lo to hi across the targets in time order"
                  onClick={() => applyVelocityTool("ramp")}>Ramp</button>
                <ToolField testId="pr-vt-ramp-lo" ariaLabel="Ramp start velocity" value={rampLo} onCommit={setRampLo} />
                <ToolField testId="pr-vt-ramp-hi" ariaLabel="Ramp end velocity" value={rampHi} onCommit={setRampHi} />
                <button className="btn" data-testid="pr-vt-deviate" title="Apply a uniform random offset in [-amount, +amount] to each velocity"
                  onClick={() => applyVelocityTool("deviate")}>Deviation</button>
                <ToolField testId="pr-vt-deviate-amt" ariaLabel="Deviation amount" value={devAmt} onCommit={setDevAmt} />
              </div>
            )}
            <div className={`pr-vel-lane${docked && mode === "piano" ? " with-tools" : ""}`} ref={velRef} style={{ width: gridW }} data-testid="pr-vel-lane"
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
        <div className="pr-foot">double-click empty space to add · single-click to select or place the insert · drag to move · Option-drag to bypass snap · drag the right edge to resize · drag a velocity bar below · ⌘-scroll to zoom · Esc to close</div></>
        )}
    </>
  );
  // Docked (the live shell's clip-view dock): no modal frame — no backdrop, no
  // close-on-backdrop, no aria-modal claim (the arrangement behind stays live), and
  // live.css's `.pr.docked` drops the pop-in animation. The header's ✕ and Escape
  // both still clear editingClipId, exactly as in the modal.
  const ariaLabel = `${mode === "drums" ? "Drum machine" : "Piano roll"} · ${clip.name}`;
  if (docked) return (
    <div className="pr docked" data-testid="piano-roll" role="dialog"
      ref={panelRef} tabIndex={-1} style={{ outline: "none" }} aria-label={ariaLabel}>
      {prContent}
    </div>
  );
  return (
    <div className="modal-backdrop" onClick={close}>
      <div className="pr" data-testid="piano-roll" role="dialog" aria-modal="true"
        ref={panelRef} tabIndex={-1} style={{ outline: "none" }}
        aria-label={ariaLabel} onClick={(e) => e.stopPropagation()}>
        {prContent}
      </div>
    </div>
  );
}
