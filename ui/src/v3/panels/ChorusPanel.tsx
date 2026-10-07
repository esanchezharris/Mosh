import { useEffect, useRef, useState } from "react";
import { Dial } from "./Dial";
import {
  CHORUS_BASE_MS, CHORUS_SPEC, NEEDS_ENGINE, chorusDelayMs, chorusLaneSpan, chorusSettings, chorusSummary,
  chorusWobbleCents, fmtDepthMs, fmtPeriod, fmtRate, fmtWobble, rightPhaseOffset, stateKeySteps, stateNormOf,
  stateQuantizer, stateRange, stateSettable, stateStep, stateValueAt, widthDegrees, type ChorusKey, type ChorusSettings,
} from "./chorus";
import { useTransportPlaying } from "./meters";
import { fmtPct, stateNum, type Range } from "./params";
import { curvePath, linScale } from "./plot";
import type { PanelDef, PanelProps } from "./types";
import { SETTLE_MS, useDragSend } from "./useDragSend";

// ── shared by the modulation panels (chorus, phaser) ──────────────────────────────────

const REDUCED_QUERY = "(prefers-reduced-motion: reduce)";
function reducedMotionQuery(): MediaQueryList | null {
  try {
    return typeof window !== "undefined" && typeof window.matchMedia === "function" ? window.matchMedia(REDUCED_QUERY) : null;
  } catch {
    return null;
  }
}

/** Does this viewer ask for reduced motion? Follows the setting while mounted. */
export function useReducedMotion(): boolean {
  const [reduced, setReduced] = useState(() => !!reducedMotionQuery()?.matches);
  useEffect(() => {
    const mql = reducedMotionQuery();
    if (!mql) return;
    const on = () => setReduced(mql.matches);
    mql.addEventListener?.("change", on);
    return () => mql.removeEventListener?.("change", on);
  }, []);
  return reduced;
}

/** An LFO position in cycles (0-1) that FREE-RUNS at `rateHz` while `run` is true. It is
 *  illustrative: the rate is the plugin's real rate, but the phase is not locked to the
 *  engine's (which is private and resets on every graph rebuild). Callers pass
 *  `run = enabled && transport playing`, so it stands still, at `rest`, when the plugin is
 *  bypassed (the engine's LFO freezes too) or nothing is being heard; it also rests under
 *  prefers-reduced-motion. Redraws at most ~30 times a second, and only its own subtree. */
export function useFreeRunningPhase(rateHz: number, run: boolean, rest = 0): { cycles: number; animating: boolean } {
  const reduced = useReducedMotion();
  const animating = run && !reduced && rateHz > 0 && typeof requestAnimationFrame === "function";
  const [cycles, setCycles] = useState(rest);
  const acc = useRef(rest);
  const rate = useRef(rateHz);
  rate.current = rateHz;
  useEffect(() => {
    if (!animating) return;
    acc.current = rest;
    setCycles(rest);
    let handle = 0;
    let last = performance.now(), shown = last;
    const tick = (now: number) => {
      acc.current = (acc.current + (Math.max(0, now - last) / 1000) * rate.current) % 1;
      last = now;
      if (now - shown >= 33) { shown = now; setCycles(acc.current); }
      handle = requestAnimationFrame(tick);
    };
    handle = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(handle);
  }, [animating, rest]);
  return { cycles: animating ? cycles : rest, animating };
}

/** How long a value set from here stays on screen while the engine's patch arrives. */
const PENDING_MS = 800;

/** A dial for a `plugin.state` setting: positions map linearly onto the setting's range
 *  (params.ts), land on whole steps, and set_plugin_state is sent the PHYSICAL value.
 *  A drag is one gesture (one undo step). Arrows step whole physical steps from the value
 *  shown (Shift: one step), the wheel steps the same per notch (through the Dial, which
 *  keeps it from scrolling the inspector), Home/End and double-click are the dial's own.
 *  With `commitOnRelease` a drag only previews and sends ONE value on release (for a
 *  setting the engine glitches on while it changes). `onPreview` reports the value shown
 *  before the snapshot has it (null when the snapshot is current). On an engine that does
 *  not publish the setting it is disabled and sends nothing (stateSettable). */
