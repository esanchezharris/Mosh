import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import { useStore } from "../../store";
import type { PluginMeterReading } from "../../types";
import { Dial } from "./Dial";
import { usePluginMeter } from "./meters";
import { fmtDb, fmtMs, normOf, param, type Range } from "./params";
import { curvePath, fillPath, freqScale, linScale } from "./plot";
import type { PanelDef, PanelProps } from "./types";
import {
  XF_BAND_HZ, XF_DEFAULTS, XF_DEPTH_AXIS_DB, XF_MIN_BLOCK, XF_PARAM, XF_RANGES, XF_SCORE_MAX, XF_STATUS_CHIPS,
  xfAppliedDb, xfCurveFreqs, xfCutsDb, xfCutsNorm, xfMeterOf, xfSettings, xfStatus, xfSummary, xfThreshold, xfTopHz,
  xfVisibleChips,
} from "./xfeedback";

const W = 286, H = 36;
const TICKS = [500, 1000, 2000, 5000];
const tickLabel = (hz: number) => (hz >= 1000 ? `${hz / 1000}k` : `${hz}`);

/** The ring strip and the status line under it, from the 30 Hz meter rail: candidates rise
 *  from the floor to their detector score (the dashed line is the threshold Sensitivity
 *  sets), and the notches being cut hang from the top at their real depth, drawn from the
 *  engine's own Q = 30 notch. Subscribes to this plugin's frame only. */
function XfLive({ trackId, index, itemId, enabled, threshold, auto, mix, sampleRate }: {
  trackId: string; index: number; itemId?: string; enabled: boolean; threshold: number; auto: boolean; mix: number; sampleRate: number;
}) {
  const meter = xfMeterOf(usePluginMeter<PluginMeterReading>(trackId, index), itemId);
  const top = xfTopHz(sampleRate);
  const x = freqScale(XF_BAND_HZ.lo, top, W);
  const y = linScale(0, XF_SCORE_MAX, H);
  const cuts = (meter?.cuts ?? []).filter((c) => Number.isFinite(c.hz) && Number.isFinite(c.depthDb));
  const cands = (meter?.candidates ?? []).filter((c) => Number.isFinite(c.hz) && Number.isFinite(c.score));
  const depthY = (db: number) => (Math.min(XF_DEPTH_AXIS_DB, Math.max(0, -db)) / XF_DEPTH_AXIS_DB) * H;
  const curve = cuts.length
    ? curvePath((f) => xfCutsDb(f, cuts, mix, sampleRate), xfCurveFreqs(cuts, XF_BAND_HZ.lo, top),
      x, { to: depthY, from: () => 0 })
    : "";
  const status = xfStatus(meter, enabled, auto, mix);
  const chips = xfVisibleChips(status.chips, status.kind === "cutting" ? XF_STATUS_CHIPS.cutting : XF_STATUS_CHIPS.ringing);
  const live = !!meter && enabled;
  return (
    <>
      <svg className={`pp-plot pp-xf-strip${live ? "" : " idle"}`} data-testid="v3-xf-strip" data-live={live ? "" : undefined}
        viewBox={`0 0 ${W} ${H}`} role="img"
        aria-label={`Ring strip 250 Hz to ${top >= 10000 ? "10 kHz" : `${Math.round(top)} Hz`}: ${status.text}${status.chips.length ? ` ${status.chips.join(", ")}` : ""}`}>
        {TICKS.filter((t) => t < top).map((t) => (
          <g key={t}>
            <line className="grid" x1={x.to(t)} x2={x.to(t)} y1={0} y2={H} />
            <text className="axis" x={x.to(t) + 1.5} y={H - 1.5}>{tickLabel(t)}</text>
          </g>
        ))}
        <line className="zero" x1={0} x2={W} y1={0.5} y2={0.5} />
        <line className="pp-xf-thr" data-testid="v3-xf-threshold" x1={0} x2={W} y1={y.to(threshold)} y2={y.to(threshold)} />
        {curve && <path className="pp-xf-cutarea" d={fillPath(curve, 0, W, 0)} />}
        {curve && <path className="pp-xf-cutline" data-testid="v3-xf-cutcurve" d={curve} />}
        {live && cands.map((c, i) => {
          const cx = x.to(c.hz), cy = y.to(Math.min(XF_SCORE_MAX, c.score));
          return (
            <g key={i} className={`pp-xf-cand${auto ? "" : " would"}`} data-testid="v3-xf-candidate">
              <line x1={cx} x2={cx} y1={H} y2={cy} />
              <circle cx={cx} cy={cy} r={1.8} />
            </g>
          );
        })}
      </svg>
      <div className={`pp-xf-status ${status.kind}`} data-testid="v3-xf-status" data-kind={status.kind} aria-live="off">
        <span className="t">{status.text}</span>
        {chips.shown.map((c, i) => (
          <span key={i} className={`pp-xf-chip${status.kind === "cutting" ? " cut" : ""}`} data-testid="v3-xf-chip">{c}</span>
        ))}
        {chips.more && (
          <span className={`pp-xf-chip more${status.kind === "cutting" ? " cut" : ""}`} data-testid="v3-xf-chip-more"
            title={chips.rest.join(", ")} aria-label={`and ${chips.rest.join(", ")}`}>{chips.more}</span>
        )}
      </div>
    </>
  );
}

