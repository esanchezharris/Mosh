import { useState, type KeyboardEvent } from "react";
import { useStore } from "../../store";
import { Dial } from "./Dial";
import { DragNode } from "./DragNode";
import { clamp, fmtDb, fmtPct } from "./params";
import {
  DEFAULTS, FREEZE_PARAM, HF_HZ, ONSET_S, PLOT, dampingForHfRt60, decayAxes, decayGeometry, fmtSec, plotSpan,
  reverbModel, reverbSummary, sizeForRt60, type ReverbModel,
} from "./reverb";
import type { PanelDef, PanelProps } from "./types";
import { useDragSend } from "./useDragSend";

/** Arrow keys ±1 % (Shift ±0.1 %), PageUp/Down ±10 %, Home/End: for the plot handles. */
function stepKey(e: KeyboardEvent, norm: number, nudge: (v: number) => void) {
  const fine = e.shiftKey ? 0.1 : 1;
  const map: Record<string, number> = {
    ArrowUp: 0.01 * fine, ArrowRight: 0.01 * fine, ArrowDown: -0.01 * fine, ArrowLeft: -0.01 * fine, PageUp: 0.1, PageDown: -0.1,
  };
  let next: number | null = null;
  if (e.key in map) next = norm + map[e.key];
  else if (e.key === "Home") next = 0;
  else if (e.key === "End") next = 1;
  if (next === null) return;
  e.preventDefault();
  nudge(clamp(next, 0, 1));
}

/** Grid lines every 0.25 s, 1 s or 2 s depending on the span. */
const gridStep = (span: number) => (span <= 2 ? 0.25 : span <= 6 ? 1 : 2);

/** The decay display: the tail's shape from the comb/damping maths, with a handle at the
 *  low-frequency tail's end (Size) and one halfway down the 8 kHz line (Damping). */
function DecayPlot({ m, span, enabled, onSize, onDamping, onDragStart, onDragEnd, sizeKey, dampKey }: {
  m: ReverbModel; span: number; enabled: boolean;
  onSize: (norm: number) => void; onDamping: (norm: number) => void;
  onDragStart: (which: "size" | "damp") => void; onDragEnd: (which: "size" | "damp") => void;
  sizeKey: (e: KeyboardEvent) => void; dampKey: (e: KeyboardEvent) => void;
}) {
  const a = decayAxes(span);
  const g = decayGeometry(m.rtLow, m.rtHigh, span);
  const top = a.dy(0);
  const step = gridStep(span);
  const ticks: number[] = [];
  for (let t = step; t < span - 1e-6; t += step) ticks.push(t);
  const label = m.frozen
    ? "Decay: frozen, the tail sustains forever and the input is cut"
    : `Decay: about ${fmtSec(m.rtLow)} at low frequencies, ${fmtSec(m.rtHigh)} at 8 kHz`;
  return (
    <svg className={`pp-plot pp-reverb-plot${enabled ? "" : " bypassed"}${m.frozen ? " frozen" : ""}`}
      viewBox={`0 0 ${PLOT.w} ${PLOT.h}`} data-testid="pp-reverb-plot" role="group" aria-label={label}>
      {ticks.map((t) => <line key={t} className="grid" x1={a.tx(t)} x2={a.tx(t)} y1={top} y2={a.bottom} />)}
      {[-20, -40].map((db) => <line key={db} className="grid" x1={PLOT.padX} x2={a.right} y1={a.dy(db)} y2={a.dy(db)} />)}
      <line className="zero" x1={PLOT.padX} x2={a.right} y1={a.bottom} y2={a.bottom} />
      {/* The combs' built-in delay before the first reflection (there is no pre-delay). */}
      <rect className="pp-reverb-onset" x={PLOT.padX} y={top} width={Math.max(0, g.onsetX - PLOT.padX)} height={a.bottom - top}>
        <title>{`First reflection after ${Math.round(ONSET_S * 1000)} ms (the combs' own delay; no pre-delay)`}</title>
      </rect>
      {m.frozen ? (
        <>
          <line className="curve" data-testid="pp-reverb-frozen" x1={g.onsetX} x2={a.right} y1={top + 0.8} y2={top + 0.8} />
          <text className="pp-reverb-read" x={a.right - 2} y={top + 11} textAnchor="end">∞ frozen · input cut</text>
        </>
      ) : (
        <>
          <path className="area" d={g.wedge} />
          <line className="pp-reverb-hf" x1={g.onsetX} y1={top} x2={g.high.x} y2={g.high.y} />
          <line className="curve" x1={g.onsetX} y1={top} x2={g.low.x} y2={g.low.y} />
          <text className="pp-reverb-read" x={a.right - 2} y={top + 8} textAnchor="end" data-testid="pp-reverb-decay">~{fmtSec(m.rtLow)}</text>
          <text className="pp-reverb-read hf" x={a.right - 2} y={top + 17} textAnchor="end">{`8k ${fmtSec(m.rtHigh)}`}</text>
          <DragNode x={g.highMid.x} y={g.highMid.y} r={3.5} testId="pp-reverb-damp-node"
            ariaLabel="Damping (8 kHz decay)" ariaValueText={`${fmtPct(m.damping)}, highs ${fmtSec(m.rtHigh)}`} valueNow={m.damping * 100} valueMin={0} valueMax={100}
            onStart={() => onDragStart("damp")} onEnd={() => onDragEnd("damp")} onKeyDown={dampKey}
            onMove={(pt) => onDamping(2 * Math.max(0, a.xt(pt.x) - ONSET_S))} />
          <DragNode x={g.low.x} y={g.low.y} r={4} testId="pp-reverb-size-node"
            ariaLabel="Size (decay time)" ariaValueText={`${fmtPct(m.size)}, about ${fmtSec(m.rtLow)}`} valueNow={m.size * 100} valueMin={0} valueMax={100}
            onStart={() => onDragStart("size")} onEnd={() => onDragEnd("size")} onKeyDown={sizeKey}
            onMove={(pt) => onSize(Math.max(0, a.xt(pt.x) - ONSET_S))} />
        </>
      )}
    </svg>
  );
}

