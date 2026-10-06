import { useEffect, useRef, useState } from "react";
import { Dial } from "./Dial";
import {
  CHORUS_BASE_MS, CHORUS_SPEC, WHEEL_IDLE, chorusDelayMs, chorusLaneSpan, chorusSettings, chorusSummary,
  chorusWobbleCents, fmtDepthMs, fmtPeriod, fmtRate, fmtWobble, rightPhaseOffset, stateKeySteps, stateNormOf,
  stateQuantizer, stateRange, stateStep, stateValueAt, wheelNotches, widthDegrees, type ChorusKey, type ChorusSettings, type WheelAcc,
} from "./chorus";
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
 *  engine's (which is private and resets on every graph rebuild). It stands still, at
 *  `rest`, when the plugin is bypassed (the engine's LFO freezes too) and under
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
 *  shown (Shift: one step), the wheel steps per notch, Home/End and double-click are the
 *  dial's own. With `commitOnRelease` a drag only previews and sends ONE value on release
 *  (for a setting the engine glitches on while it changes). `onPreview` reports the value
 *  shown before the snapshot has it (null when the snapshot is current). */
export function StateDial({ plugin, stateKey, label, spec, fmt, valueText, setState, bipolar, testId, commitOnRelease, onPreview }: {
  plugin: PanelProps["plugin"]; stateKey: string; label: string;
  spec: { def: number; range: Range; step: number };
  fmt: (v: number) => string; valueText?: (v: number) => string;
  setState: PanelProps["setState"]; bipolar?: boolean; testId?: string;
  commitOnRelease?: boolean; onPreview?: (v: number | null) => void;
}) {
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
    const t = stateStep(shown.current, steps, range, spec.step);
    if (t === shown.current) return;            // at an end: nothing to send
    show(t, PENDING_MS);
    keys.nudge(t);
  };
  const wheel = useRef<WheelAcc>(WHEEL_IDLE);
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
      onPointerDownCapture={(e) => { if (commitOnRelease && e.button === 0) drag.current = { last: null }; }}
      onPointerUp={release} onPointerCancel={release} onLostPointerCapture={release}
      onKeyDownCapture={(e) => {
        const k = stateKeySteps(e.key, e.shiftKey, range, spec.step);
        if (k === null) return;                   // Home/End: the dial's own
        e.preventDefault();
        e.stopPropagation();
        stepBy(k);
      }}
      onWheelCapture={(e) => {
        const d = e.deltaY !== 0 ? e.deltaY : e.shiftKey ? e.deltaX : 0;   // Shift+wheel arrives as deltaX on macOS
        if (d === 0) return;
        e.stopPropagation();
        const r = wheelNotches(wheel.current, d, e.deltaMode, performance.now());
        wheel.current = r.acc;
        if (r.notches) stepBy(r.notches * Math.abs(stateKeySteps("ArrowUp", e.shiftKey, range, spec.step)!));
      }}>
      <Dial label={label} norm={stateNormOf(v, range)} display={fmt(v)} valueText={valueText?.(v)} bipolar={bipolar}
        quantize={stateQuantizer(range, spec.step)} defaultNorm={stateNormOf(spec.def, range)} size={34} testId={testId}
        onChange={(n, gesture) => {
          const value = stateValueAt(n, range, spec.step);
          if (drag.current) { drag.current = { last: value, gesture }; show(value, null); return; }
          show(value, PENDING_MS);
          setState(stateKey, value, { gesture });
        }} />
    </div>
  );
}

// ── the chorus ─────────────────────────────────────────────────────────────────────────

const W = 286, H = 40, X0 = 26, TOP = 4, BOT = 36;
const LANE_SAMPLES = Array.from({ length: 97 }, (_, i) => i / 96);

/** One LFO cycle of the delay the chorus reads at, 20 ms up to 20 + depth, on a labelled
 *  axis; L and R ride it width·180° apart. The dots move at the real rate but are not
 *  synced to the audio, and stop when bypassed or under reduced motion. */