export function StateDial({ plugin, stateKey, label, spec, fmt, valueText, setState, bipolar, testId, commitOnRelease, onPreview, inert, title }: {
  plugin: PanelProps["plugin"]; stateKey: string; label: string;
  spec: { def: number; range: Range; step: number };
  fmt: (v: number) => string; valueText?: (v: number) => string;
  setState: PanelProps["setState"]; bipolar?: boolean; testId?: string;
  commitOnRelease?: boolean; onPreview?: (v: number | null) => void;
  inert?: boolean; title?: string;
}) {
  const disabled = !stateSettable(plugin, stateKey);
  const range = stateRange(plugin, stateKey, spec.range);
  const committed = stateNum(plugin, stateKey, spec.def);
  const [pending, setPending] = useState<number | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);
  const previewRef = useRef(onPreview);
  previewRef.current = onPreview;
  useEffect(() => { previewRef.current?.(pending); }, [pending]);
  const v = pending ?? committed;
  // The value on screen, readable by the next event before React re-renders.
  const shown = useRef(v);
  shown.current = v;
  /** Show `value` now; let the snapshot take over again after `holdMs` (never, while dragging). */
  const show = (value: number | null, holdMs: number | null) => {
    if (timer.current) { clearTimeout(timer.current); timer.current = null; }
    if (value !== null) shown.current = value;
    setPending(value);
    if (value !== null && holdMs !== null) timer.current = setTimeout(() => { timer.current = null; setPending(null); }, holdMs);
  };
  const keys = useDragSend<number>((value, gesture) => setState(stateKey, value, { gesture }));
  const stepBy = (steps: number) => {
    if (disabled) return;
    const t = stateStep(shown.current, steps, range, spec.step);
    if (t === shown.current) return;            // at an end: nothing to send
    show(t, PENDING_MS);
    keys.nudge(t);
  };
  // A pointer drag in progress when committing on release: the last value and its gesture.
  const drag = useRef<{ last: number | null; gesture?: string } | null>(null);
  const release = () => {
    const d = drag.current;
    if (!d) return;
    drag.current = null;
    if (d.last === null) { show(null, null); return; }
    if (d.last !== committed) setState(stateKey, d.last, d.gesture ? { gesture: d.gesture } : undefined);
    show(d.last, SETTLE_MS);
  };
  return (
    <div style={{ display: "contents" }}
      onPointerDownCapture={(e) => { if (commitOnRelease && !disabled && e.button === 0) drag.current = { last: null }; }}
      onPointerUp={release} onPointerCancel={release} onLostPointerCapture={release}
      onKeyDownCapture={(e) => {
        if (disabled) return;
        const k = stateKeySteps(e.key, e.shiftKey, range, spec.step);
        if (k === null) return;                   // Home/End: the dial's own
        e.preventDefault();
        e.stopPropagation();
        stepBy(k);
      }}>
      <Dial label={label} norm={stateNormOf(v, range)} display={fmt(v)} valueText={valueText?.(v)} bipolar={bipolar}
        quantize={stateQuantizer(range, spec.step)} defaultNorm={stateNormOf(spec.def, range)} testId={testId}
        disabled={disabled} inert={inert} title={disabled ? `${label}: ${NEEDS_ENGINE}` : title}
        onWheelNotches={(notches, shift) => stepBy(notches * Math.abs(stateKeySteps("ArrowUp", shift, range, spec.step)!))}
        onChange={(n, gesture) => {
          if (disabled) return;
          const value = stateValueAt(n, range, spec.step);
          if (drag.current) { drag.current = { last: value, gesture }; show(value, null); return; }
          show(value, PENDING_MS);
          setState(stateKey, value, { gesture });
        }} />
    </div>
  );
}

// ── the chorus ─────────────────────────────────────────────────────────────────────────

// Drawn 273 px wide at the 320 px inspector, so one viewBox unit is one CSS pixel and the
// 9 px axis text renders at 9 px.
export const LANE_W = 273;
const W = LANE_W, H = 40, X0 = 26, TOP = 4, BOT = 36, X1 = W - 6;
const LANE_SAMPLES = Array.from({ length: 97 }, (_, i) => i / 96);

const WOBBLE_TITLE = "Pitch wobble: the delayed voice's peak pitch drift, from rate × depth: 1200·log2(1 ± π·rate·depth) cents. "
  + "The dry voice stays in tune. 1 cycle: one LFO period.";

/** One LFO cycle of the delay the chorus reads at, 20 ms up to 20 + depth, on a labelled
 *  axis; L and R ride it width·180° apart. The dots move at the real rate but are not
 *  synced to the audio; they rest while the transport is stopped, when bypassed, and
 *  under reduced motion. Top right: what Rate and Depth make (computed, not set). */
