import { useEffect, useRef, useState } from "react";
import { useStore } from "../store";
import type { MidiNote } from "../types";
import { meterAt, tempoMapFrom, beatSeconds, snapStepBeats } from "../time";

const ROW_H = 15;
const BEAT_PX = 42;
const LOW = 36;   // C2
const HIGH = 96;  // C7
const NAMES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];
const isBlack = (p: number) => [1, 3, 6, 8, 10].includes(((p % 12) + 12) % 12);
const noteName = (p: number) => `${NAMES[((p % 12) + 12) % 12]}${Math.floor(p / 12) - 1}`;

type DragKind = "move" | "resize";
type Drag = { kind: DragKind; i: number; startX: number; startY: number; orig: MidiNote };

export function PianoRoll() {
  const editingClipId = useStore((s) => s.editingClipId);
  const close = useStore((s) => s.closePianoRoll);
  const snapshot = useStore((s) => s.snapshot);
  const exec = useStore((s) => s.exec);
  const snap = useStore((s) => s.snap);
  const snapDivision = useStore((s) => s.snapDivision);

  const clip = snapshot?.tracks.flatMap((t) => t.clips).find((c) => c.id === editingClipId) ?? null;

  const [sel, setSel] = useState<number | null>(null);
  const [preview, setPreview] = useState<MidiNote | null>(null);
  const dragRef = useRef<Drag | null>(null);

  useEffect(() => {
    if (editingClipId && !clip) close();
  }, [editingClipId, clip, close]);
  useEffect(() => { setPreview(null); }, [clip?.notes]);

  if (!editingClipId || !clip) return null;

  // SES-001 — the meter LOCAL to the clip start (a clip spanning a tempo
  // change displays its grid at the start tempo; documented simplification).
  const m = meterAt(tempoMapFrom(snapshot?.session), clip.start);
  const stepBeats = snap ? snapStepBeats(m, snapDivision) : 0;
  const snapBeat = (b: number) => (stepBeats > 0 ? Math.round(b / stepBeats) * stepBeats : b);
  const pitches = Array.from({ length: HIGH - LOW + 1 }, (_, k) => HIGH - k); // top→bottom
  const clipBeats = Math.max(8, clip.length / beatSeconds(m));
  const gridBeats = Math.ceil(clipBeats) + 4;
  const gridW = gridBeats * BEAT_PX;
  const yOf = (pitch: number) => (HIGH - pitch) * ROW_H;
  const pitchAt = (y: number) => HIGH - Math.floor(y / ROW_H);

  const notes: MidiNote[] = (clip.notes ?? []).map((n) =>
    preview && preview.i === n.i ? preview : n
  );

  const addAt = (e: React.PointerEvent<HTMLDivElement>) => {
    if (e.target !== e.currentTarget) return; // only empty grid
    const rect = e.currentTarget.getBoundingClientRect();
    const start = Math.max(0, snapBeat((e.clientX - rect.left) / BEAT_PX));
    const pitch = pitchAt(e.clientY - rect.top);
    const length = stepBeats > 0 ? stepBeats : 1;
    void exec("add_note", { clipId: clip.id, pitch, start, length, velocity: 100 });
  };

  const onNoteDown = (kind: DragKind, n: MidiNote) => (e: React.PointerEvent) => {
    e.stopPropagation();
    setSel(n.i);
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
    dragRef.current = { kind, i: n.i, startX: e.clientX, startY: e.clientY, orig: n };
  };
  const onMove = (e: React.PointerEvent) => {
    const d = dragRef.current;
    if (!d) return;
    const db = (e.clientX - d.startX) / BEAT_PX;
    if (d.kind === "move") {
      const start = Math.max(0, snapBeat(d.orig.start + db));
      const dp = -Math.round((e.clientY - d.startY) / ROW_H);
      const pitch = Math.min(127, Math.max(0, d.orig.pitch + dp));
      setPreview({ ...d.orig, start, pitch });
    } else {
      const length = Math.max(stepBeats || 0.25, snapBeat(d.orig.start + d.orig.length + db) - d.orig.start);
      setPreview({ ...d.orig, length });
    }
  };
  const onUp = () => {
    const d = dragRef.current;
    dragRef.current = null;
    if (!d || !preview) return;
    if (d.kind === "move")
      void exec("set_note", { clipId: clip.id, noteIndex: d.i, start: preview.start, pitch: preview.pitch });
    else
      void exec("set_note", { clipId: clip.id, noteIndex: d.i, length: preview.length });
  };

  const selNote = sel != null ? (clip.notes ?? []).find((n) => n.i === sel) : undefined;

  return (
    <div className="modal-backdrop" onClick={close}>
      <div className="pr" onClick={(e) => e.stopPropagation()}>
        <div className="pr-head">
          <strong>Piano Roll · {clip.name}</strong>
          <span className="pr-meta">{(clip.notes ?? []).length} notes · {m.tempo} BPM · {m.num}/{m.den}</span>
          <span className="pr-spacer" />
          {selNote && (
            <label className="pr-vel" title="Velocity of the selected note">
              vel
              <input
                type="range" min={1} max={127} step={1} value={selNote.velocity}
                onChange={(e) => exec("set_note", { clipId: clip.id, noteIndex: selNote.i, velocity: Number(e.target.value) })}
              />
              <span>{selNote.velocity}</span>
            </label>
          )}
          <button onClick={() => exec("quantize_notes", { clipId: clip.id, division: snapStepBeats(m, snapDivision) })} title="Quantize all notes to the grid">
            Quantize {snapDivision === "bar" ? "Bar" : snapDivision}
          </button>
          <button className="x" onClick={close}>✕</button>
        </div>

        <div className="pr-body">
          <div className="pr-keys">
            {pitches.map((p) => (
              <div key={p} className={`pr-key ${isBlack(p) ? "black" : "white"}`} style={{ height: ROW_H }}>
                {p % 12 === 0 && <span>{noteName(p)}</span>}
              </div>
            ))}
          </div>
          <div className="pr-scroll">
            <div
              className="pr-grid"
              style={{ width: gridW, height: pitches.length * ROW_H }}
              onPointerDown={addAt}
              onPointerMove={onMove}
              onPointerUp={onUp}
            >
              {/* row shading */}
              {pitches.map((p) => (
                <div key={`r${p}`} className={`pr-row ${isBlack(p) ? "black" : ""}`} style={{ top: yOf(p), height: ROW_H }} />
              ))}
              {/* beat / bar gridlines */}
              {Array.from({ length: gridBeats + 1 }, (_, b) => (
                <div key={`c${b}`} className={`pr-gl ${b % m.num === 0 ? "bar" : ""}`} style={{ left: b * BEAT_PX }} />
              ))}
              {/* notes */}
              {notes.map((n) => (
                <div
                  key={n.i}
                  className={`pr-note ${sel === n.i ? "sel" : ""}`}
                  style={{ left: n.start * BEAT_PX, top: yOf(n.pitch) + 1, width: Math.max(6, n.length * BEAT_PX - 1), height: ROW_H - 2 }}
                  onPointerDown={onNoteDown("move", n)}
                  onPointerMove={onMove}
                  onPointerUp={onUp}
                  onDoubleClick={(e) => { e.stopPropagation(); void exec("remove_note", { clipId: clip.id, noteIndex: n.i }); }}
                  title={`${noteName(n.pitch)} · vel ${n.velocity} · dbl-click to delete`}
                >
                  <span className="pr-note-grip" onPointerDown={onNoteDown("resize", n)} />
                </div>
              ))}
            </div>
          </div>
        </div>
        <div className="pr-foot">click empty space to add · drag to move · drag right edge to resize · double-click to delete</div>
      </div>
    </div>
  );
}
