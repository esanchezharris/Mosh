import { useEffect, useMemo, useRef, useState } from "react";
import { useStore } from "../store";
import type { Snapshot, Note, Track, Clip, CommandResult } from "../types";

// The piano roll (Stage 16, v2 in Stage 20) — OpenUtau-inspired: labeled note
// rects, left keyboard, musical grid, velocity lane. v2 adds multi-select
// (shift-click + marquee), batch move/delete (update_notes takes N edits in
// ONE undo step), a quantize/humanize/transpose toolbar, and REAL 808 slides:
// the engine's sampler ignores pitch bend, so a slide is a pitchshift plugin
// automated along the note tail — continuous pitch, not steps.

const ROW_H = 14;
const KEY_W = 64;
const VEL_H = 44;
const NAMES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];
const BLACK = new Set([1, 3, 6, 8, 10]);
const pitchName = (p: number) => `${NAMES[p % 12]}${Math.floor(p / 12) - 1}`;

type Drag =
  | { kind: "move" | "resize"; key: string; startX: number; startY: number; origs: Record<string, Note> }
  | { kind: "vel"; key: string; orig: Note }
  | { kind: "marquee"; x0: number; y0: number; x1: number; y1: number }
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
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [preview, setPreview] = useState<Record<string, Note>>({});
  const [marquee, setMarquee] = useState<{ x0: number; y0: number; x1: number; y1: number } | null>(null);
  const dragRef = useRef<Drag>(null);
  const gridRef = useRef<HTMLDivElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  // Clear optimistic previews when the snapshot catches up.
  const notesSig = clip ? JSON.stringify(clip.notes ?? []) : "";
  useEffect(() => {
    setPreview({});
  }, [notesSig]);

  const notes = useMemo<Note[]>(() => clip?.notes ?? [], [clip]);
  const lo = Math.max(0, Math.min(...(notes.length ? notes.map((n) => n.pitch) : [48])) - 5);
  const hi = Math.min(127, Math.max(...(notes.length ? notes.map((n) => n.pitch) : [72])) + 5);
  const rows = hi - lo + 1;
  useEffect(() => {
    scrollRef.current?.scrollTo({ top: Math.max(0, (hi - (lo + hi) / 2) * ROW_H - 80) });
    setSelected(new Set());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editingClipId]);

  const displayNotes = useMemo(
    () => notes.map((n) => ({ base: n, cur: preview[noteKey(n)] ?? n })),
    [notes, preview],
  );

  // Keys: Esc closes, ⌫ deletes the selection (batched per pitch).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement;
      if (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.tagName === "SELECT") return;
      if (e.key === "Escape") setEditingClip(null);
      if ((e.key === "Backspace" || e.key === "Delete") && selected.size && clip) {
        e.preventDefault();
        for (const d of displayNotes)
          if (selected.has(noteKey(d.base)))
            void exec("remove_notes", {
              clipId: clip.id,
              pitches: [d.cur.pitch],
              rangeStartBeats: d.cur.startBeats - 0.001,
              rangeLengthBeats: 0.002,
            });
        setSelected(new Set());
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  if (!clip || !track) {
    if (editingClipId) setTimeout(() => setEditingClip(null), 0);
    return null;
  }
  const theClip = clip;
  const theTrack = track;

  const spb = secsPerBeat();
  const clipBeats = Math.max(1, Math.round((theClip.length / spb) * 4) / 4);
  const snapBeats = Math.max(1 / 12, snapOn ? snapSeconds() / spb : 1 / 16);
  const width = clipBeats * pxPerBeat;
  const bpb = beatsPerBar();

  const padName: Record<number, string> = {};
  for (const p of theTrack.plugins ?? [])
    for (const snd of p.sounds ?? [])
      padName[snd.keyNote] = snd.name;

  const snapTo = (b: number) => (snapOn ? Math.round(b / snapBeats) * snapBeats : b);
  const yToPitch = (y: number) => hi - Math.floor(y / ROW_H);
  const label = (p: number) => padName[p] ?? pitchName(p);

  const commitMoved = (origs: Record<string, Note>) => {
    const edits = Object.entries(origs)
      .map(([key, orig]) => {
        const cur = preview[key];
        if (!cur) return null;
        if (
          orig.pitch === cur.pitch &&
          Math.abs(orig.startBeats - cur.startBeats) < 1e-4 &&
          Math.abs(orig.durBeats - cur.durBeats) < 1e-4 &&
          orig.vel === cur.vel
        )
          return null;
        return {
          match: { pitch: orig.pitch, startBeats: orig.startBeats },
          set: { pitch: cur.pitch, startBeats: cur.startBeats, durBeats: cur.durBeats, vel: cur.vel },
        };
      })
      .filter(Boolean);
    if (edits.length) void exec("update_notes", { clipId: theClip.id, edits });
  };

  // Empty grid: click draws a note; drag sweeps a marquee selection.
  const onGridDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (e.target !== gridRef.current || e.button !== 0) return;
    const rect = gridRef.current.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
    dragRef.current = { kind: "marquee", x0: x, y0: y, x1: x, y1: y };
  };

  const onPointerMove = (e: React.PointerEvent) => {
    const d = dragRef.current;
    if (!d || d.kind === "vel") return;
    if (d.kind === "marquee") {
      const rect = gridRef.current!.getBoundingClientRect();
      d.x1 = e.clientX - rect.left;
      d.y1 = e.clientY - rect.top;
      setMarquee({ ...d });
      return;
    }
    const db = (e.clientX - d.startX) / pxPerBeat;
    const next: Record<string, Note> = {};
    if (d.kind === "move") {
      const dRows = Math.round((e.clientY - d.startY) / ROW_H);
      for (const [key, orig] of Object.entries(d.origs)) {
        const startBeats = Math.max(0, Math.min(clipBeats - orig.durBeats, snapTo(orig.startBeats + db)));
        const pitch = Math.max(0, Math.min(127, orig.pitch - dRows));
        next[key] = { ...orig, startBeats, pitch };
      }
    } else {
      for (const [key, orig] of Object.entries(d.origs))
        next[key] = { ...orig, durBeats: Math.max(snapBeats / 2, snapTo(orig.durBeats + db)) };
    }
    setPreview((p) => ({ ...p, ...next }));
  };

  const onPointerUp = (e: React.PointerEvent) => {
    const d = dragRef.current;
    dragRef.current = null;
    if (!d) return;
    if (d.kind === "marquee") {
      setMarquee(null);
      const moved = Math.abs(d.x1 - d.x0) > 4 || Math.abs(d.y1 - d.y0) > 4;
      if (!moved) {
        // a plain click: draw a note
        const beat = snapTo(d.x0 / pxPerBeat);
        const pitch = yToPitch(d.y0);
        if (beat < clipBeats && pitch >= lo && pitch <= hi) {
          void exec("add_notes", {
            clipId: theClip.id,
            notes: [{ pitch, startBeats: beat, durBeats: snapBeats, vel: 100 }],
          });
          setSelected(new Set([`${pitch}:${beat.toFixed(4)}`]));
        }
      } else {
        const [xMin, xMax] = [Math.min(d.x0, d.x1), Math.max(d.x0, d.x1)];
        const [yMin, yMax] = [Math.min(d.y0, d.y1), Math.max(d.y0, d.y1)];
        const hit = new Set<string>();
        for (const dn of displayNotes) {
          const nx = dn.cur.startBeats * pxPerBeat;
          const nw = dn.cur.durBeats * pxPerBeat;
          const ny = (hi - dn.cur.pitch) * ROW_H;
          if (nx + nw >= xMin && nx <= xMax && ny + ROW_H >= yMin && ny <= yMax) hit.add(noteKey(dn.base));
        }
        setSelected(e.shiftKey ? new Set([...selected, ...hit]) : hit);
      }
      return;
    }
    if (d.kind === "vel") return;
    commitMoved(d.origs);
  };

  const onNoteDown = (kind: "move" | "resize", dn: { base: Note; cur: Note }) =>
    (e: React.PointerEvent) => {
      e.stopPropagation();
      if (e.button === 2) return;
      const key = noteKey(dn.base);
      let sel = selected;
      if (e.shiftKey) {
        sel = new Set(selected);
        if (sel.has(key)) sel.delete(key);
        else sel.add(key);
      } else if (!selected.has(key)) {
        sel = new Set([key]);
      }
      setSelected(sel);
      const origs: Record<string, Note> = {};
      for (const d2 of displayNotes) if (sel.has(noteKey(d2.base))) origs[noteKey(d2.base)] = d2.cur;
      (e.target as HTMLElement).setPointerCapture(e.pointerId);
      dragRef.current = { kind, key, startX: e.clientX, startY: e.clientY, origs };
    };

  const removeNote = (n: Note) =>
    void exec("remove_notes", {
      clipId: theClip.id,
      pitches: [n.pitch],
      rangeStartBeats: n.startBeats - 0.001,
      rangeLengthBeats: 0.002,
    });

  // ── v2 toolbar actions ──
  const quantize = () => void exec("quantize_notes", { clipId: theClip.id, grid: "1/16", strength: 1.0 });
  const humanize = () =>
    void exec("humanize_notes", {
      clipId: theClip.id,
      timingBeats: 0.02,
      velVar: 8,
      seed: Math.floor(Math.random() * 900000) + 1,
    });
  const transpose = (semis: number) => void exec("transpose_notes", { clipId: theClip.id, semitones: semis });

  // REAL slide (Stage 20): automate a pitchshift plugin along the selected
  // note's tail — continuous pitch into the target, snapping back after.
  const slide = async (semis: number) => {
    if (selected.size !== 1 || semis === 0) return;
    const dn = displayNotes.find((d) => selected.has(noteKey(d.base)));
    if (!dn) return;
    let ps = (theTrack.plugins ?? []).find((p) => p.type === "pitchShifter" || p.type === "pitchshift");
    if (!ps) {
      const res = (await exec("load_builtin_plugin", { trackId: theTrack.id, type: "pitchshift" })) as CommandResult<{ index: number }>;
      if (!res.ok || !res.data) return;
      ps = { index: res.data.index } as never;
    }
    const clipStartBeats = theClip.start / spb;
    const n = dn.cur;
    const startB = clipStartBeats + n.startBeats;
    const endB = clipStartBeats + n.startBeats + n.durBeats;
    const center = 0.5; // pitchshift "semitones" normalized center (±24 range)
    const target = Math.max(0, Math.min(1, 0.5 + semis / 48));
    void exec("write_automation", {
      trackId: theTrack.id,
      pluginIndex: (ps as { index: number }).index,
      paramName: "semitone",
      points: [
        { beats: 0, value: center },
        { beats: startB, value: center },
        { beats: endB, value: target, curve: 0.3 },
        { beats: endB + 0.01, value: center },
      ],
    });
  };

  const root = (
    <div className="pianoroll">
      <div className="pr-head">
        <span className="pr-title">
          piano roll · <b>{theClip.name}</b> <span className="pr-track">({theTrack.name})</span>
        </span>
        <button className="mini" onClick={() => setPxPerBeat(Math.max(24, pxPerBeat / 1.3))}>−</button>
        <button className="mini" onClick={() => setPxPerBeat(Math.min(220, pxPerBeat * 1.3))}>+</button>
        <span className="pr-sep" />
        <button className="pr-tool" onClick={quantize} title="Quantize the clip to 1/16">Q</button>
        <button className="pr-tool" onClick={humanize} title="Humanize (seeded ±20ms, ±8 vel)">H</button>
        <button className="pr-tool" onClick={() => transpose(-12)} title="Octave down">-12</button>
        <button className="pr-tool" onClick={() => transpose(-1)} title="Semitone down">-1</button>
        <button className="pr-tool" onClick={() => transpose(1)} title="Semitone up">+1</button>
        <button className="pr-tool" onClick={() => transpose(12)} title="Octave up">+12</button>
        <select
          className="pr-tool pr-slide"
          value=""
          disabled={selected.size !== 1}
          title={selected.size === 1
            ? "Slide the selected note — REAL continuous pitch (automated pitchshift)"
            : "Select exactly one note to slide"}
          onChange={(e) => {
            if (e.target.value) void slide(Number(e.target.value));
            e.target.value = "";
          }}
        >
          <option value="" disabled>slide…</option>
          {[-12, -7, -5, -3, -2, 2, 3, 5, 7, 12].map((s) => (
            <option key={s} value={s}>{s > 0 ? `+${s}` : s} st</option>
          ))}
        </select>
        <span className="pr-hint">click: draw · drag: select · shift: multi · ⌫: delete · esc: close</span>
        <button className="mini" onClick={() => setEditingClip(null)}>✕</button>
      </div>
      <div className="pr-scroll" ref={scrollRef}>
        <div className="pr-body" style={{ width: KEY_W + width, height: rows * ROW_H }}>
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
                  className={`pr-note ${selected.has(k) ? "sel" : ""}`}
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
            {marquee && (
              <div
                className="marquee"
                style={{
                  left: Math.min(marquee.x0, marquee.x1),
                  top: Math.min(marquee.y0, marquee.y1),
                  width: Math.abs(marquee.x1 - marquee.x0),
                  height: Math.abs(marquee.y1 - marquee.y0),
                }}
              />
            )}
          </div>
        </div>
      </div>
      <div className="pr-vel" style={{ height: VEL_H }}>
        <span className="pr-vel-label">vel</span>
        <div className="pr-vel-lane" style={{ width, marginLeft: KEY_W }}>
          {displayNotes.map((d) => {
            const k = noteKey(d.base);
            const n = d.cur;
            return (
              <div
                key={k}
                className={`pr-velbar ${selected.has(k) ? "sel" : ""}`}
                style={{ left: n.startBeats * pxPerBeat, height: `${(n.vel / 127) * 100}%` }}
                onPointerDown={(e) => {
                  e.stopPropagation();
                  setSelected(new Set([k]));
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
                  if (cur && base)
                    void exec("update_notes", {
                      clipId: theClip.id,
                      edits: [{ match: { pitch: base.pitch, startBeats: base.startBeats }, set: { vel: cur.vel } }],
                    });
                }}
              />
            );
          })}
        </div>
      </div>
    </div>
  );
  return root;
}
