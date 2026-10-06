import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import { Dial } from "./Dial";
import { param, physOf } from "./params";
import {
  PITCH_CHIPS, PITCH_RANGE, SEMITONES_PARAM, fmtRatioX, fmtSemitones, intervalName, isOriginal, nextWholeSemitone, pitchLatencyMs,
  pitchSummary, pitchValueText, semitoneNorm, semitonesOf, snapSemitones,
} from "./pitch";
import type { PanelDef, PanelProps } from "./types";
import { useDragSend } from "./useDragSend";

/** How long a key/chip value stays on screen while the engine's patch arrives. */
const PENDING_MS = 800;

/** Arrow keys: to the next whole semitone (Alt: 0.1, i.e. 10 cents; Shift: an octave from
 *  the nearest semitone); PageUp/Down: an octave. Home/End are left to the dial (the
 *  ends, -24/+24). */
export function pitchKeyTarget(e: Pick<KeyboardEvent, "key" | "altKey" | "shiftKey">, st: number): number | null {
  const up = e.key === "ArrowUp" || e.key === "ArrowRight";
  const down = e.key === "ArrowDown" || e.key === "ArrowLeft";
  if (up || down) {
    if (e.altKey) return st + (up ? 0.1 : -0.1);
    if (e.shiftKey) return Math.round(st) + (up ? 12 : -12);
    return nextWholeSemitone(st, up ? 1 : -1);
  }
  if (e.key === "PageUp") return Math.round(st) + 12;
  if (e.key === "PageDown") return Math.round(st) - 12;
  return null;
}

/** Where `notches` of the wheel take a setting: whole semitones (Alt: 0.1 each). */
export function pitchWheelTarget(st: number, notches: number, alt: boolean): number {
  if (alt) return st + notches * 0.1;
  return nextWholeSemitone(st, notches > 0 ? 1 : -1, Math.abs(notches));
}

const clampSt = (st: number) => Math.min(PITCH_RANGE.max, Math.max(PITCH_RANGE.min, st));

/** Pitch Shifter: a semitone dial that snaps to whole semitones (Alt: cents), a big
 *  read-out with the interval and ratio, and one-click intervals. Nothing here is live:
 *  the plugin measures nothing, so nothing moves on its own. */
