import { useEffect, useRef, useState, type KeyboardEvent, type PointerEvent } from "react";
import { DragNode } from "./DragNode";
import { logFreqs } from "./dsp";
import {
  CUTOFF_PARAM, FILTER_FACTS, PLOT_H, PLOT_LO_HZ, PLOT_W, canSetMode, clampCutoff, cutoffAtX, cutoffHz, cutoffNorm,
  defaultCutoff, filterMode, filterSummary, handleX, isUnstable, maxCutoff, parseHz, plotScales,
  responseDb, stepCutoff, CUTOFF_RANGE, type FilterMode,
} from "./filter";
import { clamp, fmtFreq, param } from "./params";
import { clientToSvg, curvePath, fillPath } from "./plot";
import type { PanelDef, PanelProps } from "./types";
import { useDragSend } from "./useDragSend";

const MODES: { mode: FilterMode; short: string; long: string }[] = [
  { mode: "lowpass", short: "LP", long: "Low-pass" },
  { mode: "highpass", short: "HP", long: "High-pass" },
];
const GRID_HZ = [100, 1000, 10000];
const GRID_DB = [-12, -24];
const AXIS_LABEL: Record<number, string> = { 100: "100", 1000: "1k", 10000: "10k" };
/** The minimized row's thumbnail slot. */
export const MINI_W = 44, MINI_H = 14;
/** How long a keyboard/typed value stays on screen at most while the engine's patch arrives. */
const PENDING_MS = 800;
/** Two cutoffs closer than this are the same value (a normalised float round trip). */
const SAME_HZ = 0.05;

/** Arrow keys: 1/12 octave (Shift: an octave); PageUp/Down: an octave; Home/End: the ends. */
export function keyTarget(e: Pick<KeyboardEvent, "key" | "shiftKey">, hz: number, fs: number): number | null {
  const step = e.shiftKey ? 12 : 1;
  switch (e.key) {
    case "ArrowUp": case "ArrowRight": return stepCutoff(hz, step, fs);
    case "ArrowDown": case "ArrowLeft": return stepCutoff(hz, -step, fs);
    case "PageUp": return stepCutoff(hz, 12, fs);
    case "PageDown": return stepCutoff(hz, -12, fs);
    case "Home": return clampCutoff(CUTOFF_RANGE.min, fs);
    case "End": return maxCutoff(fs);
    default: return null;
  }
}

/** The cutoff read-out, which is also where you type one: it reads "4.00 kHz" at rest and
 *  turns into the plain number on focus. Type "120", "1.2k" or "1.2 kHz", Enter to set; the
 *  arrow keys step it like the handle. */
function CutoffField({ hz, warn, onSet, onStep }: { hz: number; warn: boolean; onSet: (hz: number) => void; onStep: (from: number, e: KeyboardEvent<HTMLInputElement>) => number | null }) {
  const [draft, setDraft] = useState<string | null>(null);
  // Only what was TYPED is sent on Enter/blur; an arrow step has already been sent.
  const typed = useRef(false);
  const cancelled = useRef(false);
  const commit = () => {
    if (draft !== null && typed.current && !cancelled.current) {
      const v = parseHz(draft);
      if (v !== null) onSet(v);
    }
    typed.current = false;
    cancelled.current = false;
    setDraft(null);
  };
  return (
    <label className={`pp-filter-hz${warn ? " warn" : ""}`} title="Cutoff frequency: click to type a value (e.g. 120 or 1.2k), Enter to set">
      <input data-testid="v3-filter-hz" inputMode="decimal" spellCheck={false} aria-label="Cutoff frequency (Hz)"
        value={draft ?? fmtFreq(hz)}
        // While typing, the field hugs the number so the unit sits right after it.
        style={draft !== null ? { width: `${Math.max(3, draft.length) + 1}ch` } : undefined}
        onFocus={(e) => { setDraft(String(Math.round(hz))); e.currentTarget.select(); }}
        onChange={(e) => { typed.current = true; setDraft(e.target.value); }}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === "Enter") { e.preventDefault(); e.currentTarget.blur(); return; }
          if (e.key === "Escape") { e.preventDefault(); cancelled.current = true; e.currentTarget.blur(); return; }
          if (e.key !== "ArrowUp" && e.key !== "ArrowDown") return;
          const from = (typed.current && draft !== null ? parseHz(draft) : null) ?? hz;
          const to = onStep(from, e);
          if (to !== null) { typed.current = false; setDraft(String(Math.round(to))); }
        }} />
      {draft !== null && <span className="pp-filter-unit">Hz</span>}
    </label>
  );
}

