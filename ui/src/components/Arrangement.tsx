import { useEffect, useRef, useState } from "react";
import { useStore, SNAP_DIVS, type SnapDiv } from "../store";
import type { Snapshot, Track, CommandResult } from "../types";
import { Clip } from "./Clip";
import { AutomationLane, AUTO_H, laneTargets, type LaneTarget } from "./AutomationLane";

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
  const ctxMenu = useStore((s) => s.ctxMenu);
  const setCtxMenu = useStore((s) => s.setCtxMenu);
  const follow = useStore((s) => s.follow);
  const t = snapshot.transport;
  const spb = secsPerBeat();
  const bpb = beatsPerBar();
  const ticks = rulerTicks(pxPerSec, spb, bpb);
  const barPx = spb * bpb * pxPerSec;
  const beatPx = spb * pxPerSec;
  const timelineRef = useRef<HTMLDivElement>(null);

  // Track drag-reorder (Stage 15): slot model — slot k inserts before track k.
  const headsRef = useRef<HTMLDivElement>(null);
  const [trackDrag, setTrackDrag] = useState<{ id: string; from: number; slot: number } | null>(null);

  // Follow the playhead while playing (Stage 15, toggleable in the toolbar).
  useEffect(() => {
    if (!follow || !t.playing) return;
    const el = timelineRef.current;
    if (!el) return;
    const headW = 168;
    const px = t.position * pxPerSec + headW;
    if (px < el.scrollLeft + headW || px > el.scrollLeft + el.clientWidth * 0.85)
      el.scrollLeft = Math.max(0, px - el.clientWidth * 0.3);
  }, [t.position, t.playing, follow, pxPerSec]);
  const lanesRef = useRef<HTMLDivElement>(null);
  const [marquee, setMarquee] = useState<{ x0: number; y0: number; x1: number; y1: number } | null>(null);
  const loopDrag = useRef<number | null>(null);

  // Automation lanes (Stage 22): rows grow when a lane is open — every piece
  // of row math below uses these offsets, never row * LANE_H.
  const autoOpen = useStore((s) => s.autoOpen);
  const rowOffsets: number[] = [];
  {
    let acc = 0;
    for (const tr of snapshot.tracks) {
      rowOffsets.push(acc);
      acc += LANE_H + (autoOpen[tr.id] ? AUTO_H : 0);
    }
    rowOffsets.push(acc); // sentinel: total height
  }
  const lanesHeight = Math.max(LANE_H, rowOffsets[rowOffsets.length - 1]);

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
      const top = rowOffsets[row];
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
      <Toolbar snapshot={snapshot} timelineRef={timelineRef} />
      <div className="timeline" ref={timelineRef} onPointerDown={() => ctxMenu && setCtxMenu(null)}>
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
          <div className="heads" ref={headsRef}>
            {snapshot.tracks.map((tr, row) => (
              <TrackHeader
                key={tr.id}
                track={tr}
                autoTarget={autoOpen[tr.id] ?? null}
                onDragStart={() => setTrackDrag({ id: tr.id, from: row, slot: row })}
                onDragMove={(clientY) => {
                  if (!trackDrag) return;
                  const rect = headsRef.current!.getBoundingClientRect();
                  const y = clientY - rect.top;
                  let slot = snapshot.tracks.length;
                  for (let i = 0; i < snapshot.tracks.length; i++) {
                    const mid = (rowOffsets[i] + rowOffsets[i + 1]) / 2;
                    if (y < mid) { slot = i; break; }
                  }
                  if (slot !== trackDrag.slot) setTrackDrag({ ...trackDrag, slot });
                }}
                onDragEnd={() => {
                  if (!trackDrag) return;
                  const { id, from, slot } = trackDrag;
                  setTrackDrag(null);
                  if (slot === from || slot === from + 1) return; // no-op slots
                  const before = slot < snapshot.tracks.length ? snapshot.tracks[slot].id : undefined;
                  void exec("move_track", before ? { trackId: id, beforeTrackId: before } : { trackId: id });
                }}
              />
            ))}
            {trackDrag && (
              <div className="track-drop-line" style={{ top: rowOffsets[trackDrag.slot] }} />
            )}
          </div>
          <div
            className="lanes"
            ref={lanesRef}
            style={{
              width: RULER_SECONDS * pxPerSec,
              height: lanesHeight,
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
              <div className="lane" key={tr.id} style={{ top: rowOffsets[row], height: LANE_H }}>
                {tr.clips.map((c) => (
                  <Clip key={c.id} clip={c} />
                ))}
              </div>
            ))}
            {snapshot.tracks.map((tr, row) =>
              autoOpen[tr.id] ? (
                <div key={`auto-${tr.id}`} className="autolane-row" style={{ top: rowOffsets[row] + LANE_H }}>
                  <AutomationLane
                    track={tr}
                    widthPx={RULER_SECONDS * pxPerSec}
                    pxPerSec={pxPerSec}
                    target={autoOpen[tr.id] as LaneTarget}
                  />
                </div>
              ) : null,
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
      {/* Clip context menu (Stage 15). */}
      {ctxMenu && (
        <div className="ctx-menu" style={{ left: ctxMenu.x, top: ctxMenu.y }}>
          <button
            onClick={() => {
              useStore.getState().setRenamingClip(ctxMenu.clipId);
              setCtxMenu(null);
            }}
          >
            Rename…
          </button>
          <button
            onClick={() => {
              void exec("duplicate_clip", { clipId: ctxMenu.clipId });
              setCtxMenu(null);
            }}
          >
            Duplicate <span className="ctx-kbd">⌘D</span>
          </button>
          <button
            onClick={() => {
              void exec("remove_clip", { clipId: ctxMenu.clipId });
              setCtxMenu(null);
            }}
          >
            Delete <span className="ctx-kbd">⌫</span>
          </button>
        </div>
      )}
    </div>
  );
}

