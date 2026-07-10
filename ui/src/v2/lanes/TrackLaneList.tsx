// The arrangement: a sticky-header timeline grid. Column 1 = track headers (stick
// left), column 2 = the seconds-axis content (ribbon + ruler stick top, then one lane
// per track). Selection routes through the store (so multiplayer broadcast/lock-claim
// still fire). Drag/trim/split arrive in the lanes-interaction slice; this is the
// read + select surface that matches the demo.

import { Fragment, useCallback, useEffect, useRef } from "react";
import { useStore } from "../../store";
import { useShell, type SectionZoom } from "../shellState";
import { beatSeconds, barSeconds } from "../../time";
import type { Snapshot, Track } from "../../types";
import { SongNav } from "../timeline/SongNav";
import { BarRuler } from "../timeline/BarRuler";
import { Playhead } from "../timeline/Playhead";
import { ClipView } from "./ClipView";
import { meterOf, contentSeconds, headW } from "../timeline/geom";
import { IconDrum, IconLayers, IconPlus, IconWaveform } from "../../ui/icons";

const TYPE_LABEL: Record<string, string> = { drum: "Drum", audio: "Audio", group: "Group" };

export function TrackLaneList({ snapshot, dragging }: { snapshot: Snapshot; dragging?: boolean }) {
  const pxPerSec = useStore((s) => s.pxPerSec);
  const setPxPerSec = useStore((s) => s.setPxPerSec);
  const mixMorph = useStore((s) => s.mixMorph);
  const setMixMorph = useStore((s) => s.setMixMorph);
  const exec = useStore((s) => s.exec);
  const sectionZoom = useShell((s) => s.sectionZoom);
  const setSectionZoom = useShell((s) => s.setSectionZoom);
  const scrollRef = useRef<HTMLDivElement>(null);
  // The navigator is a whole-song OVERVIEW (SongNav) — clicking it seeks and brings that
  // spot into view in the (zoomed) timeline below. Not synced to the timeline's scroll.
  const scrubTo = useCallback((sec: number) => {
    void exec("set_transport", { position: sec });
    const el = scrollRef.current;
    if (el) {
      const pps = useStore.getState().pxPerSec;
      el.scrollLeft = Math.max(0, sec * pps - el.clientWidth / 2 + headW());
    }
  }, [exec]);

  const tracks = snapshot.tracks.filter((t) => !t.isGroup);
  const contentW = contentSeconds(snapshot) * pxPerSec;
  const beatPx = beatSeconds(meterOf(snapshot)) * pxPerSec;
  const barLen = barSeconds(meterOf(snapshot));
  const totalBars = Math.max(1, Math.ceil(contentSeconds(snapshot) / barLen));

  // Fit the timeline so N bars span the visible content width (8b / 16b / Full).
  const fit = useCallback((zoom: SectionZoom) => {
    const w = scrollRef.current?.clientWidth ?? 0;
    if (w <= 0) return;
    const bars = zoom === "8b" ? 8 : zoom === "16b" ? 16 : totalBars;
    setPxPerSec((w - headW()) / Math.max(1, bars * barLen)); // store clamps 20..400
  }, [totalBars, barLen, setPxPerSec]);

  useEffect(() => { fit(sectionZoom); }, [sectionZoom, fit]);
  useEffect(() => {
    const el = scrollRef.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(() => fit(useShell.getState().sectionZoom));
    ro.observe(el);
    return () => ro.disconnect();
  }, [fit]);
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      if (!(e.altKey || e.ctrlKey)) return;
      e.preventDefault();
      const delta = Math.max(-0.12, Math.min(0.12, -e.deltaY * 0.0018));
      setMixMorph(useStore.getState().mixMorph + delta);
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, [setMixMorph]);

  // Shell reactivity (#10): each lane glows with its OWN live audio level while playing,
  // in concert with Moshi (who reacts to the master spectrum). Driven imperatively from
  // the 30Hz `levels` feed via a rAF loop that sets a `--lvl` CSS var on every
  // [data-track-id] node (header icon + lane) — no React re-renders, eased for smoothness.
  // Pure presentation off telemetry; never touches the audio thread.
  useEffect(() => {
    let raf = 0;
    const cur = new Map<string, number>();
    const tick = () => {
      const st = useStore.getState();
      const playing = st.transport.playing;
      const levels = st.levels.tracks;
      const root = scrollRef.current;
      if (root) {
        const ids = new Set<string>();
        root.querySelectorAll<HTMLElement>("[data-track-id]").forEach((n) => { if (n.dataset.trackId) ids.add(n.dataset.trackId); });
        ids.forEach((id) => {
          const lv = levels[id];
          let target = 0;
          // dBFS → 0..1 with a perceptual sqrt lift so quiet passages still register.
          if (playing && lv) { const db = Math.max(lv.l, lv.r); target = Math.sqrt(Math.max(0, Math.min(1, (db + 54) / 50))); }
          const next = (cur.get(id) ?? 0) + (target - (cur.get(id) ?? 0)) * 0.28;
          cur.set(id, next);
          root.querySelectorAll<HTMLElement>(`[data-track-id="${id}"]`).forEach((n) => n.style.setProperty("--lvl", next.toFixed(3)));
        });
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, []);

  if (tracks.length === 0) {
    return (
      <>
        <div className="v2-nav" data-testid="v2-navigator" />
        <div className="v2-stage">
          <div className="v2-empty" data-testid="v2-empty">No tracks yet — ask Mosh to start a beat.</div>
        </div>
      </>
    );
  }

  return (
    <>
      {/* SONG NAVIGATOR — a whole-song overview above the arrangement: bar numbers + click to
          jump anywhere + collaborator markers. Independent of the timeline's zoom/scroll. */}
      <div className="v2-nav" data-testid="v2-navigator">
        <div className="v2-nav-gutter"><ZoomToggle value={sectionZoom} onChange={setSectionZoom} /></div>
        <div className="v2-nav-clip">
          <SongNav snapshot={snapshot} onScrub={scrubTo} />
        </div>
      </div>

      {/* ARRANGEMENT — the dark timeline: detail ruler + lanes. The
          panel SHRINK-WRAPS to its content (ruler + N lanes + one trailing add-track row) so
          sparse sessions show cream below it; once the tracks would overflow the available
          height it caps there and scrolls internally (the prompt bar stays put). */}
      <div
        className="v2-stage"
        style={{ "--v2-stage-h": `calc(var(--v2-ruler-h) + ${tracks.length + 1} * (var(--v2-lane-h) + 1px) + 16px)` } as React.CSSProperties}
      >
        <div className="v2-tl-scroll" ref={scrollRef} data-testid="v2-timeline">
          <div className="v2-tl" style={{ "--mix-morph": mixMorph } as React.CSSProperties} data-mix-morph={mixMorph.toFixed(2)}>
            {/* ruler row (now the top row) */}
            <div className="v2-corner v2-corner-ruler" />
            <div className="v2-ruler-cell"><BarRuler snapshot={snapshot} width={contentW} /></div>
            {/* lanes */}
            {tracks.map((t) => (
              <Fragment key={t.id}>
                <TrackLaneHeader track={t} />
                <div className="v2-lane" data-track-id={t.id} data-testid="v2-lane" style={{ width: contentW, "--beat-px": `${beatPx}px` } as React.CSSProperties}>
                  {t.clips.filter((c) => !c.hidden).map((c) => (
                    <ClipView key={c.id} clip={c} trackType={t.type} snapshot={snapshot} />
                  ))}
                </div>
              </Fragment>
            ))}
            {/* the "one more track" of room: a sticky-left add row — click the header to add
                a track, or drop an audio file onto the blackspace (the global drop imports). */}
            <button
              className="v2-lhead v2-lhead-add"
              data-testid="v2-track-add"
              title="Add a track (or drop an audio file below)"
              onClick={() => void exec("create_track", { name: "Audio" })}
            >
              <span className="v2-licon" aria-hidden="true"><IconPlus size={16} /></span>
              <span className="v2-lname">Add track</span>
            </button>
            <div className="v2-lane v2-lane-add" style={{ width: contentW }} aria-hidden />
            <Playhead />
          </div>
        </div>
        {dragging && (
          <div className="v2-drop" role="status" aria-live="polite" data-testid="v2-drop">
            <span>Drop audio to import</span>
          </div>
        )}
      </div>
    </>
  );
}

function ZoomToggle({ value, onChange }: { value: SectionZoom; onChange: (z: SectionZoom) => void }) {
  const opts: [SectionZoom, string][] = [["8b", "8b"], ["16b", "16b"], ["full", "Full"]];
  return (
    <div className="v2-zoom" data-testid="v2-zoom">
      {opts.map(([v, label]) => (
        <button key={v} className={value === v ? "on" : ""} aria-pressed={value === v} onClick={() => onChange(v)}>{label}</button>
      ))}
    </div>
  );
}

function TrackLaneHeader({ track }: { track: Track }) {
  const exec = useStore((s) => s.exec);
  const selectedTrackId = useStore((s) => s.selectedTrackId);
  const setSelectedTrack = useStore((s) => s.setSelectedTrack);
  const mixMorph = useStore((s) => s.mixMorph);
  const instrument = track.plugins?.find((p) => p.isInstrument)?.name;
  const preset = instrument ?? (track.type === "drum" ? "Drums" : "Audio");
  const typeLabel = TYPE_LABEL[track.type] ?? "Track";
  const sel = selectedTrackId === track.id;

  return (
    <div
      className={`v2-lhead${sel ? " sel" : ""}`}
      role="button"
      tabIndex={0}
      aria-label={`Select track ${track.name}`}
      aria-pressed={sel}
      onClick={() => setSelectedTrack(track.id)}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") { e.preventDefault(); setSelectedTrack(track.id); }
      }}
      data-testid="v2-track-header"
      data-track-id={track.id}
    >
      <span className="v2-licon" aria-hidden="true"><TrackTypeIcon type={track.type} /></span>
      <span className="v2-lmeta">
        <span className="v2-lrow">
          <span className="v2-lname">{track.name}</span>
          <span className="v2-ltype">{typeLabel}</span>
        </span>
        <span className="v2-lpreset">{preset}</span>
      </span>
      <span className="v2-ms">
        <button
          className={`m${track.mute ? " on" : ""}`}
          aria-label="Mute"
          aria-pressed={!!track.mute} title="Mute"
          onClick={(e) => { e.stopPropagation(); void exec("set_track_mute", { trackId: track.id, mute: !track.mute }); }}
        >M</button>
        <button
          className={`s${track.solo ? " on" : ""}`}
          aria-label="Solo"
          aria-pressed={!!track.solo} title="Solo"
          onClick={(e) => { e.stopPropagation(); void exec("set_track_solo", { trackId: track.id, solo: !track.solo }); }}
        >S</button>
      </span>
      <span className={`v2-lmix${mixMorph > 0.01 ? " active" : ""}`} style={{ opacity: mixMorph }} aria-hidden={mixMorph <= 0.01} onPointerDown={(e) => e.stopPropagation()}>
        <input className="v2-pan" type="range" min={-1} max={1} step={0.01} value={track.pan ?? 0}
          title={`Pan ${(track.pan ?? 0).toFixed(2)}`} aria-label={`Pan ${track.name}`} tabIndex={mixMorph > 0.01 ? 0 : -1} disabled={mixMorph <= 0.01}
          onChange={(e) => void exec("set_track_pan", { trackId: track.id, pan: Number(e.target.value) })} />
        <input className="v2-fader" type="range" min={-48} max={6} step={0.5} value={track.volumeDb ?? 0}
          title={`Volume ${(track.volumeDb ?? 0).toFixed(1)} dB`} aria-label={`Volume ${track.name}`} tabIndex={mixMorph > 0.01 ? 0 : -1} disabled={mixMorph <= 0.01}
          onChange={(e) => void exec("set_track_volume", { trackId: track.id, db: Number(e.target.value) })} />
      </span>
    </div>
  );
}

function TrackTypeIcon({ type }: { type: string }) {
  if (type === "drum") return <IconDrum size={16} />;
  if (type === "audio") return <IconWaveform size={16} />;
  return <IconLayers size={16} />;
}