/** Max Cuts as a 1-4 stepper (the engine rounds the value, so only four states exist). */
function CutsStepper({ n, onSet }: { n: number; onSet: (n: number) => void }) {
  const set = (v: number) => { const c = Math.min(4, Math.max(1, v)); if (c !== n) onSet(c); };
  const onKeyDown = (e: KeyboardEvent<HTMLSpanElement>) => {
    const k: Record<string, number> = { ArrowUp: n + 1, ArrowRight: n + 1, ArrowDown: n - 1, ArrowLeft: n - 1, Home: 1, End: 4 };
    if (!(e.key in k)) return;
    e.preventDefault();
    set(k[e.key]);
  };
  return (
    <div className="pp-xf-step" role="group" aria-label="Max cuts">
      {/* aria-disabled, not disabled: a disabled button would drop the keyboard focus it holds */}
      <button type="button" aria-label="Fewer cuts" aria-disabled={n <= 1} onClick={() => set(n - 1)}>−</button>
      <span className="v" role="spinbutton" tabIndex={0} data-testid="v3-xf-cuts" aria-label="Max cuts"
        aria-valuemin={1} aria-valuemax={4} aria-valuenow={n} aria-valuetext={`${n} ${n === 1 ? "cut" : "cuts"}`}
        onKeyDown={onKeyDown}>{n} {n === 1 ? "cut" : "cuts"}</span>
      <button type="button" aria-label="More cuts" aria-disabled={n >= 4} onClick={() => set(n + 1)}>+</button>
    </div>
  );
}

/** Detect | Suppress as a radio group with the radio keyboard model: one tab stop (the
 *  checked radio), arrows move to and select the other mode. Sends only on a change. */
function ModeSwitch({ auto, onSet }: { auto: boolean; onSet: (on: boolean) => void }) {
  const refs = useRef<(HTMLButtonElement | null)[]>([]);
  const choose = (on: boolean) => { if (on !== auto) onSet(on); };
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const to: Record<string, boolean> = { ArrowLeft: false, ArrowUp: false, ArrowRight: true, ArrowDown: true, Home: false, End: true };
    if (!(e.key in to)) return;
    e.preventDefault();
    // two options: the arrows wrap, so either direction reaches the other mode
    const next = e.key === "Home" || e.key === "End" ? to[e.key] : !auto;
    choose(next);
    refs.current[next ? 1 : 0]?.focus();
  };
  return (
    <div className="pp-xf-mode" role="radiogroup" aria-label="Mode" onKeyDown={onKeyDown}>
      {([[false, "Detect"], [true, "Suppress"]] as const).map(([on, label], i) => (
        <button key={label} ref={(el) => { refs.current[i] = el; }} type="button" role="radio" aria-checked={auto === on}
          tabIndex={auto === on ? 0 : -1} data-testid={`v3-xf-${label.toLowerCase()}`} className={auto === on ? "on" : ""}
          title={on ? "Notch out what rings" : "Only show what rings; cut nothing"}
          onClick={() => choose(on)}>{label}</button>
      ))}
    </div>
  );
}

/** The value a dial is being dragged to, for drawing that depends on it before the
 *  engine's patch lands (the threshold line follows Sensitivity as it moves). */
function useLiveNorm(): [number | null, (v: number) => void] {
  const [v, setV] = useState<number | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);
  return [v, (next: number) => {
    setV(next);
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => setV(null), 600);
  }];
}

