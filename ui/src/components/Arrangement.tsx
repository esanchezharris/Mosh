import { useRef, useState } from "react";
import { useStore, SNAP_DIVS, type SnapDiv } from "../store";
import type { Snapshot, Track } from "../types";
import { Clip } from "./Clip";

const LANE_H = 84;
const RULER_SECONDS = 48;

// Musical ruler ticks (Stage 14): bars always; beats and 16ths appear as zoom
// allows. Everything is derived from the snapshot's tempo/time-sig — the
// second-based ruler never matched a 160 BPM session.
function rulerTicks(pxPerSec: number, spb: number, bpb: number) {
  const barSec = spb * bpb;
  const pxPerBar = barSec * pxPerSec;
  const showBeats = pxPerBar > 64;
  const showSixteenths = spb * pxPerSec > 56;
  const ticks: { left: number; kind: "bar" | "beat" | "sub"; label?: string }[] = [];
  const totalBars = Math.ceil(RULER_SECONDS / barSec);
  for (let b = 0; b < totalBars; b++) {
    ticks.push({ left: b * pxPerBar, kind: "bar", label: String(b + 1) });
    if (!showBeats) continue;
    for (let k = 0; k < bpb; k++) {
      if (k > 0) ticks.push({ left: (b * bpb + k) * spb * pxPerSec, kind: "beat" });
      if (!showSixteenths) continue;
      for (let s = 1; s < 4; s++)
        ticks.push({ left: (b * bpb + k + s / 4) * spb * pxPerSec, kind: "sub" });
    }
  }
  return ticks;
}

export function Arrangement({ snapshot }: { snapshot: Snapshot }) {
  const pxPerSec = useStore((s) => s.pxPerSec);
  const exec = useStore((s) => s.exec);
  const clearSelection = useStore((s) => s.clearSelection);
  const select = useStore((s) => s.select);
  const secsPerBeat = useStore((s) => s.secsPerBeat);
  const beatsPerBar = useStore((s) => s.beatsPerBar);
  const t = snapshot.transport;
  const spb = secsPerBeat();
  const bpb = beatsPerBar();
  const ticks = rulerTicks(pxPerSec, spb, bpb);
  const barPx = spb * bpb * pxPerSec;
  const beatPx = spb * pxPerSec;
  const lanesRef = useRef<HTMLDivElement>(null);
  const [marquee, setMarquee] = useState<{ x0: number; y0: number; x1: number; y1: number } | null>(null);
  const loopDrag = useRef<number | null>(null);

  const seekRuler = (e: React.MouseEvent, el: Element) => {
    const rect = el.getBoundingClientRect();
    void exec("set_transport", { position: Math.max(0, (e.clientX - rect.left) / pxPerSec) });
  };

  // Shift-drag the ruler → loop region.
  const onRulerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const sec = Math.max(0, (e.clientX - rect.left) / pxPerSec);
    if (e.shiftKey) {
      loopDrag.current = sec;
      e.currentTarget.setPointerCapture(e.pointerId);
    } else {
      seekRuler(e, e.currentTarget);
    }
  };
  const onRulerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    if (loopDrag.current == null) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const sec = Math.max(0, (e.clientX - rect.left) / pxPerSec);
    const a = Math.min(loopDrag.current, sec);
    const b = Math.max(loopDrag.current, sec);
    void exec("set_transport", { loop: true, loopStart: a, loopEnd: b });
  };
  const onRulerUp = () => (loopDrag.current = null);

  // Marquee selection on the lanes background.
  const onLanesDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (e.target !== lanesRef.current) return; // only empty background
    clearSelection();
    const rect = lanesRef.current!.getBoundingClientRect();
    setMarquee({ x0: e.clientX - rect.left, y0: e.clientY - rect.top, x1: e.clientX - rect.left, y1: e.clientY - rect.top });
    lanesRef.current!.setPointerCapture(e.pointerId);
  };
  const onLanesMove = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!marquee) return;
    const rect = lanesRef.current!.getBoundingClientRect();
    setMarquee({ ...marquee, x1: e.clientX - rect.left, y1: e.clientY - rect.top });
  };
  const onLanesUp = () => {
    if (!marquee) return;
    const xMin = Math.min(marquee.x0, marquee.x1);
    const xMax = Math.max(marquee.x0, marquee.x1);
    const yMin = Math.min(marquee.y0, marquee.y1);
    const yMax = Math.max(marquee.y0, marquee.y1);
    const hit: string[] = [];
    snapshot.tracks.forEach((tr, row) => {
      const top = row * LANE_H;
      if (top + LANE_H < yMin || top > yMax) return;
      for (const c of tr.clips) {
        const cl = c.start * pxPerSec;
        const cr = (c.start + c.length) * pxPerSec;
        if (cr >= xMin && cl <= xMax) hit.push(c.id);
      }
    });
    select(hit, false);
    setMarquee(null);
  };

  return (
    <div className="arrange">
      <Toolbar />
      <div className="timeline">
        <div className="tl-head">
          <div className="lane-gutter">tracks</div>
          <div
            className="ruler"
            style={{ width: RULER_SECONDS * pxPerSec }}
            onClick={(e) => !e.shiftKey && seekRuler(e, e.currentTarget)}
            onPointerDown={onRulerDown}
            onPointerMove={onRulerMove}
            onPointerUp={onRulerUp}
          >
            {ticks.map((tk, i) => (
              <div className={`tick ${tk.kind}`} key={i} style={{ left: tk.left }}>
                {tk.label && <span>{tk.label}</span>}
              </div>
            ))}
            {t.looping && t.loopEnd > t.loopStart && (
              <div
                className="loopregion"
                style={{ left: t.loopStart * pxPerSec, width: (t.loopEnd - t.loopStart) * pxPerSec }}
              />
            )}
            <div className="playhead" style={{ left: t.position * pxPerSec }} />
          </div>
        </div>

        <div className="tl-body">
          <div className="heads">
            {snapshot.tracks.map((tr) => (
              <TrackHeader key={tr.id} track={tr} />
            ))}
          </div>
          <div
            className="lanes"
            ref={lanesRef}
            style={{
              width: RULER_SECONDS * pxPerSec,
              height: Math.max(LANE_H, snapshot.tracks.length * LANE_H),
              // Tempo-true vertical grid: faint beats, stronger bars.
              backgroundImage:
                `repeating-linear-gradient(90deg, var(--grid-beat) 0 1px, transparent 1px ${beatPx}px),` +
                `repeating-linear-gradient(90deg, var(--grid-bar) 0 1px, transparent 1px ${barPx}px)`,
            }}
            onPointerDown={onLanesDown}
            onPointerMove={onLanesMove}
            onPointerUp={onLanesUp}
          >
            {snapshot.tracks.length === 0 && (
              <div className="empty-hint">No tracks yet — add a track or drop in a test tone.</div>
            )}
            {snapshot.tracks.map((tr, row) => (
              <div className="lane" key={tr.id} style={{ top: row * LANE_H, height: LANE_H }}>
                {tr.clips.map((c) => (
                  <Clip key={c.id} clip={c} />
                ))}
              </div>
            ))}
            <div className="playhead lane-ph" style={{ left: t.position * pxPerSec, height: Math.max(LANE_H, snapshot.tracks.length * LANE_H) }} />
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
    </div>
  );
}

