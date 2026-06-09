import { useRef, useState } from "react";
import { useStore } from "../store";
import type { Snapshot, Track } from "../types";
import { Clip } from "./Clip";
import { meterFrom, barSeconds, beatSeconds, SNAP_DIVISIONS } from "../time";

const RULER_SECONDS = 48;

export function Arrangement({ snapshot }: { snapshot: Snapshot }) {
  const pxPerSec = useStore((s) => s.pxPerSec);
  const laneHeight = useStore((s) => s.laneHeight);
  const exec = useStore((s) => s.exec);
  const clearSelection = useStore((s) => s.clearSelection);
  const select = useStore((s) => s.select);
  const t = snapshot.transport;
  const lanesRef = useRef<HTMLDivElement>(null);
  const [marquee, setMarquee] = useState<{ x0: number; y0: number; x1: number; y1: number } | null>(null);
  const loopDrag = useRef<number | null>(null);

  const LANE_H = laneHeight;
  const m = meterFrom(snapshot.session);
  const barSec = barSeconds(m);
  const beatSec = beatSeconds(m);
  const numBars = Math.max(1, Math.ceil(RULER_SECONDS / barSec) + 1);

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

  const rulerWidth = RULER_SECONDS * pxPerSec;
  const lanesHeight = Math.max(LANE_H, snapshot.tracks.length * LANE_H);

  // (Delete / clip-keyboard handling lives in the single global useKeyboardShortcuts
  // hook mounted by App — see ui/src/hooks/useKeyboardShortcuts.ts.)

  return (
    <div className="arrange">
      <Toolbar />
      <ClipActions snapshot={snapshot} />
      <div className="timeline">
        <div className="tl-head">
          <div className="lane-gutter">tracks</div>
          <div
            className="ruler"
            style={{ width: rulerWidth }}
            onClick={(e) => !e.shiftKey && seekRuler(e, e.currentTarget)}
            onPointerDown={onRulerDown}
            onPointerMove={onRulerMove}
            onPointerUp={onRulerUp}
          >
            {Array.from({ length: numBars }, (_, b) => (
              <div className="tick bar" key={`bar-${b}`} style={{ left: b * barSec * pxPerSec }}>
                <span>{b + 1}</span>
              </div>
            ))}
            {numBars * m.num < 400 &&
              Array.from({ length: numBars }, (_, b) =>
                Array.from({ length: m.num }, (_, beat) =>
                  beat === 0 ? null : (
                    <div
                      className="tick beat"
                      key={`beat-${b}-${beat}`}
                      style={{ left: (b * m.num + beat) * beatSec * pxPerSec }}
                    />
                  )
                )
              )}
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
              <TrackHeader key={tr.id} track={tr} laneH={LANE_H} />
            ))}
          </div>
          <div
            className="lanes"
            ref={lanesRef}
            style={{ width: rulerWidth, height: lanesHeight, ["--lane-h" as string]: `${LANE_H}px` } as React.CSSProperties}
            onPointerDown={onLanesDown}
            onPointerMove={onLanesMove}
            onPointerUp={onLanesUp}
          >
            {/* Musical gridlines (bar lines bright, beats faint) — same mapping as the ruler. */}
            <div className="gridlines" style={{ height: lanesHeight }}>
              {Array.from({ length: numBars }, (_, b) => (
                <div className="gl bar" key={`glb-${b}`} style={{ left: b * barSec * pxPerSec }} />
              ))}
            </div>
            {snapshot.tracks.length === 0 && (
              <div className="empty-hint">No tracks yet — add a track or drop in a test tone.</div>
            )}
            {snapshot.tracks.map((tr, row) => (
              <div className="lane" key={tr.id} style={{ top: row * LANE_H, height: LANE_H }}>
                {tr.clips.map((c) => (
                  <Clip key={c.id} clip={c} laneH={LANE_H} />
                ))}
              </div>
            ))}
            <div className="playhead lane-ph" style={{ left: t.position * pxPerSec, height: lanesHeight }} />
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
  const snapDivision = useStore((s) => s.snapDivision);
  const setSnapDivision = useStore((s) => s.setSnapDivision);
  const pxPerSec = useStore((s) => s.pxPerSec);
  const setPxPerSec = useStore((s) => s.setPxPerSec);
  const laneHeight = useStore((s) => s.laneHeight);
  const setLaneHeight = useStore((s) => s.setLaneHeight);

  return (
    <div className="toolbar">
      <button onClick={() => exec("create_track", {})}>+ Track</button>
      <button onClick={() => exec("add_test_tone_clip", { seconds: 2, freq: 220 })}>+ Test Tone</button>
      <button onClick={() => exec("add_midi_clip", {})}>+ MIDI</button>
      <span className="sep" />
      <button className={tool === "move" ? "on" : ""} onClick={() => setTool("move")}>Move</button>
      <button className={tool === "split" ? "on" : ""} onClick={() => setTool("split")}>Split</button>
      <button className={snap ? "on" : ""} onClick={() => setSnap(!snap)} title="Snap to grid">Snap</button>
      <select
        className="grid-sel"
        value={snapDivision}
        onChange={(e) => setSnapDivision(e.target.value as typeof snapDivision)}
        title="Grid resolution"
      >
        {SNAP_DIVISIONS.map((d) => (
          <option key={d} value={d}>{d === "bar" ? "Bar" : d}</option>
        ))}
      </select>
      <span className="sep" />
      <button onClick={() => setPxPerSec(pxPerSec / 1.4)} title="Zoom out (time)">⇤⇥</button>
      <button onClick={() => setPxPerSec(pxPerSec * 1.4)} title="Zoom in (time)">⇥⇤</button>
      <button onClick={() => setLaneHeight(laneHeight - 18)} title="Shorter tracks">⇟</button>
      <button onClick={() => setLaneHeight(laneHeight + 18)} title="Taller tracks">⇞</button>
      <span className="sep" />
      <button onClick={() => exec("undo", {})}>↶ Undo</button>
      <button onClick={() => exec("redo", {})}>↷ Redo</button>
      <span className="sep" />
      <button onClick={() => exec("save", {})}>Save</button>
      <button onClick={() => exec("reload", {})}>Reload</button>
    </div>
  );
}

