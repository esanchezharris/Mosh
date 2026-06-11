import { useRef, useState } from "react";
import { useStore } from "../store";
import type { Snapshot, Track } from "../types";
import { Clip } from "./Clip";
import { InlineAutomationLane, InlineAutoPicker } from "./InlineAutomationLane";
import { tempoMapFrom, gridLines, SNAP_DIVISIONS } from "../time";

const RULER_SECONDS = 48;

export function Arrangement({ snapshot }: { snapshot: Snapshot }) {
  const pxPerSec = useStore((s) => s.pxPerSec);
  const laneHeight = useStore((s) => s.laneHeight);
  const exec = useStore((s) => s.exec);
  const clearSelection = useStore((s) => s.clearSelection);
  const select = useStore((s) => s.select);
  const tool = useStore((s) => s.tool);
  const snapTime = useStore((s) => s.snapTime);
  const timeRange = useStore((s) => s.timeRange);
  const setTimeRange = useStore((s) => s.setTimeRange);
  const t = snapshot.transport;
  const lanesRef = useRef<HTMLDivElement>(null);
  const [marquee, setMarquee] = useState<{ x0: number; y0: number; x1: number; y1: number } | null>(null);
  // ARR-010 — anchor (seconds) for an in-progress Range drag; null when idle.
  const rangeDrag = useRef<number | null>(null);
  const loopDrag = useRef<number | null>(null);

  const LANE_H = laneHeight;
  // MIX-008 — group (submix) entries live in the Mixer, not as arrangement lanes;
  // their member tracks render here indented (via parentId).
  const laneTracks = snapshot.tracks.filter((tr) => !tr.isGroup);
  // SES-001 — bar/beat boundaries come from the piecewise tempo map (exact for
  // the step changes the commands create); constant sessions render as before.
  const tmap = tempoMapFrom(snapshot.session);
  const grid = gridLines(tmap, 0, RULER_SECONDS);

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

  // Lanes-background drag. Two modes, gated by the active tool:
  //  • Range tool → a second marquee mode that sets the UI-local edit time-range
  //    (ARR-010), rendered as a translucent band; never a command until "Delete
  //    range" is pressed.
  //  • otherwise → marquee selection of overlapping clips.
  const onLanesDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (e.target !== lanesRef.current) return; // only empty background
    const rect = lanesRef.current!.getBoundingClientRect();
    if (tool === "range") {
      const sec = snapTime(Math.max(0, (e.clientX - rect.left) / pxPerSec));
      rangeDrag.current = sec;
      setTimeRange({ start: sec, end: sec });
      lanesRef.current!.setPointerCapture(e.pointerId);
      return;
    }
    clearSelection();
    setMarquee({ x0: e.clientX - rect.left, y0: e.clientY - rect.top, x1: e.clientX - rect.left, y1: e.clientY - rect.top });
    lanesRef.current!.setPointerCapture(e.pointerId);
  };
  const onLanesMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const rect = lanesRef.current!.getBoundingClientRect();
    if (rangeDrag.current != null) {
      const sec = snapTime(Math.max(0, (e.clientX - rect.left) / pxPerSec));
      setTimeRange({ start: Math.min(rangeDrag.current, sec), end: Math.max(rangeDrag.current, sec) });
      return;
    }
    if (!marquee) return;
    setMarquee({ ...marquee, x1: e.clientX - rect.left, y1: e.clientY - rect.top });
  };
  const onLanesUp = () => {
    if (rangeDrag.current != null) {
      rangeDrag.current = null;
      // A zero-width drag is not a usable range; clear it back out.
      const r = useStore.getState().timeRange;
      if (r && r.end - r.start < 1e-6) setTimeRange(null);
      return;
    }
    if (!marquee) return;
    const xMin = Math.min(marquee.x0, marquee.x1);
    const xMax = Math.max(marquee.x0, marquee.x1);
    const yMin = Math.min(marquee.y0, marquee.y1);
    const yMax = Math.max(marquee.y0, marquee.y1);
    const hit: string[] = [];
    laneTracks.forEach((tr, row) => {
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
  const lanesHeight = Math.max(LANE_H, laneTracks.length * LANE_H);

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
            {grid.bars.map((b) => (
              <div className="tick bar" key={`bar-${b.sec}`} style={{ left: b.sec * pxPerSec }}>
                <span>{b.label}</span>
              </div>
            ))}
            {grid.beats.map((sec) => (
              <div className="tick beat" key={`beat-${sec}`} style={{ left: sec * pxPerSec }} />
            ))}
            {grid.marks.map((mk) => (
              <div className="tick tempo-mark" key={`mk-${mk.sec}`} style={{ left: mk.sec * pxPerSec }} title={`Tempo/meter change: ${mk.label}`}>
                <span>{mk.label}</span>
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
            {laneTracks.map((tr) => (
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
              {grid.bars.map((b) => (
                <div className="gl bar" key={`glb-${b.sec}`} style={{ left: b.sec * pxPerSec }} />
              ))}
            </div>
            {laneTracks.length === 0 && (
              <div className="empty-hint">No tracks yet — add a track or drop in a test tone.</div>
            )}
            {laneTracks.map((tr, row) => (
              <div className="lane" key={tr.id} style={{ top: row * LANE_H, height: LANE_H }}>
                {tr.clips.map((c) => (
                  <Clip key={c.id} clip={c} laneH={LANE_H} />
                ))}
                {/* AUT-003 — inline automation strip under the clips, same time
                    mapping as the ruler so points line up with the clips above. */}
                <div className="inline-auto-wrap" style={{ height: Math.max(28, LANE_H * 0.42) }}>
                  <InlineAutomationLane track={tr} width={rulerWidth} height={Math.max(28, LANE_H * 0.42)} />
                </div>
              </div>
            ))}
            {/* ARR-010 — the active edit time-range as a translucent band over the
                lanes (reuses the loop-region styling). Pure view state. */}
            {timeRange && timeRange.end > timeRange.start && (
              <div
                className="loopregion rangeband"
                style={{ left: timeRange.start * pxPerSec, width: (timeRange.end - timeRange.start) * pxPerSec, height: lanesHeight }}
              />
            )}
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
      <button className={tool === "range" ? "on" : ""} onClick={() => setTool("range")} title="Drag a time-range on the lanes to select it as a delete target">Range</button>
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
  const timeRange = useStore((s) => s.timeRange);
  const clearTimeRange = useStore((s) => s.clearTimeRange);
  const ids = [...selection];

  const clips = snapshot.tracks.flatMap((t) => t.clips).filter((c) => selection.has(c.id));
  const hasRange = !!timeRange && timeRange.end > timeRange.start;
  // The bar appears for a clip selection OR an active time-range (ARR-010).
  if (clips.length === 0 && !hasRange) return null;
  const single = clips.length === 1 ? clips[0] : null;
  const anyMuted = clips.some((c) => c.mute);

  // ARR-010 — delete the active time-range across all audio tracks (trackIds
  // omitted → all), then clear the range. delete_time_range is the only thing
  // that crosses the bridge; the range itself stays UI-local.
  const deleteRange = () => {
    if (!timeRange) return;
    void exec("delete_time_range", { start: timeRange.start, end: timeRange.end });
    clearTimeRange();
  };

  return (
    <div className="clip-actions">
      {hasRange && (
        <>
          <span className="ca-label">
            range {timeRange!.start.toFixed(2)}–{timeRange!.end.toFixed(2)}s
          </span>
          <button className="danger" onClick={deleteRange}>Delete range</button>
          <button onClick={clearTimeRange}>Clear range</button>
          {clips.length > 0 && <span className="sep" />}
        </>
      )}
      {clips.length === 0 ? null : (
      <>
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
      {single && single.type === "wave" && (
        <button
          className={single.autoTempo ? "on" : ""}
          title={single.autoTempo
            ? `Warp on — follows the tempo map (${single.stretchMode ?? "stretch"}, source ${Math.round(single.sourceBpm ?? 0)} BPM). Click to disable.`
            : "Warp off — clip stays in seconds. Click to follow the tempo map (time-stretch)."}
          onClick={() => exec("set_clip_warp", { clipId: single.id, autoTempo: !single.autoTempo })}
        >
          Warp
        </button>
      )}
      <button onClick={() => clips.forEach((c) => exec("duplicate_clip", { clipId: c.id }))}>Duplicate</button>
      <button className="danger" onClick={() => { clips.forEach((c) => exec("remove_clip", { clipId: c.id })); clearSelection(); }}>Delete</button>
      </>
      )}
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
      className={`track-head ${selectedTrackId === track.id ? "sel" : ""} ${track.parentId ? "grouped" : ""}`}
      style={{ height: laneH }}
      onPointerDown={() => setSelectedTrack(track.id)}
    >
      <div className="th-row">
        {track.parentId && <span className="grp-badge" title="In a group (submix)">▸</span>}
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
      {/* AUT-003 — compact picker choosing which param the inline lane draws. */}
      <InlineAutoPicker track={track} />
    </div>
  );
}
