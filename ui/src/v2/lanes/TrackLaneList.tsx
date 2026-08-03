// The arrangement: a sticky-header timeline grid. Column 1 = track headers (stick
// left), column 2 = the seconds-axis content (ribbon + ruler stick top, then one lane
// per track). Selection routes through the store (so multiplayer broadcast/lock-claim
// still fire). Drag/trim/split arrive in the lanes-interaction slice; this is the
// read + select surface that matches the demo.

import { Fragment, useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useStore } from "../../store";
import { useAnchoredPanel } from "../../hooks/useAnchoredPanel";
import { useShell, type SectionZoom } from "../shellState";
import { beatSeconds, barSeconds } from "../../time";
import type { CommandResult, Snapshot, Track } from "../../types";
import { SongNav } from "../timeline/SongNav";
import { BarRuler } from "../timeline/BarRuler";
import { SectionRibbon } from "../timeline/SectionRibbon";
import { TempoRibbon } from "../timeline/TempoRibbon";
import { AnnotationLane } from "../timeline/AnnotationLane";
import { LaneGrid, hasTempoChanges } from "../timeline/LaneGrid";
import { Playhead } from "../timeline/Playhead";
import { TimeRangeBand } from "../timeline/TimeRangeBand";
import { ClipView } from "./ClipView";
import { meterOf, contentSeconds, headW } from "../timeline/geom";
import { useLaneMarquee } from "./useLaneMarquee";
import { boundsOf } from "./marqueeHit";
import { IconDrum, IconLayers, IconPlus, IconWaveform } from "../../ui/icons";
// Renamed on import: this file already has a `meterOf` (time-signature meter, from
// ../timeline/geom) — `Meter` here is the UNRELATED Wave 9 audio LEVEL meter widget.
import { Meter as AudioLevelMeter } from "../../ui/Meter";
import { ConfirmDialog } from "../../ui/ConfirmDialog";

// (The uppercase AUDIO/DRUM pill that used to live in the header was removed: it
// duplicated `TrackTypeIcon`, which already encodes the track type, and being
// unshrinkable it won the fight for a 28px name column and truncated every name to
// "Ser…". The icon carries the type; the name gets the space.)

// The kinds of track the add-track affordance can create. Both add-track sites used to be
// hardcoded to `create_track {name:"Audio"}`, which made drum and instrument tracks
// UNREACHABLE in the shipped (v2) shell — the backends were complete and Catch2-tested the
// whole time (`cmdCreateTrack type:"drum"` stamps the type and loads sampler+kit;
// `cmdAddMidiClip` auto-loads 4OSC on an instrument-less track), but nothing in v2 ever
// asked for them, and `add_midi_clip` had no v2 call site at all. Only the classic shell's
// Topbar did (`+ Drums` / `+ MIDI`), so programming a beat or a melody with the mouse was
// impossible in the default UI. `ui/src/v2/lanes/trackKinds.test.ts` pins this.
type TrackKind = "audio" | "drum" | "midi" | "tone";

export const TRACK_KINDS: { kind: TrackKind; label: string; hint: string }[] = [
  { kind: "audio", label: "Audio",      hint: "Record or drop a file" },
  { kind: "drum",  label: "Drums",      hint: "Sampler + kit, ready to program" },
  { kind: "midi",  label: "Instrument", hint: "Synth + an empty MIDI clip" },
  { kind: "tone",  label: "Test tone",  hint: "A reference tone — check you can hear anything" },
];