function Toolbar({ snapshot, timelineRef }: { snapshot: Snapshot; timelineRef: React.RefObject<HTMLDivElement> }) {
  const exec = useStore((s) => s.exec);
  const tool = useStore((s) => s.tool);
  const setTool = useStore((s) => s.setTool);
  const snap = useStore((s) => s.snap);
  const setSnap = useStore((s) => s.setSnap);
  const snapDiv = useStore((s) => s.snapDiv);
  const setSnapDiv = useStore((s) => s.setSnapDiv);
  const pxPerSec = useStore((s) => s.pxPerSec);
  const setPxPerSec = useStore((s) => s.setPxPerSec);
  const follow = useStore((s) => s.follow);
  const setFollow = useStore((s) => s.setFollow);
  const selectedTrackId = useStore((s) => s.selectedTrackId);

  // Native file dialog → import_clip onto the selected track (Stage 15).
  const importAudio = async () => {
    const res = (await exec("choose_file", { title: "Import audio" })) as CommandResult<{ path?: string }>;
    const path = res.ok ? res.data?.path : undefined;
    if (!path) return;
    void exec("import_clip", selectedTrackId ? { file: path, trackId: selectedTrackId } : { file: path });
  };

  // Zoom so the whole arrangement fits the viewport.
  const zoomToFit = () => {
    const el = timelineRef.current;
    if (!el) return;
    let end = 8;
    for (const tr of snapshot.tracks)
      for (const c of tr.clips) end = Math.max(end, c.start + c.length);
    setPxPerSec(Math.max(20, (el.clientWidth - 168 - 24) / end));
    el.scrollLeft = 0;
  };

  return (
    <div className="toolbar">
      <button onClick={() => exec("create_track", {})}>+ Track</button>
      <button onClick={() => void importAudio()} title="Import an audio file to the selected track">+ Import</button>
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
      <button onClick={zoomToFit} title="Zoom to fit the arrangement">Fit</button>
      <button className={follow ? "on" : ""} onClick={() => setFollow(!follow)} title="Follow the playhead">
        Follow
      </button>
      <span className="sep" />
      <button onClick={() => exec("undo", {})}>↶ Undo</button>
      <button onClick={() => exec("redo", {})}>↷ Redo</button>
      <span className="sep" />
      <button onClick={() => exec("save", {})}>Save</button>
      <button onClick={() => exec("reload", {})}>Reload</button>
    </div>
  );
}