/** The response: the engine's exact biquad on a log axis, its passband filled, and a handle
 *  at (cutoff, -3 dB) that drags along the frequency axis. Bypassed draws the truth: flat.
 *  A cutoff above Nyquist draws no curve: the engine's filter is unstable there. */
function ResponsePlot({ mode, fc, fs, enabled, onDragStart, onDrag, onDragEnd, onKey, onReset }: {
  mode: FilterMode; fc: number; fs: number; enabled: boolean;
  onDragStart: () => void; onDrag: (hz: number) => void; onDragEnd: () => void;
  onKey: (e: KeyboardEvent<SVGGElement>) => boolean; onReset: () => void;
}) {
  const { x, y, top } = plotScales(fs);
  const unstable = isUnstable(fc, fs);
  // 96 biquad evaluations: cheap enough to redo on every drag frame.
  const curve = unstable ? "" : curvePath((f) => (enabled ? responseDb(mode, fc, f, fs) : 0), logFreqs(96, PLOT_LO_HZ, top), x, y, 0, PLOT_H);
  // The handle sits ON the curve: at (cutoff, -3 dB), or at the plot's edge when the cutoff
  // is past it (the parameter reaches 10 Hz and 22 kHz; the plot shows 20 Hz..20 kHz).
  const hx = handleX(fc, fs);
  const hy = y.to(unstable ? -3.0103 : enabled ? responseDb(mode, fc, clamp(fc, PLOT_LO_HZ, top), fs) : 0);
  const svgRef = useRef<SVGSVGElement>(null);
  const dragging = useRef(false);
  // Where the pointer went down (viewBox x), captured before the handle stops the event, so
  // a handle drag moves the cutoff by the pointer's travel instead of jumping to it.
  const pressX = useRef<number | null>(null);
  const grab = useRef<{ x0: number; ux0: number } | null>(null);
  const atPointer = (e: PointerEvent<SVGSVGElement>) => cutoffAtX(clientToSvg(e.currentTarget, e.clientX, e.clientY).x, fs);
  const finish = () => { if (dragging.current) { dragging.current = false; onDragEnd(); } };
  const label = MODES.find((m) => m.mode === mode)!.long;
  return (
    <svg ref={svgRef} className={`pp-plot pp-filter-plot${enabled ? "" : " bypassed"}${unstable ? " unstable" : ""}`} data-testid="v3-filter-plot"
      viewBox={`0 0 ${PLOT_W} ${PLOT_H}`} role="group" aria-label={`${label} response`}
      onPointerDownCapture={(e) => { pressX.current = clientToSvg(e.currentTarget, e.clientX, e.clientY).x; }}
      onPointerDown={(e) => {
        // A press on the plot (not the handle) moves the cutoff there and keeps dragging.
        if (e.button !== 0) return;
        e.preventDefault();
        e.currentTarget.setPointerCapture?.(e.pointerId);
        dragging.current = true;
        onDragStart();
        onDrag(atPointer(e));
      }}
      onPointerMove={(e) => { if (dragging.current) onDrag(atPointer(e)); }}
      onPointerUp={finish} onPointerCancel={finish} onLostPointerCapture={finish}>
      <title>{`Drag to set the cutoff. Arrows: 1/12 octave, Shift: an octave. Double-click the handle for ${fmtFreq(defaultCutoff(mode))}.`}</title>
      {GRID_HZ.filter((f) => f < top).map((f) => (
        <line key={f} className="grid" x1={x.to(f)} x2={x.to(f)} y1={0} y2={PLOT_H} />
      ))}
      {GRID_DB.map((db) => (
        <line key={db} className="grid" x1={0} x2={PLOT_W} y1={y.to(db)} y2={y.to(db)} />
      ))}
      <line className="zero" x1={0} x2={PLOT_W} y1={y.to(0)} y2={y.to(0)} />
      {!unstable && <path className="area" d={fillPath(curve, 0, PLOT_W, PLOT_H)} />}
      {!unstable && <path className="curve" d={curve} data-testid="v3-filter-curve" />}
      {unstable && (
        <text className="pp-filter-warn" data-testid="v3-filter-unstable" x={PLOT_W / 2} y={PLOT_H / 2 - 4} textAnchor="middle">
          <tspan x={PLOT_W / 2}>{`Above Nyquist (${fmtFreq(fs / 2)} here): the filter is unstable`}</tspan>
          <tspan x={PLOT_W / 2} dy={11}>Press End or type a value to bring it back</tspan>
        </text>
      )}
      <line className="pp-filter-fc" x1={hx} x2={hx} y1={0} y2={PLOT_H} />
      {/* The axis labels go over the curve and the cutoff guide (their halo keeps them
          legible where the roll-off passes), and under the handle. */}
      <g className="pp-filter-axes" data-testid="v3-filter-axes">
        {GRID_HZ.filter((f) => f < top).map((f) => (
          <text key={f} className="axis" x={x.to(f) + 2} y={PLOT_H - 2}>{AXIS_LABEL[f]}</text>
        ))}
        {GRID_DB.map((db) => (
          <text key={db} className="axis" x={PLOT_W - 2} y={y.to(db) - 1.5} textAnchor="end">{db}</text>
        ))}
        <text className="axis pp-filter-db0" x={PLOT_W - 2} y={y.to(0) - 1.5} textAnchor="end">0</text>
      </g>
      <DragNode x={hx} y={hy} r={4.5} hollow={!enabled || unstable} testId="v3-filter-handle"
        ariaLabel={`${label} cutoff`}
        ariaValueText={`${fmtFreq(fc)}, ${unstable ? "above Nyquist: unstable" : FILTER_FACTS}`}
        valueNow={Math.round(fc)} valueMin={CUTOFF_RANGE.min} valueMax={Math.round(Math.max(maxCutoff(fs), fc))}
        onStart={() => {
          // Relative drag: remember the press and the cutoff's (unclamped) axis position.
          grab.current = { x0: pressX.current ?? hx, ux0: x.to(fc) };
          onDragStart();
        }}
        onMove={(pt) => {
          const g = grab.current;
          onDrag(cutoffAtX(g ? g.ux0 + (pt.x - g.x0) : pt.x, fs));
        }}
        onEnd={() => { grab.current = null; onDragEnd(); }}
        onKeyDown={onKey} onDoubleClick={onReset} />
    </svg>
  );
}