function ChorusLane({ s, enabled }: { s: ChorusSettings; enabled: boolean }) {
  const playing = useTransportPlaying();
  const { cycles, animating } = useFreeRunningPhase(s.speedHz, enabled && playing);
  const span = chorusLaneSpan(s.depthMs);
  const y = linScale(CHORUS_BASE_MS, CHORUS_BASE_MS + span, BOT - TOP);
  // Inset on the right so a dot at the cycle's end stays inside the frame.
  const x = { to: (u: number) => X0 + u * (X1 - X0), from: (px: number) => (px - X0) / (X1 - X0) };
  const at = (u: number) => chorusDelayMs(s.depthMs, 2 * Math.PI * u);
  const curve = curvePath(at, LANE_SAMPLES, x, { to: (v) => TOP + y.to(v), from: (p) => y.from(p - TOP) });
  const uL = cycles, uR = (cycles + rightPhaseOffset(s.width)) % 1;
  const dot = (u: number) => ({ cx: x.to(u), cy: TOP + y.to(at(u)) });
  const L = dot(uL), R = dot(uR);
  const peak = CHORUS_BASE_MS + s.depthMs;
  const wobble = fmtWobble(chorusWobbleCents(s.speedHz, s.depthMs));
  return (
    <svg className={`pp-plot pp-chorus-lane${enabled ? "" : " bypassed"}${s.mix <= 0 ? " dry" : ""}`} data-testid="v3-chorus-lane"
      data-animating={animating ? "" : undefined} viewBox={`0 0 ${W} ${H}`} role="img"
      aria-label={`Chorus delay sweeps ${CHORUS_BASE_MS} to ${fmtDepthMs(peak)} once every ${fmtPeriod(s.speedHz)}; `
        + `left and right are ${widthDegrees(s.width)}° apart; the delayed voice's pitch wobbles ${wobble}. `
        + "The moving dots are illustrative at the set rate, not synced to the audio."}>
      <line className="grid" x1={X0} x2={X1} y1={TOP} y2={TOP} />
      <line className="zero" x1={X0} x2={X1} y1={BOT} y2={BOT} />
      <line className="grid" x1={x.to(0.5)} x2={x.to(0.5)} y1={TOP} y2={BOT} />
      <text className="axis" x={X0 - 3} y={TOP + 6} textAnchor="end">{CHORUS_BASE_MS + span} ms</text>
      <text className="axis" x={X0 - 3} y={BOT} textAnchor="end">{CHORUS_BASE_MS} ms</text>
      <path className="curve" d={curve} data-testid="v3-chorus-curve" />
      {/* Top right: the crest is at a quarter cycle and the second half of the cycle runs
          below the middle, so this corner is clear (haloed where a deep sweep reaches it). */}
      <text className="pp-chorus-read" x={W - 3} y={TOP + 7} textAnchor="end" data-testid="v3-chorus-readout">
        <title>{WOBBLE_TITLE}</title>
        <tspan data-testid="v3-chorus-wobble">{wobble}</tspan>
        {" · "}
        <tspan data-testid="v3-chorus-period">{fmtPeriod(s.speedHz)}</tspan> cycle
      </text>
      <g className="pp-chorus-dot r" data-testid="v3-chorus-r" data-u={uR.toFixed(4)}>
        <circle {...R} r={3} />
        <text x={R.cx} y={R.cy - 5} textAnchor="middle">R</text>
      </g>
      <g className="pp-chorus-dot l" data-testid="v3-chorus-l" data-u={uL.toFixed(4)}>
        <circle {...L} r={3} />
        <text x={L.cx} y={L.cy - 5} textAnchor="middle">L</text>
      </g>
    </svg>
  );
}

export const MINI_W = 44, MINI_H = 14;
const MINI_PAD = 2.5;

/** The minimized row's thumbnail, 44×14: one LFO cycle of the delay on the lane's own
 *  axis (so its height reads as depth), with L (filled) and R (hollow) at their resting
 *  phases, width·180° apart. Static: the expanded lane is where it moves. Muted when
 *  bypassed or all dry. */