// Selection-driven clip operations (Wave 6): rename / mute / gain / duplicate /
// delete. Appears only when one or more clips are selected.
function ClipActions({ snapshot }: { snapshot: Snapshot }) {
  const selection = useStore((s) => s.selection);
  const exec = useStore((s) => s.exec);
  const clearSelection = useStore((s) => s.clearSelection);
  const ids = [...selection];
  if (ids.length === 0) return null;

  const clips = snapshot.tracks.flatMap((t) => t.clips).filter((c) => selection.has(c.id));
  if (clips.length === 0) return null;
  const single = clips.length === 1 ? clips[0] : null;
  const anyMuted = clips.some((c) => c.mute);

  return (
    <div className="clip-actions">
      <span className="ca-label">{ids.length} clip{ids.length > 1 ? "s" : ""} selected</span>
      {single && (
        <input
          className="ca-name"
          key={single.id}
          defaultValue={single.name}
          onBlur={(e) => exec("rename_clip", { clipId: single.id, name: e.target.value })}
          onKeyDown={(e) => { if (e.key === "Enter") (e.target as HTMLInputElement).blur(); }}
          title="Rename clip (Enter to commit)"
        />
      )}
      <button onClick={() => clips.forEach((c) => exec("set_clip_mute", { clipId: c.id, mute: !anyMuted }))}>
        {anyMuted ? "Unmute" : "Mute"}
      </button>
      {single && single.type === "wave" && (
        <label className="ca-gain" title="Clip gain">
          gain
          <input
            type="range" min={-24} max={12} step={0.5}
            value={single.gainDb ?? 0}
            onChange={(e) => exec("set_clip_gain", { clipId: single.id, gainDb: Number(e.target.value) })}
          />
          <span>{(single.gainDb ?? 0).toFixed(1)}</span>
        </label>
      )}
      <button onClick={() => clips.forEach((c) => exec("duplicate_clip", { clipId: c.id }))}>Duplicate</button>
      <button className="danger" onClick={() => { clips.forEach((c) => exec("remove_clip", { clipId: c.id })); clearSelection(); }}>Delete</button>
    </div>
  );
}

function TrackHeader({ track, laneH }: { track: Track; laneH: number }) {
  const exec = useStore((s) => s.exec);
  const selectedTrackId = useStore((s) => s.selectedTrackId);
  const setSelectedTrack = useStore((s) => s.setSelectedTrack);
  const fxCount = (track.plugins ?? []).filter((p) => p.external || p.neural || p.builtin).length;
  return (
    <div
      className={`track-head ${selectedTrackId === track.id ? "sel" : ""}`}
      style={{ height: laneH }}
      onPointerDown={() => setSelectedTrack(track.id)}
    >
      <div className="th-row">
        <span className="track-name">{track.name || `Track ${track.index + 1}`}</span>
        {fxCount > 0 && <span className="fx-count">{fxCount} fx</span>}
        <button className="mini" title="Remove" onClick={(e) => { e.stopPropagation(); exec("remove_track", { trackId: track.id }); }}>✕</button>
      </div>
      <div className="th-row">
        <button
          className={`mixbtn ${track.armed ? "arm-on" : ""}`}
          title={
            track.hasInput
              ? track.inputType === "midi"
                ? `Armed for live MIDI${track.midiInputName ? ` (${track.midiInputName})` : ""}`
                : "Record-arm"
              : track.isInstrument
                ? "Arm for live MIDI (no input device)"
                : "Record-arm (no input device)"
          }
          onClick={() => exec("arm_track", { trackId: track.id, armed: !track.armed })}
        >R</button>
        <button
          className={`mixbtn ${track.monitor && track.monitor !== "off" ? "mon-on" : ""}`}
          title={`Input monitor: ${track.monitor ?? "automatic"}`}
          onClick={() => exec("set_input_monitor", {
            trackId: track.id,
            mode: track.monitor === "on" ? "off" : "on",
          })}
        >I</button>
        <button
          className={`mixbtn ${track.mute ? "mute-on" : ""}`}
          onClick={() => exec("set_track_mute", { trackId: track.id, mute: !track.mute })}
        >M</button>
        <button
          className={`mixbtn ${track.solo ? "solo-on" : ""}`}
          onClick={() => exec("set_track_solo", { trackId: track.id, solo: !track.solo })}
        >S</button>
        <input
          className="pan-mini"
          type="range"
          min={-1}
          max={1}
          step={0.01}
          value={track.pan ?? 0}
          onChange={(e) => exec("set_track_pan", { trackId: track.id, pan: Number(e.target.value) })}
          title={`Pan ${(track.pan ?? 0).toFixed(2)}`}
        />
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
    </div>
  );
}