/** Low-pass / high-pass: LP|HP, the cutoff as a number, the fixed slope, and the response.
 *  An older engine (no `state.mode`) cannot switch LP/HP: the switch shows the type it
 *  reports, disabled, with a note; the cutoff (a plain parameter) still works. */
function FilterPanel({ plugin, sampleRate, setParam, setState }: PanelProps) {
  const fs = sampleRate > 0 ? sampleRate : 48000;
  const mode = filterMode(plugin);
  const modeSettable = canSetMode(plugin);
  const automated = !!param(plugin, CUTOFF_PARAM)?.automated;
  const drag = useDragSend<number>((hz, gesture) => setParam(CUTOFF_PARAM, cutoffNorm(plugin, hz, fs), { gesture }));
  const snapHz = cutoffHz(plugin);
  // A key or a typed value is sent at once; show it until the engine's patch catches up,
  // and step the next key from it (not from the snapshot that has not caught up yet).
  const [pending, setPending] = useState<number | null>(null);
  // What was sent while `pending` is shown, oldest first: tells our own echoes apart from
  // a change made elsewhere (undo, an agent, automation).
  const sent = useRef<number[]>([]);
  const dropPending = () => { sent.current = []; setPending(null); };
  useEffect(() => {
    if (pending === null) return;
    const t = setTimeout(dropPending, PENDING_MS);
    return () => clearTimeout(t);
  }, [pending]);
  const lastSnap = useRef(snapHz);
  useEffect(() => {
    if (Math.abs(lastSnap.current - snapHz) < SAME_HZ) return;
    lastSnap.current = snapHz;
    if (!sent.current.length) return;
    const same = (v: number) => Math.abs(v - snapHz) < SAME_HZ;
    // Caught up with the latest send, or moved somewhere we never sent: the snapshot wins
    // at once. An echo of an earlier key in the same burst keeps the newer pending value.
    if (same(sent.current[sent.current.length - 1]) || !sent.current.some(same)) dropPending();
  }, [snapHz]);
  // The newest intent wins: a key/typed value over a settling drag (a drag start clears it).
  const fc = pending ?? drag.live ?? snapHz;
  const send = (hz: number) => {
    const v = clampCutoff(hz, fs);
    sent.current.push(v);
    setPending(v);
    drag.nudge(v);
  };
  const dragStart = () => { dropPending(); drag.begin(); };
  const onKey = (e: KeyboardEvent<Element>): boolean => {
    const t = keyTarget(e, fc, fs);
    if (t === null) return false;
    // The handle is not a text field, so the app's global shortcuts would also see this
    // key (Home/End move the playhead, arrows nudge selected clips). It is ours.
    e.preventDefault();
    e.stopPropagation();
    send(t);
    return true;
  };
  return (
    <div className="pp-filter" data-testid="v3-filter" data-mode={mode}>
      <div className="pp-filter-top">
        <div className="pp-seg pp-filter-seg" role="group" aria-label="Filter type">
          {MODES.map((m) => (
            <button key={m.mode} type="button" data-testid={`v3-filter-mode-${m.mode}`} aria-pressed={mode === m.mode}
              aria-label={`${m.short} (${m.long})`} title={modeSettable ? m.long : `${m.long}: switching needs the updated Mosh engine`}
              disabled={!modeSettable}
              onClick={() => { if (modeSettable && mode !== m.mode) setState("mode", m.mode); }}>{m.short}</button>
          ))}
        </div>
        <CutoffField hz={fc} warn={isUnstable(fc, fs)} onSet={send} onStep={(from, e) => {
          const t = keyTarget(e, from, fs);
          if (t !== null) { e.preventDefault(); send(t); }
          return t;
        }} />
        {automated && <span className="pp-filter-auto" data-testid="v3-filter-automated" role="img"
          aria-label="Cutoff automated: during playback the automation lane overrides edits here"
          title="Automated: during playback the automation lane sets the cutoff and overrides edits here">auto</span>}
        <span className="pp-filter-facts" title="One 2nd-order Butterworth stage (Q 0.707): fixed in the engine">{FILTER_FACTS}</span>
      </div>
      {!modeSettable && <div className="pp-filter-note" data-testid="v3-filter-old-engine">LP/HP switch needs the updated Mosh engine</div>}
      <ResponsePlot mode={mode} fc={fc} fs={fs} enabled={plugin.enabled}
        onDragStart={dragStart} onDrag={(hz) => drag.update(hz)} onDragEnd={drag.end}
        onKey={onKey} onReset={() => send(defaultCutoff(mode))} />
    </div>
  );
}