function ChorusMini({ plugin }: PanelProps) {
  const s = chorusSettings(plugin);
  const span = chorusLaneSpan(s.depthMs);
  const P = MINI_PAD;
  const y = linScale(CHORUS_BASE_MS, CHORUS_BASE_MS + span, MINI_H - 2 * P);
  const x = { to: (u: number) => P + u * (MINI_W - 2 * P), from: (px: number) => (px - P) / (MINI_W - 2 * P) };
  const at = (u: number) => chorusDelayMs(s.depthMs, 2 * Math.PI * u);
  const yy = { to: (v: number) => P + y.to(v), from: (p: number) => y.from(p - P) };
  const d = curvePath(at, LANE_SAMPLES.filter((_, i) => i % 4 === 0), x, yy);
  const dot = (u: number) => ({ cx: x.to(u), cy: yy.to(at(u)) });
  const muted = !plugin.enabled || s.mix <= 0;
  return (
    <svg className={`pp-chorus-mini${muted ? " muted" : ""}`} data-testid="v3-chorus-mini"
      width={MINI_W} height={MINI_H} viewBox={`0 0 ${MINI_W} ${MINI_H}`} aria-hidden="true">
      <path d={d} />
      <circle className="r" data-testid="v3-chorus-mini-r" {...dot(rightPhaseOffset(s.width))} r={1.8} />
      <circle className="l" data-testid="v3-chorus-mini-l" {...dot(0)} r={1.8} />
    </svg>
  );
}

/** Chorus: the delay lane (with the pitch wobble Rate and Depth make), then Rate, Depth,
 *  Width and Mix: the dial row holds only controls. */
function ChorusPanel({ plugin, setState }: PanelProps) {
  // What the dials show before the snapshot has it (a key press, or a Depth drag, which is
  // only previewed: see below). The lane and the wobble follow it.
  const [preview, setPreview] = useState<Partial<ChorusSettings>>({});
  const snap = chorusSettings(plugin);
  const s: ChorusSettings = { ...snap };
  for (const k of Object.keys(preview) as ChorusKey[]) if (preview[k] !== undefined) s[k] = preview[k]!;
  const previewOf = (k: ChorusKey) => (v: number | null) =>
    setPreview((p) => (p[k] === (v ?? undefined) ? p : { ...p, [k]: v ?? undefined }));
  const common = { plugin, setState };
  // All dry: the sweep is not heard, so Rate, Depth and Width do nothing (still adjustable).
  const dry = s.mix <= 0;
  const dryTitle = dry ? "No effect at mix 0%: the output is all dry" : undefined;
  const oldEngine = (Object.keys(CHORUS_SPEC) as ChorusKey[]).some((k) => !stateSettable(plugin, k));
  return (
    <div className="pp-chorus" data-testid="v3-chorus">
      <ChorusLane s={s} enabled={plugin.enabled} />
      <div className="pp-chorus-ctl">
        <StateDial {...common} stateKey="speedHz" onPreview={previewOf("speedHz")} inert={dry} title={dryTitle}
          label="Rate" spec={CHORUS_SPEC.speedHz} fmt={fmtRate} testId="v3-chorus-rate"
          valueText={(v) => `${fmtRate(v)}, one sweep every ${fmtPeriod(v)}`} />
        <StateDial {...common} stateKey="depthMs" label="Depth" inert={dry} title={dryTitle} spec={CHORUS_SPEC.depthMs} fmt={fmtDepthMs} testId="v3-chorus-depth"
          // Sent once, on release: the engine re-sizes its delay ring (and can reallocate it on
          // the audio thread) on every depth change, so a value per frame would click
          // (research chorus+phaser risk 1). Keys and the wheel send one value per press.
          commitOnRelease onPreview={previewOf("depthMs")}
          valueText={(v) => `${fmtDepthMs(v)}, the delay sweeps ${CHORUS_BASE_MS} to ${fmtDepthMs(CHORUS_BASE_MS + v)}`} />
        <StateDial {...common} stateKey="width" onPreview={previewOf("width")} inert={dry} title={dryTitle}
          label="Width" spec={CHORUS_SPEC.width} fmt={fmtPct} testId="v3-chorus-width"
          valueText={(v) => `${fmtPct(v)}, left and right ${widthDegrees(v)}° apart`} />
        <StateDial {...common} stateKey="mix" onPreview={previewOf("mix")}
          label="Mix" spec={CHORUS_SPEC.mix} fmt={fmtPct} testId="v3-chorus-mix"
          valueText={(v) => `${fmtPct(v)} wet`} />
      </div>
      {oldEngine && <div className="pp-chorus-note" data-testid="v3-chorus-engine-note">{NEEDS_ENGINE}</div>}
    </div>
  );
}

export const chorusPanelDef: PanelDef = { Panel: ChorusPanel, summary: chorusSummary, Mini: ChorusMini };