function XFeedbackPanel({ plugin, trackId, sampleRate, setParam }: PanelProps) {
  const s = xfSettings(plugin);
  const bufferSize = useStore((st) => st.snapshot?.audio?.bufferSize);
  const [sensLive, setSensLive] = useLiveNorm();
  const send = (i: number) => (norm: number, gesture: string) => setParam(i, norm, { gesture });
  const def = (i: number, phys: number, r: Range) => normOf(param(plugin, i), phys, r);
  const norm = (i: number) => param(plugin, i)?.value ?? 0;
  const sens = sensLive ?? norm(XF_PARAM.sensitivity);
  const threshold = xfThreshold(XF_RANGES.sensitivity.min + sens * (XF_RANGES.sensitivity.max - XF_RANGES.sensitivity.min));
  const smallBuffer = typeof bufferSize === "number" && bufferSize > 0 && bufferSize < XF_MIN_BLOCK;
  return (
    <div className={`pp-xf${plugin.enabled ? "" : " off"}`} data-testid="v3-xf">
      <div className="pp-xf-ctl">
        <ModeSwitch auto={s.auto} onSet={(on) => setParam(XF_PARAM.auto, on ? 1 : 0)} />
        <CutsStepper n={s.maxCuts} onSet={(n) => setParam(XF_PARAM.maxCuts, xfCutsNorm(n))} />
        <span className="pp-xf-thrv" title="The detector's threshold on its tonality score">thr {threshold.toFixed(2)}</span>
      </div>
      <XfLive trackId={trackId} index={plugin.index} itemId={plugin.itemId} enabled={plugin.enabled} threshold={threshold} auto={s.auto}
        mix={s.mix} sampleRate={sampleRate} />
      {smallBuffer && (
        <div className="pp-xf-note" data-testid="v3-xf-buffer-note">
          Detection needs a buffer of {XF_MIN_BLOCK} samples or more (now {bufferSize}).
        </div>
      )}
      <div className={`pp-xf-dials${s.auto ? "" : " detect"}`}>
        <Dial label="Sensitivity" size={28} norm={norm(XF_PARAM.sensitivity)} display={`${Math.round(s.sensitivity * 100)}%`}
          valueText={`${Math.round(s.sensitivity * 100)}%, threshold ${xfThreshold(s.sensitivity).toFixed(2)}`}
          defaultNorm={def(XF_PARAM.sensitivity, XF_DEFAULTS.sensitivity, XF_RANGES.sensitivity)}
          onChange={(v, g) => { setSensLive(v); setParam(XF_PARAM.sensitivity, v, { gesture: g }); }} testId="v3-xf-sensitivity" />
        <Dial label="Max Depth" size={28} norm={norm(XF_PARAM.maxDepth)} display={`${s.maxDepth.toFixed(1)} dB`}
          defaultNorm={def(XF_PARAM.maxDepth, XF_DEFAULTS.maxDepth, XF_RANGES.maxDepth)} onChange={send(XF_PARAM.maxDepth)}
          testId="v3-xf-depth" />
        <Dial label="Release" size={28} norm={norm(XF_PARAM.release)} display={fmtMs(s.release)}
          defaultNorm={def(XF_PARAM.release, XF_DEFAULTS.release, XF_RANGES.release)} onChange={send(XF_PARAM.release)}
          testId="v3-xf-release" />
        <Dial label="Mix" size={28} norm={norm(XF_PARAM.mix)} display={`${Math.round(s.mix * 100)}%`}
          defaultNorm={def(XF_PARAM.mix, XF_DEFAULTS.mix, XF_RANGES.mix)} onChange={send(XF_PARAM.mix)} testId="v3-xf-mix" />
        <Dial label="Output" size={28} norm={norm(XF_PARAM.output)} display={fmtDb(s.output)}
          defaultNorm={def(XF_PARAM.output, XF_DEFAULTS.output, XF_RANGES.output)} onChange={send(XF_PARAM.output)}
          testId="v3-xf-output" />
      </div>
    </div>
  );
}

/** Minimized: a micro ring strip (candidates as short ticks up, cuts as ticks down at the
 *  depth actually applied at Mix). */
function XfMini({ plugin, trackId, sampleRate }: PanelProps) {
  const meter = xfMeterOf(usePluginMeter<PluginMeterReading>(trackId, plugin.index), plugin.itemId);
  const mix = xfSettings(plugin).mix;
  const x = freqScale(XF_BAND_HZ.lo, xfTopHz(sampleRate), 48);
  const live = meter && plugin.enabled ? meter : undefined;
  const cands = (live?.candidates ?? []).filter((c) => Number.isFinite(c.hz) && Number.isFinite(c.score));
  const cuts = (live?.cuts ?? []).filter((c) => Number.isFinite(c.hz) && Number.isFinite(c.depthDb));
  return (
    <svg className={`pp-xf-mini${live ? "" : " idle"}`} data-testid="v3-xf-mini" viewBox="0 0 48 12" width={48} height={12}
      role="img" aria-label={live ? `${cuts.length} cuts, ${cands.length} ringing` : "Not listening"}>
      <line className="base" x1={0} x2={48} y1={6} y2={6} />
      {cands.map((c, i) => (
        <line key={`c${i}`} className="cand" x1={x.to(c.hz)} x2={x.to(c.hz)} y1={6} y2={6 - Math.min(1, c.score / XF_SCORE_MAX) * 6} />
      ))}
      {cuts.map((c, i) => (
        <line key={`k${i}`} className="cut" data-testid="v3-xf-mini-cut" x1={x.to(c.hz)} x2={x.to(c.hz)} y1={6}
          y2={6 + Math.min(1, -xfAppliedDb(c.depthDb, mix) / XF_DEPTH_AXIS_DB) * 6} />
      ))}
    </svg>
  );
}

export const xFeedbackPanelDef: PanelDef = { Panel: XFeedbackPanel, summary: xfSummary, Mini: XfMini };