function ChorusLane({ s, enabled }: { s: ChorusSettings; enabled: boolean }) {
  const { cycles, animating } = useFreeRunningPhase(s.speedHz, enabled);
  const span = chorusLaneSpan(s.depthMs);
  const y = linScale(CHORUS_BASE_MS, CHORUS_BASE_MS + span, BOT - TOP);
  const x = { to: (u: number) => X0 + u * (W - X0 - 2), from: (px: number) => (px - X0) / (W - X0 - 2) };
  const at = (u: number) => chorusDelayMs(s.depthMs, 2 * Math.PI * u);
  const curve = curvePath(at, LANE_SAMPLES, x, { to: (v) => TOP + y.to(v), from: (p) => y.from(p - TOP) });
  const uL = cycles, uR = (cycles + rightPhaseOffset(s.width)) % 1;
  const dot = (u: number) => ({ cx: x.to(u), cy: TOP + y.to(at(u)) });
  const L = dot(uL), R = dot(uR);
  const peak = CHORUS_BASE_MS + s.depthMs;
  return (
    <svg className={`pp-plot pp-chorus-lane${enabled ? "" : " bypassed"}`} data-testid="v3-chorus-lane"
      data-animating={animating ? "" : undefined} viewBox={`0 0 ${W} ${H}`} role="img"
      aria-label={`Chorus delay sweeps ${CHORUS_BASE_MS} to ${fmtDepthMs(peak)} once every ${fmtPeriod(s.speedHz)}; `
        + `left and right are ${widthDegrees(s.width)}° apart. The moving dots are illustrative at the set rate, not synced to the audio.`}>
      <line className="grid" x1={X0} x2={W - 2} y1={TOP} y2={TOP} />
      <line className="zero" x1={X0} x2={W - 2} y1={BOT} y2={BOT} />
      <line className="grid" x1={x.to(0.5)} x2={x.to(0.5)} y1={TOP} y2={BOT} />
      <text className="axis" x={X0 - 3} y={TOP + 5} textAnchor="end">{CHORUS_BASE_MS + span} ms</text>
      <text className="axis" x={X0 - 3} y={BOT} textAnchor="end">{CHORUS_BASE_MS} ms</text>
      <text className="axis" x={W - 3} y={H - 0.5} textAnchor="end">1 cycle = {fmtPeriod(s.speedHz)}</text>
      <path className="curve" d={curve} data-testid="v3-chorus-curve" />
      <g className="pp-chorus-dot r" data-testid="v3-chorus-r" data-u={uR.toFixed(4)}>
        <circle {...R} r={3} />
        <text x={R.cx} y={R.cy - 4.5} textAnchor="middle">R</text>
      </g>
      <g className="pp-chorus-dot l" data-testid="v3-chorus-l" data-u={uL.toFixed(4)}>
        <circle {...L} r={3} />
        <text x={L.cx} y={L.cy - 4.5} textAnchor="middle">L</text>
      </g>
    </svg>
  );
}

/** Chorus: the delay lane, then Rate, Depth, Width and Mix with the pitch wobble they make. */
function ChorusPanel({ plugin, setState }: PanelProps) {
  // What the dials show before the snapshot has it (a key press, or a Depth drag, which is
  // only previewed: see below). The lane and the wobble follow it.
  const [preview, setPreview] = useState<Partial<ChorusSettings>>({});
  const snap = chorusSettings(plugin);
  const s: ChorusSettings = { ...snap };
  for (const k of Object.keys(preview) as ChorusKey[]) if (preview[k] !== undefined) s[k] = preview[k]!;
  const wobble = fmtWobble(chorusWobbleCents(s.speedHz, s.depthMs));
  const previewOf = (k: ChorusKey) => (v: number | null) =>
    setPreview((p) => (p[k] === (v ?? undefined) ? p : { ...p, [k]: v ?? undefined }));
  const common = { plugin, setState };
  return (
    <div className="pp-chorus" data-testid="v3-chorus">
      <ChorusLane s={s} enabled={plugin.enabled} />
      <div className="pp-chorus-ctl">
        <StateDial {...common} stateKey="speedHz" onPreview={previewOf("speedHz")}
          label="Rate" spec={CHORUS_SPEC.speedHz} fmt={fmtRate} testId="v3-chorus-rate"
          valueText={(v) => `${fmtRate(v)}, one sweep every ${fmtPeriod(v)}`} />
        <StateDial {...common} stateKey="depthMs" label="Depth" spec={CHORUS_SPEC.depthMs} fmt={fmtDepthMs} testId="v3-chorus-depth"
          // Sent once, on release: the engine re-sizes its delay ring (and can reallocate it on
          // the audio thread) on every depth change, so a value per frame would click
          // (research chorus+phaser risk 1). Keys and the wheel send one value per press.
          commitOnRelease onPreview={previewOf("depthMs")}
          valueText={(v) => `${fmtDepthMs(v)}, the delay sweeps ${CHORUS_BASE_MS} to ${fmtDepthMs(CHORUS_BASE_MS + v)}`} />
        <StateDial {...common} stateKey="width" onPreview={previewOf("width")}
          label="Width" spec={CHORUS_SPEC.width} fmt={fmtPct} testId="v3-chorus-width"
          valueText={(v) => `${fmtPct(v)}, left and right ${widthDegrees(v)}° apart`} />
        <StateDial {...common} stateKey="mix" onPreview={previewOf("mix")}
          label="Mix" spec={CHORUS_SPEC.mix} fmt={fmtPct} testId="v3-chorus-mix"
          valueText={(v) => `${fmtPct(v)} wet`} />
        <div className={`pp-chorus-wob${s.mix <= 0 ? " dry" : ""}`} data-testid="v3-chorus-wobble"
          title="The delayed voice's peak pitch drift, from rate × depth: 1200·log2(1 ± π·rate·depth) cents. The dry voice stays in tune.">
          <span className="v">{wobble}</span>
          <span className="nm">pitch wobble</span>
        </div>
      </div>
    </div>
  );
}

export const chorusPanelDef: PanelDef = { Panel: ChorusPanel, summary: chorusSummary };