/** Tracktion Reverb (FreeVerb): decay shape, the five controls with real units, Freeze. */
function ReverbPanel({ plugin, sampleRate, setParam }: PanelProps) {
  const sizeDrag = useDragSend<number>((v, gesture) => setParam(0, v, { gesture }));
  const dampDrag = useDragSend<number>((v, gesture) => setParam(1, v, { gesture }));
  // While a handle is dragged the time axis holds still, or the handle would chase itself.
  const [held, setHeld] = useState<number | null>(null);
  const m = reverbModel(plugin, sampleRate, {
    ...(sizeDrag.live !== null ? { 0: sizeDrag.live } : {}),
    ...(dampDrag.live !== null ? { 1: dampDrag.live } : {}),
  });
  const span = held ?? plotSpan(m.rtLowSet);
  const set = (i: number) => (norm: number, gesture: string) => setParam(i, norm, { gesture });
  const frozenNote = m.frozen ? "No effect while Freeze is on" : undefined;
  // Screen readers hear the same note on the sliders themselves (the title is on a wrapper).
  const frozenSuffix = m.frozen ? ", no effect while Freeze is on" : "";
  return (
    <div className="pp-reverb" data-testid="pp-reverb">
      <DecayPlot m={m} span={span} enabled={plugin.enabled}
        onDragStart={(which) => { setHeld(span); (which === "size" ? sizeDrag : dampDrag).begin(); }}
        onDragEnd={(which) => { (which === "size" ? sizeDrag : dampDrag).end(); setHeld(null); }}
        onSize={(rt) => sizeDrag.update(sizeForRt60(rt))}
        onDamping={(rt) => dampDrag.update(dampingForHfRt60(rt, m.size, sampleRate || 48000))}
        sizeKey={(e) => stepKey(e, m.size, sizeDrag.nudge)}
        dampKey={(e) => stepKey(e, m.damping, dampDrag.nudge)} />
      <div className="pp-reverb-ctl">
        <span className={m.frozen ? "pp-reverb-held" : undefined} title={frozenNote}>
          <Dial label="Size" size={30} norm={m.size} defaultNorm={DEFAULTS.size} testId="pp-reverb-size"
            display={`~${fmtSec(m.rtLowSet)}`} valueText={`${fmtPct(m.size)}, low decay about ${fmtSec(m.rtLowSet)}${frozenSuffix}`}
            onChange={set(0)} />
        </span>
        <span className={m.frozen ? "pp-reverb-held" : undefined} title={frozenNote}>
          <Dial label="Damping" size={30} norm={m.damping} defaultNorm={DEFAULTS.damping} testId="pp-reverb-damping"
            display={fmtPct(m.damping)} valueText={`${fmtPct(m.damping)}, highs decay ${fmtSec(m.rtHighSet)} at ${HF_HZ / 1000} kHz${frozenSuffix}`}
            onChange={set(1)} />
        </span>
        <Dial label="Wet" size={30} norm={m.wet} defaultNorm={DEFAULTS.wet} testId="pp-reverb-wet"
          display={fmtDb(m.wetDb)} onChange={set(2)} />
        <Dial label="Dry" size={30} norm={m.dry} defaultNorm={DEFAULTS.dry} testId="pp-reverb-dry"
          display={fmtDb(m.dryDb)} onChange={set(3)} />
        <Dial label="Width" size={30} norm={m.width} defaultNorm={DEFAULTS.width} testId="pp-reverb-width"
          display={fmtPct(m.width)} valueText={`${fmtPct(m.width)} stereo width`} onChange={set(4)} />
        <button type="button" className="pp-reverb-freeze" data-testid="pp-reverb-freeze" aria-pressed={m.frozen}
          title={m.frozen ? "Frozen: the tail holds forever and new input is cut. Click to release." : "Freeze: hold the current tail forever and cut new input"}
          onClick={() => setParam(FREEZE_PARAM, m.frozen ? 0 : 1)}>
          <span className="g" aria-hidden="true">∞</span>
          <span className="nm">Freeze</span>
        </button>
      </div>
    </div>
  );
}

