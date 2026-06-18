// Piano-roll MIDI editor (ported from the legacy component into the new UI).
// Opens on a MIDI clip (store.editingClipId). Every edit is a command:
// add_note / set_note (move + resize + velocity) / remove_note / quantize_notes.
// Note positions are in BEATS (the seam stays in musical/seconds terms); the grid
// is derived through time.ts from the clip-local meter.

import { useEffect, useRef, useState } from "react";
import { useStore } from "../store";
import type { MidiNote } from "../types";
import { meterAt, tempoMapFrom, beatSeconds, snapStepBeats } from "../time";
import { DrumSequencer } from "./DrumSequencer";

const ROW_H = 15;
const BEAT_PX = 42;
const LOW = 36, HIGH = 96;
const NAMES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];
const isBlack = (p: number) => [1, 3, 6, 8, 10].includes(((p % 12) + 12) % 12);
const noteName = (p: number) => `${NAMES[((p % 12) + 12) % 12]}${Math.floor(p / 12) - 1}`;

type DragKind = "move" | "resize";
type Drag = { kind: DragKind; i: number; startX: number; startY: number; orig: MidiNote };
type GridDrag = { pointerId: number; x0: number; y0: number; moved: boolean };

export function PianoRoll() {
  const editingClipId = useStore((s) => s.editingClipId);
  const close = useStore((s) => s.closePianoRoll);
  const snapshot = useStore((s) => s.snapshot);
  const exec = useStore((s) => s.exec);
  const snap = useStore((s) => s.snap);
  const snapDivision = useStore((s) => s.snapDivision);

  const clip = snapshot?.tracks.flatMap((t) => t.clips).find((c) => c.id === editingClipId) ?? null;

  const [mode, setMode] = useState<"piano" | "drums">("piano");
  const [selectedNotes, setSelectedNotes] = useState<Set<number>>(() => new Set());
  const [preview, setPreview] = useState<MidiNote | null>(null);
  const [lasso, setLasso] = useState<{ x0: number; y0: number; x1: number; y1: number } | null>(null);
  const [velocityDraft, setVelocityDraft] = useState<number | null>(null);
  const dragRef = useRef<Drag | null>(null);
  const gridDragRef = useRef<GridDrag | null>(null);
  const previewRef = useRef<MidiNote | null>(null);
  const velocityDraftRef = useRef<number | null>(null);

  useEffect(() => { if (editingClipId && !clip) close(); }, [editingClipId, clip, close]);
  useEffect(() => { setMode("piano"); }, [editingClipId]);
  useEffect(() => {
    setPreview(null); previewRef.current = null; setLasso(null); gridDragRef.current = null;
    setSelectedNotes((prev) => {
      const available = new Set((clip?.notes ?? []).map((n) => n.i));
      const next = new Set([...prev].filter((i) => available.has(i)));
      return next.size === prev.size ? prev : next;
    });
  }, [clip?.notes]);
  useEffect(() => { setVelocityDraft(null); velocityDraftRef.current = null; }, [editingClipId, selectedNotes]);

  if (!editingClipId || !clip) return null;

  const m = meterAt(tempoMapFrom(snapshot?.session), clip.start);
  const stepBeats = snap ? snapStepBeats(m, snapDivision) : 0;
  const snapBeat = (b: number) => (stepBeats > 0 ? Math.round(b / stepBeats) * stepBeats : b);
  const pitches = Array.from({ length: HIGH - LOW + 1 }, (_, k) => HIGH - k);
  const clipBeats = Math.max(8, clip.length / beatSeconds(m));
  const gridBeats = Math.ceil(clipBeats) + 4;
  const gridW = gridBeats * BEAT_PX;
  const yOf = (pitch: number) => (HIGH - pitch) * ROW_H;
  const pitchAt = (y: number) => HIGH - Math.floor(y / ROW_H);
  const noteBox = (n: MidiNote) => ({ x: n.start * BEAT_PX, y: yOf(n.pitch) + 1, w: Math.max(6, n.length * BEAT_PX - 1), h: ROW_H - 2 });
  const setPreviewNote = (n: MidiNote | null) => { previewRef.current = n; setPreview(n); };

  const notes: MidiNote[] = (clip.notes ?? []).map((n) => (preview && preview.i === n.i ? preview : n));

  const onGridDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if ((e.target as HTMLElement).closest(".pr-note")) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const x = Math.max(0, e.clientX - rect.left), y = Math.max(0, e.clientY - rect.top);
    gridDragRef.current = { pointerId: e.pointerId, x0: x, y0: y, moved: false };
    try { e.currentTarget.setPointerCapture(e.pointerId); } catch { /* noop */ }
    setSelectedNotes(new Set());
  };
  const onNoteDown = (kind: DragKind, n: MidiNote) => (e: React.PointerEvent) => {
    e.stopPropagation();
    setSelectedNotes(new Set([n.i]));
    try { (e.target as HTMLElement).setPointerCapture(e.pointerId); } catch { /* noop */ }
    dragRef.current = { kind, i: n.i, startX: e.clientX, startY: e.clientY, orig: n };
  };
  const onGridMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const d = dragRef.current;
    if (d) {
      const db = (e.clientX - d.startX) / BEAT_PX;
      if (d.kind === "move") {
        const start = Math.max(0, snapBeat(d.orig.start + db));
        const dp = -Math.round((e.clientY - d.startY) / ROW_H);
        const pitch = Math.min(127, Math.max(0, d.orig.pitch + dp));
        setPreviewNote({ ...d.orig, start, pitch });
      } else {
        const length = Math.max(stepBeats || 0.25, snapBeat(d.orig.start + d.orig.length + db) - d.orig.start);
        setPreviewNote({ ...d.orig, length });
      }
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
      const finalPreview = previewRef.current; dragRef.current = null; setPreviewNote(null);
      if (!finalPreview) return;
      if (d.kind === "move") void exec("set_note", { clipId: clip.id, noteIndex: d.i, start: finalPreview.start, pitch: finalPreview.pitch });
      else void exec("set_note", { clipId: clip.id, noteIndex: d.i, length: finalPreview.length });
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
      const start = Math.max(0, snapBeat(x / BEAT_PX)), pitch = pitchAt(y), length = stepBeats > 0 ? stepBeats : 1;
      void exec("add_note", { clipId: clip.id, pitch, start, length, velocity: 100 });
      return;
    }
    const xMin = Math.min(gd.x0, x), xMax = Math.max(gd.x0, x), yMin = Math.min(gd.y0, y), yMax = Math.max(gd.y0, y);
    const hit = (clip.notes ?? []).filter((n) => { const b = noteBox(n); return b.x + b.w >= xMin && b.x <= xMax && b.y + b.h >= yMin && b.y <= yMax; }).map((n) => n.i);
    setSelectedNotes(new Set(hit));
  };
  const onGridCancel = () => { dragRef.current = null; gridDragRef.current = null; setPreviewNote(null); setLasso(null); };

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
      <div className="pr" data-testid="piano-roll" onClick={(e) => e.stopPropagation()}>
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
            <button className="btn" onClick={() => exec("quantize_notes", { clipId: clip.id, division: snapStepBeats(m, snapDivision) })}>Quantize {snapDivision === "bar" ? "Bar" : snapDivision}</button>
          )}
          <button className="btn x" onClick={close}>✕</button>
        </div>
        {mode === "drums" ? <DrumSequencer clip={clip} /> : (
        <><div className="pr-body">
          <div className="pr-keys">
            {pitches.map((p) => (
              <div key={p} className={`pr-key ${isBlack(p) ? "black" : "white"}`} style={{ height: ROW_H }}>{p % 12 === 0 && <span>{noteName(p)}</span>}</div>
            ))}
          </div>
          <div className="pr-scroll">
            <div className="pr-grid" role="group" aria-label="Piano roll grid" style={{ width: gridW, height: pitches.length * ROW_H }}
              onPointerDown={onGridDown} onPointerMove={onGridMove} onPointerUp={onGridUp} onPointerCancel={onGridCancel} onLostPointerCapture={onGridCancel}>
              {pitches.map((p) => <div key={`r${p}`} className={`pr-row ${isBlack(p) ? "black" : ""}`} style={{ top: yOf(p), height: ROW_H }} />)}
              {Array.from({ length: gridBeats + 1 }, (_, b) => <div key={`c${b}`} className={`pr-gl ${b % m.num === 0 ? "bar" : ""}`} style={{ left: b * BEAT_PX }} />)}
              {notes.map((n) => {
                const b = noteBox(n);
                return (
                  <div key={n.i} className={`pr-note ${selectedNotes.has(n.i) ? "sel" : ""}`} data-testid="pr-note" role="button"
                    aria-label={`${noteName(n.pitch)} note start ${n.start.toFixed(2)} length ${n.length.toFixed(2)} velocity ${n.velocity}`}
                    style={{ left: b.x, top: b.y, width: b.w, height: b.h }}
                    onPointerDown={onNoteDown("move", n)}
                    onDoubleClick={(e) => { e.stopPropagation(); void exec("remove_note", { clipId: clip.id, noteIndex: n.i }); }}
                    title={`${noteName(n.pitch)} · vel ${n.velocity} · dbl-click to delete`}>
                    <span className="pr-note-grip" role="separator" aria-label={`Resize ${noteName(n.pitch)} note`} onPointerDown={onNoteDown("resize", n)} />
                  </div>
                );
              })}
              {lasso && <div className="pr-lasso" style={{ left: Math.min(lasso.x0, lasso.x1), top: Math.min(lasso.y0, lasso.y1), width: Math.abs(lasso.x1 - lasso.x0), height: Math.abs(lasso.y1 - lasso.y0) }} />}
            </div>
          </div>
        </div>
        <div className="pr-foot">click empty space to add · drag to move · drag right edge to resize · double-click to delete</div></>
        )}
      </div>
    </div>
  );
}