function Toolbar() {
  const exec = useStore((s) => s.exec);
  const tool = useStore((s) => s.tool);
  const setTool = useStore((s) => s.setTool);
  const snap = useStore((s) => s.snap);
  const setSnap = useStore((s) => s.setSnap);
  const snapDiv = useStore((s) => s.snapDiv);
  const setSnapDiv = useStore((s) => s.setSnapDiv);
  const pxPerSec = useStore((s) => s.pxPerSec);
  const setPxPerSec = useStore((s) => s.setPxPerSec);

  return (
    <div className="toolbar">
      <button onClick={() => exec("create_track", {})}>+ Track</button>
      <button onClick={() => exec("add_test_tone_clip", { seconds: 2, freq: 220 })}>+ Test Tone</button>
      <button onClick={() => exec("add_midi_clip", {})}>+ MIDI</button>
      <span className="sep" />
      <button className={tool === "move" ? "on" : ""} onClick={() => setTool("move")}>Move</button>
      <button className={tool === "split" ? "on" : ""} onClick={() => setTool("split")}>Split</button>
      <button className={snap ? "on" : ""} onClick={() => setSnap(!snap)}>Snap</button>
      <select
        className="snap-div"
        value={snapDiv}
        onChange={(e) => setSnapDiv(e.target.value as SnapDiv)}
        title="Snap grid (musical)"
      >
        {SNAP_DIVS.map((d) => (
          <option key={d} value={d}>{d}</option>
        ))}
      </select>
      <span className="sep" />
      <button onClick={() => setPxPerSec(pxPerSec / 1.4)}>Zoom −</button>
      <button onClick={() => setPxPerSec(pxPerSec * 1.4)}>Zoom +</button>
      <span className="sep" />
      <button onClick={() => exec("undo", {})}>↶ Undo</button>
      <button onClick={() => exec("redo", {})}>↷ Redo</button>
      <span className="sep" />
      <button onClick={() => exec("save", {})}>Save</button>
      <button onClick={() => exec("reload", {})}>Reload</button>
    </div>
  );
}

function TrackHeader({ track }: { track: Track }) {
  const exec = useStore((s) => s.exec);
  const selectedTrackId = useStore((s) => s.selectedTrackId);
  const setSelectedTrack = useStore((s) => s.setSelectedTrack);
  const level = useStore((s) => s.snapshot?.transport.levels?.tracks?.[track.id]);
  const fxCount = (track.plugins ?? []).filter((p) => p.external || p.neural).length;
  const db = level ? Math.max(level[0], level[1]) : -100;
  const meterPct = Math.max(0, Math.min(1, (db + 60) / 60)) * 100;
  return (
    <div
      className={`track-head ${selectedTrackId === track.id ? "sel" : ""}`}
      style={{ height: LANE_H }}
      onPointerDown={() => setSelectedTrack(track.id)}
    >
      <div className="th-row">
        <span className="track-name">{track.name || `Track ${track.index + 1}`}</span>
        {fxCount > 0 && <span className="fx-count">{fxCount} fx</span>}
        <button className="mini" title="Remove" onClick={(e) => { e.stopPropagation(); exec("remove_track", { trackId: track.id }); }}>✕</button>
      </div>
      <div className="th-row">
        <button
          className={`mixbtn ${track.mute ? "mute-on" : ""}`}
          onClick={() => exec("set_track_mute", { trackId: track.id, mute: !track.mute })}
        >M</button>
        <button
          className={`mixbtn ${track.solo ? "solo-on" : ""}`}
          onClick={() => exec("set_track_solo", { trackId: track.id, solo: !track.solo })}
        >S</button>
        <input
          className="vol"
          type="range"
          min={-48}
          max={6}
          step={0.5}
          value={track.volumeDb ?? 0}
          onChange={(e) => exec("set_track_volume", { trackId: track.id, db: Number(e.target.value) })}
        />
      </div>
      {/* Engine-output meter (Stage 14) — fed by the 30 Hz transport event. */}
      <div className="tmeter">
        <span
          className={db > -1 ? "hot" : db > -9 ? "warm" : ""}
          style={{ width: `${meterPct}%` }}
        />
      </div>
    </div>
  );
}