const MINI = { w: 36, h: 12, span: 4 };

/** Minimized: the decay wedge on a fixed 0-4 s scale (so a longer room reads longer). */
function ReverbMini({ plugin, sampleRate }: PanelProps) {
  const m = reverbModel(plugin, sampleRate);
  const x = (rt: number) => (Number.isFinite(rt) ? Math.min(MINI.w, (rt / MINI.span) * MINI.w) : MINI.w);
  const y = (rt: number) => (Number.isFinite(rt) && rt <= MINI.span ? MINI.h : (Number.isFinite(rt) ? (MINI.h * MINI.span) / rt : 0.5));
  // A low decay longer than the scale leaves the right edge above the floor: close the
  // wedge through the bottom-right corner (as decayGeometry does for the full plot).
  const corner = Number.isFinite(m.rtLow) && m.rtLow > MINI.span ? ` L${MINI.w} ${MINI.h}` : "";
  const d = m.frozen
    ? `M0 0.5 L${MINI.w} 0.5 L${MINI.w} ${MINI.h} L0 ${MINI.h} Z`
    : `M0 0 L${x(m.rtLow).toFixed(1)} ${y(m.rtLow).toFixed(1)}${corner} L${x(m.rtHigh).toFixed(1)} ${y(m.rtHigh).toFixed(1)} Z`;
  return (
    <svg className={`pp-reverb pp-reverb-mini${plugin.enabled ? "" : " bypassed"}`} width={MINI.w} height={MINI.h}
      viewBox={`0 0 ${MINI.w} ${MINI.h}`} aria-hidden="true" data-testid="pp-reverb-mini">
      <path d={d} />
    </svg>
  );
}

export const reverbPanelDef: PanelDef = {
  Panel: ReverbPanel,
  // The 8 kHz decay depends on the session rate; the row re-renders on every snapshot.
  summary: (plugin) => reverbSummary(plugin, useStore.getState().snapshot?.session?.sampleRate || 48000),
  Mini: ReverbMini,
};
