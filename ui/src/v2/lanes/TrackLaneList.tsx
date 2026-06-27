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
import { SectionRibbon } from "../timeline/SectionRibbon";
import { BarRuler } from "../timeline/BarRuler";
import { Playhead } from "../timeline/Playhead";
import { ClipView } from "./ClipView";
import { meterOf, contentSeconds, HEAD_W } from "../timeline/geom";

const TYPE_ICON: Record<string, string> = { drum: "▦", audio: "≈", group: "▤" };

export function TrackLaneList({ snapshot, dragging }: { snapshot: Snapshot; dragging?: boolean }) {
  const pxPerSec = useStore((s) => s.pxPerSec);
  const setPxPerSec = useStore((s) => s.setPxPerSec);
  const sectionZoom = useShell((s) => s.sectionZoom);
  const setSectionZoom = useShell((s) => s.setSectionZoom);
  const scrollRef = useRef<HTMLDivElement>(null);
  const navTrackRef = useRef<HTMLDivElement>(null);
  // The section navigator is now its OWN panel above the arrangement (concept-style
  // separation). It shares the timeline's x-axis but is a separate scroll context, so
  // translate its track to track the arrangement's scrollLeft and stay bar-aligned.
  const syncNav = useCallback(() => {
    const sl = scrollRef.current?.scrollLeft ?? 0;
    if (navTrackRef.current) navTrackRef.current.style.transform = `translateX(${-sl}px)`;
  }, []);

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
    setPxPerSec((w - HEAD_W) / Math.max(1, bars * barLen)); // store clamps 20..400
  }, [totalBars, barLen, setPxPerSec]);

  useEffect(() => { fit(sectionZoom); }, [sectionZoom, fit]);
  useEffect(() => {
    const el = scrollRef.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(() => fit(useShell.getState().sectionZoom));
    ro.observe(el);
    return () => ro.disconnect();
  }, [fit]);
  // Re-align the navigator after a zoom (pxPerSec change resizes the content width).
  useEffect(() => { syncNav(); }, [pxPerSec, syncNav]);

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
      {/* SECTION NAVIGATOR — its own panel above the arrangement (separated, concept-style).
          Shares the timeline x-axis; the inner track is translated to follow the scroll. */}
      <div className="v2-nav" data-testid="v2-navigator">
        <div className="v2-nav-gutter"><ZoomToggle value={sectionZoom} onChange={setSectionZoom} /></div>
        <div className="v2-nav-clip">
          <div className="v2-nav-track" ref={navTrackRef} style={{ width: contentW }}>
            <SectionRibbon snapshot={snapshot} width={contentW} />
          </div>
        </div>
      </div>

      {/* ARRANGEMENT — the dark timeline: detail ruler + lanes (no section ribbon now). */}
      <div className="v2-stage">
        <div className="v2-tl-scroll" ref={scrollRef} data-testid="v2-timeline" onScroll={syncNav}>
          <div className="v2-tl">
            {/* ruler row (now the top row) */}
            <div className="v2-corner v2-corner-ruler" />
            <div className="v2-ruler-cell"><BarRuler snapshot={snapshot} width={contentW} /></div>
            {/* lanes */}
            {tracks.map((t) => (
              <Fragment key={t.id}>
                <TrackLaneHeader track={t} />
                <div className="v2-lane" data-track-id={t.id} data-testid="v2-lane" style={{ width: contentW, "--beat-px": `${beatPx}px` } as React.CSSProperties}>
                  {t.clips.map((c) => (
                    <ClipView key={c.id} clip={c} trackType={t.type} snapshot={snapshot} />
                  ))}
                </div>
              </Fragment>
            ))}
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
  const instrument = track.plugins?.find((p) => p.isInstrument)?.name;
  const preset = instrument ?? (track.type === "drum" ? "Drums" : "Audio");
  const sel = selectedTrackId === track.id;

  return (
    <div
      className={`v2-lhead${sel ? " sel" : ""}`}
      onClick={() => setSelectedTrack(track.id)}
      data-testid="v2-track-header"
      data-track-id={track.id}
    >
      <span className="v2-licon">{TYPE_ICON[track.type] ?? "≈"}</span>
      <span className="v2-lmeta">
        <span className="v2-lname">{track.name}</span>
        <span className="v2-lpreset">{preset}</span>
      </span>
      <span className="v2-ms">
        <button
          className={`m${track.mute ? " on" : ""}`}
          aria-pressed={!!track.mute} title="Mute"
          onClick={(e) => { e.stopPropagation(); void exec("set_track_mute", { trackId: track.id, mute: !track.mute }); }}
        >M</button>
        <button
          className={`s${track.solo ? " on" : ""}`}
          aria-pressed={!!track.solo} title="Solo"
          onClick={(e) => { e.stopPropagation(); void exec("set_track_solo", { trackId: track.id, solo: !track.solo }); }}
        >S</button>
      </span>
    </div>
  );
}