function PitchPanel({ plugin, sampleRate, setParam }: PanelProps) {
  const p = param(plugin, SEMITONES_PARAM);
  const [pending, setPending] = useState<number | null>(null);
  useEffect(() => {
    if (pending === null) return;
    const t = setTimeout(() => setPending(null), PENDING_MS);
    return () => clearTimeout(t);
  }, [pending]);
  const st = pending ?? semitonesOf(plugin);
  // The setting on screen, readable by the next event before React re-renders.
  const shownSt = useRef(st);
  shownSt.current = st;
  // Alt held during a drag = fine (whole cents instead of whole semitones). Keys read it
  // from the key event and the wheel from the Dial's modifier keys.
  const fine = useRef(false);
  const keys = useDragSend<number>((v, gesture) => setParam(SEMITONES_PARAM, v, { gesture }));
  const atNorm = (n: number) => physOf(p ? { ...p, value: n } : { index: SEMITONES_PARAM, name: "Semitones", value: n }, PITCH_RANGE);
  const step = (target: number, isFine: boolean) => {
    const t = clampSt(snapSemitones(target, isFine));
    if (t === shownSt.current) return;          // at an end: nothing to send
    shownSt.current = t;
    setPending(t);
    keys.nudge(semitoneNorm(plugin, t));
  };
  const latency = pitchLatencyMs(sampleRate);
  const ratioTitle = `Frequency ratio 2^(semitones/12). SoundTouch adds ${Math.round(latency)} ms of latency `
    + "(8192 samples): playback is compensated, live monitoring through it is late.";
  return (
    <div className="pp-pitch" data-testid="v3-pitch">
      <div className="pp-pitch-top">
        <div className="pp-pitch-dial"
          onPointerDownCapture={(e) => { fine.current = e.altKey; }}
          onPointerMoveCapture={(e) => { fine.current = e.altKey; }}
          onKeyDownCapture={(e) => {
            const t = pitchKeyTarget(e, shownSt.current);
            if (t === null) return;          // Home/End, double-click: the dial's own
            e.preventDefault();
            e.stopPropagation();
            step(t, e.altKey);
          }}>
          {/* The panel's one hero control: 36, the family's documented larger size. */}
          <Dial label="Semitones" norm={semitoneNorm(plugin, st)} display={fmtSemitones(st)} valueText={pitchValueText(st)}
            bipolar size={36} testId="v3-pitch-dial" defaultNorm={semitoneNorm(plugin, 0)}
            // The Dial turns the wheel into notches (and keeps it from scrolling the inspector).
            onWheelNotches={(notches, _shift, mods) => step(pitchWheelTarget(shownSt.current, notches, mods.alt), mods.alt)}
            quantize={(n) => semitoneNorm(plugin, snapSemitones(atNorm(n), fine.current))}
            onChange={(n, gesture) => { setPending(atNorm(n)); setParam(SEMITONES_PARAM, n, { gesture }); }} />
        </div>
        <div className="pp-pitch-read">
          <span className="pp-pitch-st" data-testid="v3-pitch-st">{fmtSemitones(st)}</span>
          <span className="pp-pitch-int" data-testid="v3-pitch-interval" title={ratioTitle}>
            {intervalName(st)} · <span className="num">{fmtRatioX(st)}</span>
          </span>
          <span className="pp-pitch-lat" data-testid="v3-pitch-latency" title={ratioTitle}>
            Latency <span className="num">{Math.round(latency)} ms</span>
            {p?.automated && <b className="pp-pitch-auto" data-testid="v3-pitch-automated"
              title="Automated: during playback the automation lane sets the pitch and overrides edits here">A</b>}
          </span>
        </div>
      </div>
      <div className="pp-pitch-chips" role="group" aria-label="Quick intervals">
        {PITCH_CHIPS.map((c) => (
          <button key={c} type="button" className="pp-btn" data-testid={`v3-pitch-chip-${c}`} aria-pressed={Math.abs(st - c) < 0.005}
            title={intervalName(c)} aria-label={`${fmtSemitones(c)}, ${intervalName(c)}`}
            onClick={() => { setPending(c); setParam(SEMITONES_PARAM, semitoneNorm(plugin, c)); }}>
            {c > 0 ? `+${c}` : c}
          </button>
        ))}
      </div>
    </div>
  );
}

export const MINI_W = 44, MINI_H = 14;
/** The mini's scale: the whole -24..+24 range across ±21 px, so an octave is 10.5 px (ticked). */
export const MINI_PX_PER_ST = 21 / PITCH_RANGE.max;

/** The minimized row's thumbnail, 44×14: a centred bipolar bar of the setting, filled from
 *  the centre tick (empty at the original pitch), with ticks at ±1 octave. Static. */
function PitchMini({ plugin }: PanelProps) {
  const st = clampSt(semitonesOf(plugin));
  const c = MINI_W / 2, w = Math.abs(st) * MINI_PX_PER_ST;
  const oct = 12 * MINI_PX_PER_ST;
  return (
    <svg className={`pp-pitch-mini${plugin.enabled ? "" : " bypassed"}`} data-testid="v3-pitch-mini"
      width={MINI_W} height={MINI_H} viewBox={`0 0 ${MINI_W} ${MINI_H}`} aria-hidden="true">
      <line className="track" x1={c - 21} x2={c + 21} y1={MINI_H / 2} y2={MINI_H / 2} />
      <line className="oct" x1={c - oct} x2={c - oct} y1={4} y2={10} />
      <line className="oct" x1={c + oct} x2={c + oct} y1={4} y2={10} />
      {!isOriginal(st) && (
        <rect className="bar" data-testid="v3-pitch-mini-bar" x={st > 0 ? c : c - w} y={4} width={w} height={6} rx={1} />
      )}
      <line className="ctr" x1={c} x2={c} y1={2} y2={12} />
    </svg>
  );
}

// No shortTitle: "Pitch Shifter" (69 px at 11 px semibold) fits the minimized name column (76 px).
export const pitchShifterPanelDef: PanelDef = { Panel: PitchPanel, summary: pitchSummary, Mini: PitchMini };
