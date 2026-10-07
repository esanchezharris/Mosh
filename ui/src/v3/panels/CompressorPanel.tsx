import { useState, type KeyboardEvent } from "react";
import type { DynamicsMeter } from "../../types";
import { arcPath, Dial } from "./Dial";
import { DragNode } from "./DragNode";
import { MeterBar, usePeakHold, usePluginMeter } from "./meters";
import { clamp, fmtDb, fmtMs, fmtRatio, normOf, param, ratioNorm, thresholdNorm } from "./params";
import { curvePath, linScale, type Scale } from "./plot";
import { useDragSend } from "./useDragSend";
import {
  ATTACK, compOutDb, compSettings, compSummary, curveSamples, DEFAULTS, dynamicsFrame, fmtGr, fmtPeak, fmtThr, GAUGE_HALF_SWEEP,
  gaugeAngle, gaugePoint, grScale, MAKEUP, outRange, RELEASE, ratioDialPos, ratioNormFromDial, SIDECHAIN, THR_MAX_DB, THR_MIN_DB,
  unitySpan, X_HI, X_LO,
} from "./compressor";
import type { PanelDef, PanelProps } from "./types";

// Transfer-curve plot geometry: the viewBox is the drawn size in px, so its 9 px axis text
// is not scaled down. The x axis is the detector level.
const PW = 82, PH = 82;
const GRID = [-36, -24, -12];

/** One live frame for this compressor, or undefined (idle). Subscribes to this plugin only. */
function useDynamics(trackId: string, index: number, type: string): DynamicsMeter | undefined {
  return dynamicsFrame(usePluginMeter(trackId, index), type);
}

/** The measured input and output peaks as a dot over the curve. The curve is in terms of
 *  the detector level (the averaged mid signal), so a peak sits near, not exactly on, it. */
function LiveDot({ trackId, index, type, x, y, yLo, yHi }: {
  trackId: string; index: number; type: string; x: Scale; y: Scale; yLo: number; yHi: number;
}) {
  const m = useDynamics(trackId, index, type);
  if (!m || m.inDb < X_LO) return null;
  const cx = x.to(clamp(m.inDb, X_LO, X_HI)), cy = y.to(clamp(m.outDb, yLo, yHi));
  return <circle className="pp-compressor-dot" data-testid="pp-compressor-dot" cx={cx.toFixed(2)} cy={cy.toFixed(2)} r={2.6} />;
}

/** The gauge face: a ±50° arc pivoting at the bottom, like a VU needle. */
const G = { w: 80, h: 38, cx: 40, cy: 36, r: 31 };

/** The hero: a needle gauge of the gain reduction being applied right now, with a
 *  one-second peak-hold tick, the number, and the measured in/out peaks. With no frame
 *  (stopped, bypassed, silent) the needle rests at 0 and the panel says "no signal". */