function TrackHeader({
  track,
  autoTarget,
  onDragStart,
  onDragMove,
  onDragEnd,
}: {
  track: Track;
  autoTarget: LaneTarget | null;
  onDragStart: () => void;
  onDragMove: (clientY: number) => void;
  onDragEnd: () => void;
}) {
  const exec = useStore((s) => s.exec);
  const setAutoLane = useStore((s) => s.setAutoLane);
  const selectedTrackId = useStore((s) => s.selectedTrackId);
  const setSelectedTrack = useStore((s) => s.setSelectedTrack);
  const level = useStore((s) => s.snapshot?.transport.levels?.tracks?.[track.id]);
  const [renaming, setRenaming] = useState(false);
  const fxCount = (track.plugins ?? []).filter((p) => p.external || p.neural).length;
  const db = level ? Math.max(level[0], level[1]) : -100;
  const meterPct = Math.max(0, Math.min(1, (db + 60) / 60)) * 100;
  return (
    <>
    <div
      className={`track-head ${selectedTrackId === track.id ? "sel" : ""}`}
      style={{ height: LANE_H }}
      onPointerDown={() => setSelectedTrack(track.id)}
    >
      <div className="th-row">
        <span
          className="track-grip"
          title="Drag to reorder"
          onPointerDown={(e) => {
            e.stopPropagation();
            (e.target as HTMLElement).setPointerCapture(e.pointerId);
            onDragStart();
          }}
          onPointerMove={(e) => onDragMove(e.clientY)}
          onPointerUp={onDragEnd}
        >
          ≡
        </span>
        {renaming ? (
          <input
            className="track-rename"
            autoFocus
            defaultValue={track.name}
            onFocus={(e) => e.target.select()}
            onBlur={(e) => {
              setRenaming(false);
              const name = e.target.value.trim();
              if (name && name !== track.name) void exec("rename_track", { trackId: track.id, name });
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter") (e.target as HTMLInputElement).blur();
              if (e.key === "Escape") setRenaming(false);
            }}
          />
        ) : (
          <span
            className="track-name"
            title="Double-click to rename"
            onDoubleClick={() => setRenaming(true)}
          >
            {track.name || `Track ${track.index + 1}`}
          </span>
        )}
        {fxCount > 0 && <span className="fx-count">{fxCount} fx</span>}
        <button className="mini" title="Remove" onClick={(e) => { e.stopPropagation(); exec("remove_track", { trackId: track.id }); }}>✕</button>
      </div>
      <div className="th-row">
        <button
          className={`mixbtn arm ${track.armed ? "arm-on" : ""}`}
          title={track.armed ? "Disarm" : "Arm for recording (needs an input — 🎙 in the topbar)"}
          onClick={() => exec("arm_track", { trackId: track.id, on: !track.armed })}
        >●</button>
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
          title={`Volume ${(track.volumeDb ?? 0).toFixed(1)} dB`}
          onChange={(e) => exec("set_track_volume", { trackId: track.id, db: Number(e.target.value) })}
        />
        <input
          className="pan"
          type="range"
          min={-1}
          max={1}
          step={0.05}
          value={track.pan ?? 0}
          title={`Pan ${((track.pan ?? 0) * 100).toFixed(0)}`}
          onDoubleClick={() => exec("set_track_pan", { trackId: track.id, pan: 0 })}
          onChange={(e) => exec("set_track_pan", { trackId: track.id, pan: Number(e.target.value) })}
        />
        <button
          className={`mixbtn ${autoTarget ? "auto-on" : ""}`}
          title={autoTarget ? "Close the automation lane" : "Show the automation lane"}
          onClick={() => setAutoLane(track.id, autoTarget ? null : { mixer: "volume", label: "volume" })}
        >A</button>
      </div>
      {/* Engine-output meter (Stage 14) — fed by the 30 Hz transport event. */}
      <div className="tmeter">
        <span
          className={db > -1 ? "hot" : db > -9 ? "warm" : ""}
          style={{ width: `${meterPct}%` }}
        />
      </div>
    </div>
    {autoTarget && (
      <div className="autohead" style={{ height: AUTO_H }}>
        <select
          className="autohead-select"
          value={autoTarget.label}
          onChange={(e) => {
            const t = laneTargets(track).find((lt) => lt.label === e.target.value);
            if (t) setAutoLane(track.id, t);
          }}
        >
          {laneTargets(track).map((lt) => (
            <option key={lt.label} value={lt.label}>{lt.label}</option>
          ))}
        </select>
        <button className="mini" title="Close lane" onClick={() => setAutoLane(track.id, null)}>✕</button>
      </div>
    )}
    </>
  );
}
