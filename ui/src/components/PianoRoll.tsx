import { useEffect, useMemo, useRef, useState } from "react";
import { useStore } from "../store";
import type { Snapshot, Note, Track, Clip } from "../types";

// The piano roll (Stage 16) — OpenUtau-inspired: rounded note rects with a
// text label on each note (pad name on rack tracks, pitch name otherwise),
// piano keyboard on the left, musical grid, velocity lane at the bottom.
// Every edit is a MoshOps command: add_notes (draw), update_notes
// (move/resize/velocity — ONE undo step per gesture), remove_notes (delete).

const ROW_H = 14;
const KEY_W = 64;
const VEL_H = 44;
const NAMES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];
const BLACK = new Set([1, 3, 6, 8, 10]);
const pitchName = (p: number) => `${NAMES[p % 12]}${Math.floor(p / 12) - 1}`;

type Drag =
  | { kind: "move" | "resize"; key: string; orig: Note; startX: number; startY: number }
  | { kind: "vel"; key: string; orig: Note }
  | null;

const noteKey = (n: Note) => `${n.pitch}:${n.startBeats.toFixed(4)}`;

export function PianoRoll({ snapshot }: { snapshot: Snapshot }) {
  const editingClipId = useStore((s) => s.editingClipId);
  const setEditingClip = useStore((s) => s.setEditingClip);
  const exec = useStore((s) => s.exec);
  const secsPerBeat = useStore((s) => s.secsPerBeat);
  const beatsPerBar = useStore((s) => s.beatsPerBar);
  const snapSeconds = useStore((s) => s.snapSeconds);
  const snapOn = useStore((s) => s.snap);

  let clip: Clip | null = null;
  let track: Track | null = null;
  for (const tr of snapshot.tracks)
    for (const c of tr.clips)
      if (c.id === editingClipId) {
        clip = c;
        track = tr;
      }

  const [pxPerBeat, setPxPerBeat] = useState(64);
  const [selected, setSelected] = useState<string | null>(null);
  const [preview, setPreview] = useState<Record<string, Note>>({});
  const dragRef = useRef<Drag>(null);
  const gridRef = useRef<HTMLDivElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  // Clear optimistic previews when the snapshot catches up.
  const notesSig = clip ? JSON.stringify(clip.notes ?? []) : "";
  useEffect(() => setPreview({}), [notesSig]);

  // Esc closes; Delete removes the selected note (the global clip-delete
  // defers to us while the editor is open).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement;
      if (t.tagName === "INPUT" || t.tagName === "TEXTAREA") return;
      if (e.key === "Escape") setEditingClip(null);
      if ((e.key === "Backspace" || e.key === "Delete") && selected && clip) {
        e.preventDefault();
        const n = displayNotes.find((d) => noteKey(d.base) === selected)?.cur;
        if (n)
          void exec("remove_notes", {
            clipId: clip.id,
            pitches: [n.pitch],
            rangeStartBeats: n.startBeats - 0.001,
            rangeLengthBeats: 0.002,
          });
        setSelected(null);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  // Pitch range + initial scroll. Hooks above any early return.
  const notes = useMemo<Note[]>(() => clip?.notes ?? [], [clip]);
  const lo = Math.max(0, Math.min(...(notes.length ? notes.map((n) => n.pitch) : [48])) - 5);
  const hi = Math.min(127, Math.max(...(notes.length ? notes.map((n) => n.pitch) : [72])) + 5);
  const rows = hi - lo + 1;
  useEffect(() => {
    scrollRef.current?.scrollTo({ top: Math.max(0, ((hi - (lo + hi) / 2) * ROW_H) - 80) });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editingClipId]);

  const displayNotes = useMemo(
    () => notes.map((n) => ({ base: n, cur: preview[noteKey(n)] ?? n })),
    [notes, preview],
  );

  if (!clip || !track) {
    if (editingClipId) setTimeout(() => setEditingClip(null), 0);
    return null;
  }
  const theClip = clip;

  const spb = secsPerBeat();
  const clipBeats = Math.max(1, Math.round((theClip.length / spb) * 4) / 4);
  const snapBeats = Math.max(1 / 12, snapOn ? snapSeconds() / spb : 1 / 16);
  const width = clipBeats * pxPerBeat;
  const bpb = beatsPerBar();

  // Pad names from the track's sampler — the OpenUtau lyric-style labels.
  const padName: Record<number, string> = {};
  for (const p of track.plugins ?? [])
    for (const snd of p.sounds ?? [])
      padName[snd.keyNote] = snd.name;

  const snapTo = (b: number) => (snapOn ? Math.round(b / snapBeats) * snapBeats : b);
  const yToPitch = (y: number) => hi - Math.floor(y / ROW_H);
  const label = (p: number) => padName[p] ?? pitchName(p);

  const commitNote = (orig: Note, cur: Note) => {
    if (
      orig.pitch === cur.pitch &&
      Math.abs(orig.startBeats - cur.startBeats) < 1e-4 &&
      Math.abs(orig.durBeats - cur.durBeats) < 1e-4 &&
      orig.vel === cur.vel
    )
      return;
    void exec("update_notes", {
      clipId: theClip.id,
      edits: [
        {
          match: { pitch: orig.pitch, startBeats: orig.startBeats },
          set: { pitch: cur.pitch, startBeats: cur.startBeats, durBeats: cur.durBeats, vel: cur.vel },
        },
      ],
    });
  };

  // Draw a note on the empty grid.
  const onGridDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (e.target !== gridRef.current || e.button !== 0) return;
    const rect = gridRef.current.getBoundingClientRect();
    const beat = snapTo((e.clientX - rect.left) / pxPerBeat);
    const pitch = yToPitch(e.clientY - rect.top);
    if (beat >= clipBeats || pitch < lo || pitch > hi) return;
    void exec("add_notes", {
      clipId: theClip.id,
      notes: [{ pitch, startBeats: beat, durBeats: snapBeats, vel: 100 }],
    });
    setSelected(`${pitch}:${beat.toFixed(4)}`);
  };

  const onNoteDown = (kind: "move" | "resize", d: { base: Note; cur: Note }) =>
    (e: React.PointerEvent) => {
      e.stopPropagation();
      if (e.button === 2) return;
      setSelected(noteKey(d.base));
      (e.target as HTMLElement).setPointerCapture(e.pointerId);
      dragRef.current = { kind, key: noteKey(d.base), orig: d.cur, startX: e.clientX, startY: e.clientY };
    };

  const onPointerMove = (e: React.PointerEvent) => {
    const d = dragRef.current;
    if (!d || d.kind === "vel") return;
    const db = (e.clientX - d.startX) / pxPerBeat;
    if (d.kind === "move") {
      const dRows = Math.round((e.clientY - d.startY) / ROW_H);
      const startBeats = Math.max(0, Math.min(clipBeats - d.orig.durBeats, snapTo(d.orig.startBeats + db)));
      const pitch = Math.max(0, Math.min(127, d.orig.pitch - dRows));
      setPreview((p) => ({ ...p, [d.key]: { ...d.orig, startBeats, pitch } }));
    } else {
      const durBeats = Math.max(snapBeats / 2, snapTo(d.orig.durBeats + db));
      setPreview((p) => ({ ...p, [d.key]: { ...d.orig, durBeats } }));
    }
  };

  const onPointerUp = () => {
    const d = dragRef.current;
    dragRef.current = null;
    if (!d || d.kind === "vel") return;
    const cur = preview[d.key];
    const base = notes.find((n) => noteKey(n) === d.key);
    if (cur && base) commitNote(base, cur);
  };

  const removeNote = (n: Note) =>
    void exec("remove_notes", {
      clipId: theClip.id,
      pitches: [n.pitch],
      rangeStartBeats: n.startBeats - 0.001,
      rangeLengthBeats: 0.002,
    });

  return (
    <div className="pianoroll">
      <div className="pr-head">
        <span className="pr-title">
          piano roll · <b>{theClip.name}</b> <span className="pr-track">({track.name})</span>
        </span>
        <button className="mini" onClick={() => setPxPerBeat(Math.max(24, pxPerBeat / 1.3))}>−</button>
        <button className="mini" onClick={() => setPxPerBeat(Math.min(220, pxPerBeat * 1.3))}>+</button>
        <span className="pr-hint">drag: draw · note: move · edge: resize · right-click: delete · esc: close</span>
        <button className="mini" onClick={() => setEditingClip(null)}>✕</button>
      </div>
      <div className="pr-scroll" ref={scrollRef}>
        <div className="pr-body" style={{ width: KEY_W + width, height: rows * ROW_H }}>
          {/* keyboard */}
          <div className="pr-keys" style={{ width: KEY_W }}>
            {Array.from({ length: rows }, (_, i) => {
              const p = hi - i;
              const black = BLACK.has(p % 12);
              return (
                <div key={p} className={`pr-key ${black ? "black" : ""}`} style={{ top: i * ROW_H, height: ROW_H }}>
                  {(padName[p] || p % 12 === 0) && (
                    <span className={padName[p] ? "pr-padname" : ""}>
                      {padName[p] ? padName[p].slice(0, 9) : pitchName(p)}
                    </span>
                  )}
                </div>
              );
            })}
          </div>
          {/* grid + notes */}
          <div
            className="pr-grid"
            ref={gridRef}
            style={{
              left: KEY_W,
              width,
              height: rows * ROW_H,
              backgroundImage:
                `repeating-linear-gradient(0deg, var(--grid-beat) 0 1px, transparent 1px ${ROW_H}px),` +
                `repeating-linear-gradient(90deg, var(--grid-beat) 0 1px, transparent 1px ${snapBeats * pxPerBeat}px),` +
                `repeating-linear-gradient(90deg, var(--grid-bar) 0 1px, transparent 1px ${pxPerBeat}px),` +
                `repeating-linear-gradient(90deg, var(--muted) 0 1px, transparent 1px ${bpb * pxPerBeat}px)`,
            }}
            onPointerDown={onGridDown}
            onPointerMove={onPointerMove}
            onPointerUp={onPointerUp}
          >
            {/* black-key row shading */}
            {Array.from({ length: rows }, (_, i) =>
              BLACK.has((hi - i) % 12) ? (
                <div key={i} className="pr-rowshade" style={{ top: i * ROW_H, height: ROW_H }} />
              ) : null,
            )}
            {displayNotes.map((d) => {
              const k = noteKey(d.base);
              const n = d.cur;
              return (
                <div
                  key={k}
                  className={`pr-note ${selected === k ? "sel" : ""}`}
                  style={{
                    left: n.startBeats * pxPerBeat,
                    width: Math.max(6, n.durBeats * pxPerBeat - 1),
                    top: (hi - n.pitch) * ROW_H + 1,
                    height: ROW_H - 2,
                    opacity: 0.55 + 0.45 * Math.min(1, n.vel / 127),
                  }}
                  onPointerDown={onNoteDown("move", d)}
                  onPointerMove={onPointerMove}
                  onPointerUp={onPointerUp}
                  onContextMenu={(e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    removeNote(n);
                  }}
                  title={`${label(n.pitch)} · ${n.startBeats}b · ${n.durBeats}b · v${n.vel}`}
                >
                  <span className="pr-lyric">{label(n.pitch)}</span>
                  <span className="pr-resize" onPointerDown={onNoteDown("resize", d)} />
                </div>
              );
            })}
          </div>
        </div>
      </div>
      {/* velocity lane */}
      <div className="pr-vel" style={{ height: VEL_H }}>
        <span className="pr-vel-label">vel</span>
        <div className="pr-vel-lane" style={{ width, marginLeft: KEY_W }}>
          {displayNotes.map((d) => {
            const k = noteKey(d.base);
            const n = d.cur;
            return (
              <div
                key={k}
                className={`pr-velbar ${selected === k ? "sel" : ""}`}
                style={{ left: n.startBeats * pxPerBeat, height: `${(n.vel / 127) * 100}%` }}
                onPointerDown={(e) => {
                  e.stopPropagation();
                  setSelected(k);
                  (e.target as HTMLElement).setPointerCapture(e.pointerId);
                  dragRef.current = { kind: "vel", key: k, orig: n };
                }}
                onPointerMove={(e) => {
                  const d2 = dragRef.current;
                  if (!d2 || d2.kind !== "vel") return;
                  const lane = (e.currentTarget.parentElement as HTMLElement).getBoundingClientRect();
                  const vel = Math.max(1, Math.min(127, Math.round((1 - (e.clientY - lane.top) / lane.height) * 127)));
                  setPreview((p) => ({ ...p, [d2.key]: { ...d2.orig, vel } }));
                }}
                onPointerUp={() => {
                  const d2 = dragRef.current;
                  dragRef.current = null;
                  if (!d2 || d2.kind !== "vel") return;
                  const cur = preview[d2.key];
                  const base = notes.find((nn) => noteKey(nn) === d2.key);
                  if (cur && base) commitNote(base, cur);
                }}
              />
            );
          })}
        </div>
      </div>
    </div>
  );
}