/** The minimized row's thumbnail: the same exact curve, 44×14, no handle. Above Nyquist
 *  (unstable in the engine) it draws no curve, only a dashed warning baseline. */
function FilterMini({ plugin, sampleRate }: PanelProps) {
  const fs = sampleRate > 0 ? sampleRate : 48000;
  const mode = filterMode(plugin), fc = cutoffHz(plugin);
  const unstable = isUnstable(fc, fs);
  const W = MINI_W, H = MINI_H;
  const { x, y, top } = plotScales(fs, W, H);
  const d = unstable ? "" : curvePath((f) => (plugin.enabled ? responseDb(mode, fc, f, fs) : 0), logFreqs(24, PLOT_LO_HZ, top), x, y, 0, H);
  return (
    <svg className={`pp-filter-mini${plugin.enabled ? "" : " bypassed"}${unstable ? " unstable" : ""}`} data-testid="v3-filter-mini"
      width={W} height={H} viewBox={`0 0 ${W} ${H}`} aria-hidden="true">
      <line className="z" x1={0} x2={W} y1={y.to(0)} y2={y.to(0)} />
      {!unstable && <path d={d} />}
    </svg>
  );
}

export const filterPanelDef: PanelDef = {
  // The engine calls it "LPF/HPF" or "High-Pass" by mode; the LP|HP switch says which.
  title: "Filter",
  Panel: FilterPanel,
  summary: filterSummary,
  Mini: FilterMini,
};