function GrGauge({ trackId, index, type, scale, more, onMore }: {
  trackId: string; index: number; type: string; scale: number; more: boolean; onMore: () => void;
}) {
  const m = useDynamics(trackId, index, type);
  const gr = m ? Math.max(0, m.grDb) : 0;
  const peak = usePeakHold(m ? gr : undefined, 1000) ?? 0;
  const { cx, cy, r } = G;
  const ang = gaugeAngle(gr, scale), peakAng = gaugeAngle(peak, scale);
  const [tx1, ty1] = gaugePoint(cx, cy, r - 5, peakAng), [tx2, ty2] = gaugePoint(cx, cy, r + 3, peakAng);
  const ticks = [0, 0.25, 0.5, 0.75, 1].map((f) => {
    const a = gaugeAngle(f * scale, scale);
    const [x1, y1] = gaugePoint(cx, cy, r + 2, a), [x2, y2] = gaugePoint(cx, cy, r + 5, a);
    return <line key={f} className="tk" x1={x1.toFixed(2)} y1={y1.toFixed(2)} x2={x2.toFixed(2)} y2={y2.toFixed(2)} />;
  });
  // The scale's numbers sit centred under the arc's two ends.
  const [lx, ly] = gaugePoint(cx, cy, r, -GAUGE_HALF_SWEEP), [rx] = gaugePoint(cx, cy, r, GAUGE_HALF_SWEEP);
  return (
    <div className={`pp-compressor-gauge${m ? "" : " idle"}`} data-testid="pp-compressor-gauge" data-live={m ? "" : undefined}>
      <div className="face" role="meter" aria-label="Gain reduction" aria-valuemin={0} aria-valuemax={scale}
        aria-valuenow={Number(gr.toFixed(1))} aria-valuetext={m ? `${gr.toFixed(1)} dB of gain reduction` : "No signal"}
        title={`Gain reduction applied right now (full scale ${scale} dB), with a 1 s peak hold`}>
        <svg viewBox={`0 0 ${G.w} ${G.h}`} width={G.w} height={G.h} aria-hidden="true">
          <path className="trk" d={arcPath(cx, cy, r, -GAUGE_HALF_SWEEP, GAUGE_HALF_SWEEP)} />
          {gr > 0.01 && <path className="val" d={arcPath(cx, cy, r, ang, GAUGE_HALF_SWEEP)} />}
          {ticks}
          {m && peak > 0.05 && <line className="pk" x1={tx1.toFixed(2)} y1={ty1.toFixed(2)} x2={tx2.toFixed(2)} y2={ty2.toFixed(2)} />}
          <g className="needle" style={{ transform: `rotate(${ang.toFixed(2)}deg)`, transformOrigin: `${cx}px ${cy}px` }}>
            <line x1={cx} y1={cy} x2={cx} y2={cy - r + 3} />
          </g>
          <circle className="hub" cx={cx} cy={cy} r={2} />
          <text className="sc" x={lx.toFixed(2)} y={(ly + 10).toFixed(2)} textAnchor="middle">-{scale}</text>
          <text className="sc" x={rx.toFixed(2)} y={(ly + 10).toFixed(2)} textAnchor="middle">0</text>
        </svg>
        <span className="nm">Gain reduction</span>
      </div>
      <div className="read">
        {/* 0.0 dB of reduction is muted, like the idle dash: a bright number would say
            something is happening when nothing is. */}
        <span className={`gr${m && gr < 0.05 ? " zero" : ""}`} data-testid="pp-compressor-gr">{m ? fmtGr(gr) : "–"}</span>
        {m ? <>
          <span className="io" data-testid="pp-compressor-in"><span className="k">in</span> <span className="n">{fmtPeak(m.inDb)}</span></span>
          <span className="io" data-testid="pp-compressor-out"><span className="k">out</span> <span className="n">{fmtPeak(m.outDb)}</span></span>
        </> : <>
          <span className="io idle" data-testid="pp-compressor-nosignal">no signal</span>
          <span className="io" aria-hidden="true">{"\u00a0"}</span>
        </>}
        {/* Sidechain gain only trims a sidechain input, and nothing routes one in Mosh, so
            it lives behind a quiet text disclosure, not a switch-like button. */}
        <button type="button" className="pp-compressor-more" data-testid="pp-compressor-more" aria-expanded={more}
          title="Sidechain gain (no effect: Mosh routes no sidechain)" onClick={onMore}>
          Sidechain {more ? "\u25be" : "\u25b8"}
        </button>
      </div>
    </div>
  );
}

/** Tracktion Compressor: the exact transfer curve with the threshold on it, a live
 *  gain-reduction gauge, and Ratio / Attack / Release / Makeup dials. Sidechain gain sits
 *  behind a text disclosure, inert: nothing routes a sidechain in Mosh, so it does nothing. */