export function TrackLaneList({ snapshot, dragging }: { snapshot: Snapshot; dragging?: boolean }) {
  const pxPerSec = useStore((s) => s.pxPerSec);
  const setPxPerSec = useStore((s) => s.setPxPerSec);
  const exec = useStore((s) => s.exec);
  const sectionZoom = useShell((s) => s.sectionZoom);
  const setSectionZoom = useShell((s) => s.setSectionZoom);
  const scrollRef = useRef<HTMLDivElement>(null);
  const tlRef = useRef<HTMLDivElement>(null);
  const marquee = useLaneMarquee(tlRef);
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

  // Aux/return (bus) tracks are instrument-free carriers for sends — they hold no
  // clips and belong on the mixer, not as an empty lane in the arrangement (matches
  // classic Mixer.tsx's `!t.isReturn` filter; the classic Arrange.tsx timeline predates
  // create_bus and doesn't yet exclude them — a separate, pre-existing gap).
  const tracks = snapshot.tracks.filter((t) => !t.isGroup && !t.isReturn);
  const contentW = contentSeconds(snapshot) * pxPerSec;
  // beatPx is the CONSTANT-tempo beat width feeding the lane's gradient. It is only
  // meaningful while the tempo never changes — see LaneGrid for what happens when it does.
  const beatPx = beatSeconds(meterOf(snapshot)) * pxPerSec;
  const varTempo = hasTempoChanges(snapshot.session);
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
    // #47 (EDGECASE_SWEEP_V2_2026-07-18) — the Add-track affordance used to live only
    // in the track-list footer, so it VANISHED with the last track: a fresh/emptied
    // project had no direct way to add one (only Ask Moshi or the File menu). Keep a
    // real button in the empty state — same command the footer row dispatches.
    return (
      <>
        <div className="v2-nav" data-testid="v2-navigator" />
        <div className="v2-stage v2-stage-empty">
          <div className="v2-empty" role="status" aria-live="polite" data-testid="v2-empty">No tracks yet — add one, or ask Mosh to start a beat.</div>
          <AddTrackMenu variant="empty" />
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
        style={{ "--v2-stage-h": `calc(var(--v2-ribbon-h) + var(--v2-tempo-h) + var(--v2-ruler-h) + var(--v2-ann-h) + ${tracks.length + 1} * (var(--v2-lane-h) + 1px) + 16px)` } as React.CSSProperties}
      >
        <div className="v2-tl-scroll" ref={scrollRef} data-testid="v2-timeline">
          {/* Empty-lane gestures (marquee / deselect / range) live on the grid rather
              than per-lane: a lasso legitimately crosses lane boundaries, and pointer
              capture has to belong to one element for the whole drag. Clips and the
              ruler/ribbon rows own their own pointerdowns, so this only ever fires on
              blank lane space — see useLaneMarquee's target test. */}
          <div
            className="v2-tl"
            ref={tlRef}
            onPointerDown={marquee.onPointerDown}
            onPointerMove={marquee.onPointerMove}
            onPointerUp={marquee.onPointerUp}
            onPointerCancel={marquee.onPointerCancel}
          >
            {/* Song-structure ribbon — the timeline's top row, above the ruler.
                NOT the nav strip: PR #183 removed it from there because a ribbon sitting
                beside the whole-song navigator "was misread as section editing", and
                SongNav replaced it with plain bar numbers. Inside the timeline it reads as
                what it is — a structure lane over the same x-axis as the clips. SongNav is
                untouched. */}
            <div className="v2-corner v2-corner-ribbon" />
            <div className="v2-ribbon-cell"><SectionRibbon snapshot={snapshot} width={contentW} /></div>
            {/* tempo row — sits between structure and bars, because it is what maps one to
                the other. Its own row rather than markers in the ruler: the ruler's plain
                click already means "seek", and click-to-add-a-tempo-change on the same
                element would have to fight it. */}
            <div className="v2-corner v2-corner-tempo"><span className="v2-corner-label">BPM</span></div>
            <div className="v2-tempo-cell"><TempoRibbon snapshot={snapshot} width={contentW} /></div>
            {/* ruler row */}
            <div className="v2-corner v2-corner-ruler" />
            <div className="v2-ruler-cell"><BarRuler snapshot={snapshot} width={contentW} /></div>
            {/* annotation lane — authored comment pins, beat-anchored (time.ts's piecewise
                map, not geom.ts's flat one) so a note holds its musical spot across a tempo
                change. Its own row after the ruler: a pin marks a POINT in time, same axis
                as the clips just below it. */}
            <div className="v2-corner v2-corner-ann"><span className="v2-corner-label">NOTE</span></div>
            <div className="v2-ann-cell"><AnnotationLane snapshot={snapshot} width={contentW} /></div>
            {/* lanes */}
            {tracks.map((t) => (
              <Fragment key={t.id}>
                <TrackLaneHeader track={t} />
                <div className={`v2-lane${varTempo ? " v2-lane-mapped" : ""}`} data-track-id={t.id} data-testid="v2-lane" style={{ width: contentW, "--beat-px": `${beatPx}px` } as React.CSSProperties}>
                  {/* Constant tempo keeps the CSS gradient (zero extra DOM); a variable map
                      gets real positioned lines, because a repeating gradient cannot express
                      an uneven grid and would drift from the ruler above. */}
                  {varTempo && <LaneGrid snapshot={snapshot} pxPerSec={pxPerSec} />}
                  {t.clips.filter((c) => !c.hidden).map((c) => (
                    <ClipView key={c.id} clip={c} trackType={t.type} snapshot={snapshot} />
                  ))}
                </div>
              </Fragment>
            ))}
            {/* the "one more track" of room: a sticky-left add row — click the header to add
                a track, or drop an audio file onto the blackspace (the global drop imports). */}
            <AddTrackMenu variant="row" />
            <div className="v2-lane v2-lane-add" style={{ width: contentW }} aria-hidden />
            <TimeRangeBand />
            <Playhead />
            {marquee.rect && (() => {
              const b = boundsOf(marquee.rect);
              return (
                <div
                  className="v2-marquee"
                  data-testid="v2-marquee"
                  style={{
                    left: headW() + b.xMin,
                    top: b.yMin,
                    width: b.xMax - b.xMin,
                    height: b.yMax - b.yMin,
                  }}
                />
              );
            })()}
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

// Create a track of the given kind. Pure of React so the reachability test can drive it
// with a recording fake `exec` and assert the exact command sequence.
export async function addTrackOfKind(
  kind: TrackKind,
  exec: (command: string, args?: Record<string, unknown>) => Promise<CommandResult>,
): Promise<void> {
  if (kind === "audio") { await exec("create_track", { name: "Audio" }); return; }
  if (kind === "drum") { await exec("create_track", { name: "Drums", type: "drum" }); return; }
  // A reference tone, for hearing whether the output path works at all. Classic had this in
  // its Topbar targeting the SELECTED track; v2 has no "add a clip to this track" affordance
  // to hang it off, so it arrives the same way an Instrument track does — make the track,
  // then put the clip on it — which is also the shape you want when the question is "is
  // anything reaching my speakers", i.e. before you trust any existing track.
  if (kind === "tone") {
    const toneRes = await exec("create_track", { name: "Tone" });
    const toneTrackId = (toneRes.data as { trackId?: string } | undefined)?.trackId;
    if (toneRes.ok && toneTrackId) await exec("add_test_tone_clip", { trackId: toneTrackId });
    return;
  }
  // There is no native "midi" track TYPE — cmdCreateTrack accepts only audio|drum, and an
  // instrument track IS an audio track carrying a synth plus MIDI clips. So: make the
  // track, then put a clip on it. add_midi_clip loads 4OSC in its own transaction when the
  // track has no instrument, so the clip lands audible and piano-roll-ready rather than
  // silent. Two commands ⇒ two undo steps, which is deliberate: add_midi_clip DOES
  // auto-create a track when trackId is absent (one step), but native creates a NEW track
  // there while bridge.mock.ts falls back to tracks[0] — passing an explicit trackId keeps
  // mock and native identical, and the mock would otherwise error in the empty state.
  const res = await exec("create_track", { name: "Instrument" });
  const trackId = (res.data as { trackId?: string } | undefined)?.trackId;
  if (res.ok && trackId) await exec("add_midi_clip", { trackId });
}

// The add-track affordance: a menu, not a button. `variant` only picks the trigger's skin —
// "empty" is the empty-state pill, "row" is the trailing sticky-left lane header.
//
// The panel is FIXED-positioned against the trigger's client rect rather than absolutely
// positioned inside a `.v2-menu-wrap`. Two reasons, both load-bearing: the "row" trigger is
// a grid child of `.v2-tl` inside the `.v2-tl-scroll` overflow container, so an absolute
// panel would be clipped and would scroll away from its trigger; and it lets the wrapper be
// `display: contents`, so the button stays the real grid/flex child and NEITHER layout
// shifts. (`.v2-lhead` is `position: sticky` — wrapping it in a positioned div would break
// the sticky-left column.)
function AddTrackMenu({ variant }: { variant: "empty" | "row" }) {
  // Flip-up-when-there's-no-room-below used to be hand-rolled here; it now lives in the
  // shared hook, which additionally clamps horizontally. The 200px estimate is load-bearing
  // and unchanged: the trailing add-track row sits at the END of the lane list, so on a full
  // session it lands at the bottom of the window and a downward panel runs off-screen — with
  // 8 tracks, "Instrument" was entirely unreachable. (v2-shell.spec pins that threshold.)
  // 232px = `.v2-menu-rich`'s rendered width, for the horizontal clamp only.
  const { open, at, anchorRef, panelRef, toggle, close } = useAnchoredPanel(232, 200, "start");
  const exec = useStore((s) => s.exec);

  const pick = useCallback((kind: TrackKind) => {
    close();
    void addTrackOfKind(kind, exec);
  }, [close, exec]);

  return (
    <div className="v2-addtrack">
      <button
        ref={anchorRef}
        className={variant === "empty" ? "v2-empty-add" : "v2-lhead v2-lhead-add"}
        data-testid="v2-track-add"
        aria-haspopup="menu"
        aria-expanded={open}
        title="Add a track (or drop an audio file here)"
        onClick={toggle}
      >
        <span className="v2-licon" aria-hidden="true"><IconPlus size={16} /></span>
        <span className="v2-lname">Add track</span>
      </button>
      {open && at && (
        <div ref={panelRef} className="v2-menu-panel v2-menu-panel-fixed"
          style={{ top: at.top, bottom: at.bottom, left: at.left }}>
          <div className="v2-menu v2-menu-rich" role="menu" aria-label="Add track">
            {TRACK_KINDS.map(({ kind, label, hint }) => (
              <button
                key={kind}
                role="menuitem"
                // Explicit: the icon is aria-hidden and the visible text is split across
                // two spans, so screen readers were announcing these rows unnamed.
                aria-label={`${label} track — ${hint}`}
                data-testid={`v2-track-add-${kind}`}
                onClick={() => pick(kind)}
              >
                <span className="v2-licon" aria-hidden="true">
                  {/* "tone" is not a track type — it makes an AUDIO track with a tone on
                      it — so it borrows the waveform icon rather than falling through to
                      TrackTypeIcon's unknown-type default. */}
                  <TrackTypeIcon type={kind === "midi" ? "instrument" : kind === "tone" ? "audio" : kind} />
                </span>
                <span className="v2-menu-text">
                  <span className="v2-menu-label">{label}</span>
                  <span className="v2-menu-hint">{hint}</span>
                </span>
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function ZoomToggle({ value, onChange }: { value: SectionZoom; onChange: (z: SectionZoom) => void }) {
  const opts: [SectionZoom, string][] = [["8b", "8b"], ["16b", "16b"], ["full", "Full"]];
  return (
    <div className="v2-zoom" data-testid="v2-zoom" role="group" aria-label="Timeline zoom">
      {opts.map(([v, label]) => (
        <button key={v} className={value === v ? "on" : ""} aria-pressed={value === v} onClick={() => onChange(v)}>{label}</button>
      ))}
    </div>
  );
}

function TrackLaneHeader({ track }: { track: Track }) {
  const exec = useStore((s) => s.exec);
  const selectedTrackId = useStore((s) => s.selectedTrackId);
  const clearSelection = useStore((s) => s.clearSelection);
  const setSelectedTrack = useStore((s) => s.setSelectedTrack);
  const setSelectedClip = useShell((s) => s.setSelectedClip);
  // Only show the preset line when it actually says something. It used to fall back to
  // "Drums"/"Audio", which is a third restatement of what the icon already shows — and
  // it cost the name column a line of vertical space to say nothing.
  const preset = track.plugins?.find((p) => p.isInstrument)?.name;
  const sel = selectedTrackId === track.id;

  // UI-REACH — remove_track's sole call site in the whole codebase was classic's ×
  // (ui/Arrange.tsx:416), which v2 never renders, so a mouse-only v2 user could not
  // delete a track at all. cmdRemoveTrack (MoshOps.cpp) is `eng.edit().deleteTrack(track)`
  // inside one undo transaction — it takes every clip on the track with it, so this is
  // confirm-gated (mirrors the bus-removal confirm in Inspector.tsx's SendsSection),
  // though unlike a bus deletion it IS a plain undoable Edit mutation — the dialog says so.
  const [confirmRemove, setConfirmRemove] = useState(false);
  const clipCount = track.clips.length;
  const selectTrack = () => {
    setSelectedClip(null);
    clearSelection();
    setSelectedTrack(track.id);
  };

  return (
    <div
      className={`v2-lhead${sel ? " sel" : ""}`}
      role="group"
      aria-label={`${track.name} track`}
      data-testid="v2-track-header"
      data-track-id={track.id}
    >
      <button
        type="button"
        className="v2-lhead-select"
        aria-label={`Select track ${track.name}`}
        aria-pressed={sel}
        onClick={selectTrack}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") { e.preventDefault(); selectTrack(); }
        }}
      >
        <span className="v2-licon" aria-hidden="true"><TrackTypeIcon type={track.type} /></span>
        <span className="v2-lmeta">
          <span className="v2-lrow">
            <span className="v2-lname" title={track.name}>{track.name}</span>
          </span>
          {preset && <span className="v2-lpreset">{preset}</span>}
        </span>
        <TrackMeterBar trackId={track.id} />
      </button>
      <span className="v2-ms">
        {/* G15 / CAP-REC-004 — the per-track RECORD ARM. `arm_track` and `stop_recording`
            have always landed takes on EVERY armed track, but the only way to arm from v2
            was the transport Record button, which auto-arms the SELECTED track alone. So
            multi-track simultaneous recording — a whole band, or a vocal and a room mic —
            was engine-complete and unreachable by mouse.

            Disabled with a reason when the track has no routed input: arming a track that
            cannot receive audio would record silence and look like a working take. The
            snapshot already carries `hasInput`, so this is an honest gate, not a guess.

            NOT undoable by design, matching cmdArmTrack: arming is a transport decision
            like monitor mode, not an edit to the project. */}
        <button
          className={`r${track.armed ? " on" : ""}`}
          data-testid="v2-track-arm"
          aria-label={`Record-arm ${track.name}`}
          aria-pressed={!!track.armed}
          disabled={track.hasInput === false}
          title={track.hasInput === false
            ? `${track.name} has no input routed — pick one in the Inspector's Mix tab before arming`
            : `Record-arm ${track.name}`}
          onClick={(e) => { e.stopPropagation(); void exec("arm_track", { trackId: track.id, armed: !track.armed }); }}
        >R</button>
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
      <button
        className="v2-lhead-rm"
        data-testid="v2-track-remove"
        title={`Delete ${track.name}`}
        aria-label={`Delete ${track.name}`}
        onClick={(e) => { e.stopPropagation(); setConfirmRemove(true); }}
      >×</button>
      {confirmRemove && createPortal(
        <ConfirmDialog
          title={`Delete "${track.name}"?`}
          testId="v2-track-remove-confirm"
          danger
          confirmLabel="Delete track"
          body={
            <>
              This removes the track and {clipCount === 0 ? "everything on it" : clipCount === 1 ? "the 1 clip on it" : `all ${clipCount} clips on it`}.
              Undo (⌘Z) brings it back right after, same as any other edit.
            </>
          }
          onConfirm={() => { setConfirmRemove(false); void exec("remove_track", { trackId: track.id }); }}
          onCancel={() => setConfirmRemove(false)}
        />,
        document.body,
      )}
    </div>
  );
}

// Compact per-track peak meter for the v2 header, beside Mute/Solo. Reuses the classic
// shell's <Meter> verbatim (../../ui/Meter) — same ballistics/clip-latch/geometry, same
// "read imperatively inside a rAF loop, never re-render React" discipline — so this
// widget itself never causes TrackLaneHeader (or the track tree) to re-render on the 30Hz
// `levels` feed. Sizing-only CSS (.v2-meter, shell.css) narrows it to fit the compact
// header; the underlying .meter/.mbar/.mmask classes (mosh.css, loaded globally) are
// untouched. Silent/no-data tracks simply read the Bars component's undefined→{-100,-100}
// fallback (an empty bar); a peak at/above 0 dBFS lights the shared .meter-clip glow.
// Exported for its own focused test (TrackMeterBar.test.ts) alongside the
// aux/return-exclusion coverage in TrackLaneList.test.ts.
export function TrackMeterBar({ trackId }: { trackId: string }) {
  return (
    <span className="v2-meter" data-testid="v2-track-meter">
      <AudioLevelMeter trackId={trackId} />
    </span>
  );
}

function TrackTypeIcon({ type }: { type: string }) {
  if (type === "drum") return <IconDrum size={16} />;
  if (type === "audio") return <IconWaveform size={16} />;
  return <IconLayers size={16} />;
}
