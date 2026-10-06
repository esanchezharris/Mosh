import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import { WHEEL_IDLE, wheelNotches, type WheelAcc } from "./chorus";
import { Dial } from "./Dial";
import { param, physOf } from "./params";
import {
  PITCH_CHIPS, PITCH_RANGE, SEMITONES_PARAM, fmtRatioX, fmtSemitones, intervalName, nextWholeSemitone, pitchLatencyMs,
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
  const wheel = useRef<WheelAcc>(WHEEL_IDLE);
  // Alt held = fine (whole cents instead of whole semitones), for drags, keys and the wheel.
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
            fine.current = e.altKey;
            const t = pitchKeyTarget(e, shownSt.current);
            if (t === null) return;          // Home/End, double-click: the dial's own
            e.preventDefault();
            e.stopPropagation();
            step(t, e.altKey);
          }}
          onWheelCapture={(e) => {
            if (e.deltaY === 0) return;
            e.stopPropagation();
            // Per notch, not per event: a trackpad flick sends dozens of tiny events.
            const r = wheelNotches(wheel.current, e.deltaY, e.deltaMode, performance.now());
            wheel.current = r.acc;
            if (r.notches) step(pitchWheelTarget(shownSt.current, r.notches, e.altKey), e.altKey);
          }}>
          <Dial label="Semitones" norm={semitoneNorm(plugin, st)} display={fmtSemitones(st)} valueText={pitchValueText(st)}
            bipolar size={42} testId="v3-pitch-dial" defaultNorm={semitoneNorm(plugin, 0)}
            quantize={(n) => semitoneNorm(plugin, snapSemitones(atNorm(n), fine.current))}
            onChange={(n, gesture) => { setPending(atNorm(n)); setParam(SEMITONES_PARAM, n, { gesture }); }} />
        </div>
        <div className="pp-pitch-read">
          <span className="pp-pitch-st" data-testid="v3-pitch-st">{fmtSemitones(st)}</span>
          <span className="pp-pitch-int" data-testid="v3-pitch-interval" title={ratioTitle}>
            {intervalName(st)} · {fmtRatioX(st)}
          </span>
          <span className="pp-pitch-lat" data-testid="v3-pitch-latency" title={ratioTitle}>
            latency {Math.round(latency)} ms
            {p?.automated && <b className="pp-pitch-auto" data-testid="v3-pitch-automated"
              title="Automated: during playback the automation lane sets the pitch and overrides edits here">A</b>}
          </span>
        </div>
      </div>
      <div className="pp-pitch-chips" role="group" aria-label="Quick intervals">
        {PITCH_CHIPS.map((c) => (
          <button key={c} type="button" data-testid={`v3-pitch-chip-${c}`} aria-pressed={Math.abs(st - c) < 0.005}
            title={intervalName(c)} aria-label={`${fmtSemitones(c)}, ${intervalName(c)}`}
            onClick={() => { setPending(c); setParam(SEMITONES_PARAM, semitoneNorm(plugin, c)); }}>
            {c > 0 ? `+${c}` : c}
          </button>
        ))}
      </div>
    </div>
  );
}

export const pitchShifterPanelDef: PanelDef = { Panel: PitchPanel, summary: pitchSummary };