function CompressorPanel({ plugin, trackId, setParam }: PanelProps) {
  const s = compSettings(plugin);
  const [more, setMore] = useState(false);
  const thr = useDragSend<number>((db, gesture) => setParam(0, thresholdNorm(db), { gesture }));
  const thrDb = thr.live ?? s.thrDb;
  const shown = { ...s, thrDb, thrLin: 10 ** (thrDb / 20) };
  const { lo: yLo, hi: yHi } = outRange(s.makeupDb);
  const x = linScale(X_HI, X_LO, PW);   // reversed arguments: X_LO at the left edge
  const y = linScale(yLo, yHi, PH);
  const curve = curvePath((v) => compOutDb(v, shown), curveSamples(X_LO, X_HI, 49, thrDb), x, y, 0, PH);
  const scale = grScale(shown.thrLin, s.rho);
  const kneeY = clamp(thrDb + s.makeupDb, yLo, yHi);
  const setThr = (db: number) => thr.nudge(clamp(Math.round(db * 10) / 10, THR_MIN_DB, THR_MAX_DB));
  const onThrKey = (e: KeyboardEvent<SVGGElement>) => {
    const fine = e.shiftKey ? 0.1 : 1;
    const steps: Record<string, () => void> = {
      ArrowRight: () => setThr(s.thrDb + fine), ArrowUp: () => setThr(s.thrDb + fine),
      ArrowLeft: () => setThr(s.thrDb - fine), ArrowDown: () => setThr(s.thrDb - fine),
      PageUp: () => setThr(s.thrDb + 6), PageDown: () => setThr(s.thrDb - 6),
      Home: () => setThr(THR_MIN_DB), End: () => setThr(THR_MAX_DB),
    };
    const k = steps[e.key];
    if (!k) return;
    e.preventDefault();
    k();
  };
  const p = (i: number) => param(plugin, i);
  const ratioDefault = ratioDialPos(ratioNorm(DEFAULTS.ratio));
  const unity = unitySpan(yLo, yHi);
  return (
    <div className="pp-compressor" data-testid="pp-compressor">
      <div className="pp-compressor-left">
        <svg className={`pp-plot pp-compressor-plot${plugin.enabled ? "" : " bypassed"}`} viewBox={`0 0 ${PW} ${PH}`}
          width={PW} height={PH} data-testid="pp-compressor-plot" role="group" aria-label="Transfer curve: detector level in, output out">
          {GRID.map((g) => (
            <g key={g}>
              <line className="grid" x1={x.to(g)} y1={0} x2={x.to(g)} y2={PH} />
              <line className="grid" x1={0} y1={y.to(yHi + g)} x2={PW} y2={y.to(yHi + g)} />
            </g>
          ))}
          {/* Unity (out = in): how far below it the curve sits is the reduction. */}
          {unity && <line className="zero" data-testid="pp-compressor-unity"
            x1={x.to(unity[0])} y1={y.to(unity[0])} x2={x.to(unity[1])} y2={y.to(unity[1])} />}
          <line className="pp-compressor-thr" x1={x.to(thrDb)} y1={0} x2={x.to(thrDb)} y2={PH} />
          <path className="curve" data-testid="pp-compressor-curve" d={curve} />
          {/* Out at the top-left; in along the bottom-right, where the curve never runs (it
              starts in the bottom-left corner at 0 dB makeup). */}
          <text className="axis" x={2} y={10}>{yHi === 0 ? "0" : `+${yHi}`} dBFS</text>
          <text className="axis" x={PW - 2} y={PH - 3} textAnchor="end">0 dBFS in</text>
          <LiveDot trackId={trackId} index={plugin.index} type={plugin.type} x={x} y={y} yLo={yLo} yHi={yHi} />
          <DragNode x={x.to(thrDb)} y={y.to(kneeY)} r={4} active={thr.live !== null} testId="pp-compressor-thr-node"
            ariaLabel="Threshold" ariaValueText={`${thrDb.toFixed(1)} dB`} valueNow={thrDb} valueMin={-40} valueMax={0}
            onStart={thr.begin} onEnd={thr.end}
            onMove={(pt) => thr.update(clamp(Math.round(x.from(pt.x) * 10) / 10, THR_MIN_DB, THR_MAX_DB))}
            onKeyDown={onThrKey} onDoubleClick={() => setThr(DEFAULTS.thrDb)} />
        </svg>
        {/* The plot is the threshold's control; its read-out is a dial's footer, level with
            the dials' own. */}
        <div className="pp-dial pp-compressor-thrval" data-testid="pp-compressor-thrval" title="Threshold (drag the dot on the curve)">
          <span className="v">{fmtThr(thrDb)}</span>
          <span className="nm">Threshold</span>
        </div>
      </div>
      <div className="pp-compressor-side">
        <GrGauge trackId={trackId} index={plugin.index} type={plugin.type} scale={scale} more={more} onMore={() => setMore((v) => !v)} />
        <div className="pp-compressor-dials">
          <Dial label="Ratio" testId="pp-compressor-ratio"
            norm={ratioDialPos(p(1)?.value ?? ratioNorm(DEFAULTS.ratio))} defaultNorm={ratioDefault}
            display={fmtRatio(s.ratio)} valueText={Number.isFinite(s.ratio) ? `${s.ratio.toFixed(2)} to 1` : "infinity to 1"}
            onChange={(pos, gesture) => setParam(1, ratioNormFromDial(pos), { gesture })} />
          <Dial label="Attack" testId="pp-compressor-attack" norm={p(2)?.value ?? normOf(undefined, DEFAULTS.attackMs, ATTACK)}
            defaultNorm={normOf(p(2), DEFAULTS.attackMs, ATTACK)} display={fmtMs(s.attackMs)}
            onChange={(v, gesture) => setParam(2, v, { gesture })} />
          <Dial label="Release" testId="pp-compressor-release" norm={p(3)?.value ?? normOf(undefined, DEFAULTS.releaseMs, RELEASE)}
            defaultNorm={normOf(p(3), DEFAULTS.releaseMs, RELEASE)} display={fmtMs(s.releaseMs)}
            onChange={(v, gesture) => setParam(3, v, { gesture })} />
          <Dial label="Makeup" testId="pp-compressor-makeup" norm={p(4)?.value ?? normOf(undefined, DEFAULTS.makeupDb, MAKEUP)}
            origin={normOf(p(4), 0, MAKEUP)}
            defaultNorm={normOf(p(4), DEFAULTS.makeupDb, MAKEUP)} display={fmtDb(s.makeupDb)}
            onChange={(v, gesture) => setParam(4, v, { gesture })} />
        </div>
      </div>
      {more && (
        <div className="pp-compressor-sc" data-testid="pp-compressor-sc">
          <Dial label="Sidechain gain" testId="pp-compressor-scgain" inert
            title="Sidechain gain only trims a sidechain input, and nothing routes one in Mosh yet, so it has no effect."
            norm={p(5)?.value ?? normOf(undefined, DEFAULTS.sidechainDb, SIDECHAIN)} origin={normOf(p(5), 0, SIDECHAIN)}
            defaultNorm={normOf(p(5), DEFAULTS.sidechainDb, SIDECHAIN)} display={fmtDb(s.sidechainDb)}
            onChange={(v, gesture) => setParam(5, v, { gesture })} />
          <span className="note">No effect in Mosh</span>
        </div>
      )}
    </div>
  );
}

/** Minimized: a tiny live gain-reduction bar (idle when no frame). */
function CompressorMini({ plugin, trackId }: PanelProps) {
  const m = useDynamics(trackId, plugin.index, plugin.type);
  const s = compSettings(plugin);
  const scale = grScale(s.thrLin, s.rho);
  return (
    <span className="pp-compressor mini" data-testid="pp-compressor-mini" data-live={m ? "" : undefined}>
      <MeterBar value={m ? Math.max(0, m.grDb) : undefined} max={scale} tone="gr" label="Gain reduction"
        valueText={m ? `${Math.max(0, m.grDb).toFixed(1)} dB of gain reduction` : "No signal"} />
    </span>
  );
}

export const compressorPanelDef: PanelDef = {
  Panel: CompressorPanel,
  summary: compSummary,
  Mini: CompressorMini,
};
