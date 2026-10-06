import { useEffect, useRef, useState, type KeyboardEvent, type PointerEvent } from "react";
import type { PluginMeterReading } from "../../types";
import { Dial } from "./Dial";
import { usePluginMeter } from "./meters";
import { clamp, fmtDb, fmtMs, normOf, param, physOf, type Range } from "./params";
import {
  OTT_BANDS, OTT_DEFAULTS, OTT_LEVEL_AXIS, OTT_LIFT_WINDOW_DB, OTT_PARAM, OTT_RANGES, OTT_THRESHOLD_DB,
  fmtAmount, ottBandView, ottMeterOf, ottOutputOnly, ottSettings, ottSummary, ottTaus, type OttBandDef,
} from "./ott";
import type { PanelDef, PanelProps } from "./types";
import { useDragSend } from "./useDragSend";

/** How long the clip light stays on after the output clamp engaged. */
export const OTT_CLIP_HOLD_MS = 1000;

/** True while `on`, and for `ms` after it last fell (a light that does not blink at 30 Hz).
 *  The hold starts on the falling edge, so a short burst still holds for `ms` and then
 *  clears, and a long one holds `ms` past its last true frame. */
function useLatch(on: boolean, ms: number): boolean {
  const [lit, setLit] = useState(on);
  useEffect(() => {
    if (on) { setLit(true); return; }
    const t = setTimeout(() => setLit(false), ms);
    return () => clearTimeout(t);
  }, [on, ms]);
  return on || lit;
}

// ── a band's live bars ─────────────────────────────────────────────────────────────────
const BAR_H = 20;
const yOfDb = (db: number) => (1 - (db - OTT_LEVEL_AXIS.min) / (OTT_LEVEL_AXIS.max - OTT_LEVEL_AXIS.min)) * BAR_H;

/** One band's envelope level (with the -20 dBFS threshold tick and the -76..-38 dBFS lift
 *  window shaded) and its applied gain change, both from the 30 Hz meter rail, with the gain
 *  read-out over the band's name (the level is in the tooltip). Subscribes to this plugin's
 *  frame only. With no frame the read-out is a muted "–"; the panel says "no signal" once. */
function OttBandLive({ trackId, index, itemId, band, def }: { trackId: string; index: number; itemId?: string; band: number; def: OttBandDef }) {
  const view = ottBandView(ottMeterOf(usePluginMeter<PluginMeterReading>(trackId, index), itemId), band);
  const half = BAR_H / 2;
  const desc = view ? `${def.title}: level ${view.levelText}, gain ${view.gainText}` : `${def.title}: no signal`;
  return (
    <div className={`pp-ott-live${view ? "" : " idle"}`} data-testid="v3-ott-band-live" data-live={view ? "" : undefined}
      role="img" aria-label={desc} title={desc}>
      <svg viewBox={`0 0 18 ${BAR_H}`} width={18} height={BAR_H} aria-hidden="true">
        <rect className="pp-ott-trk" x={0} y={0} width={5} height={BAR_H} rx={1} />
        <rect className="pp-ott-window" x={0} y={yOfDb(OTT_LIFT_WINDOW_DB.hi)} width={5}
          height={yOfDb(OTT_LIFT_WINDOW_DB.lo) - yOfDb(OTT_LIFT_WINDOW_DB.hi)} />
        {view && <rect className="pp-ott-level" data-testid="v3-ott-level" x={0} y={(1 - view.level) * BAR_H} width={5} height={view.level * BAR_H} />}
        <line className="pp-ott-thr" x1={-0.5} x2={5.5} y1={yOfDb(OTT_THRESHOLD_DB)} y2={yOfDb(OTT_THRESHOLD_DB)} />
        <rect className="pp-ott-trk" x={10} y={0} width={6} height={BAR_H} rx={1} />
        {view && view.lift > 0 && <rect className="pp-ott-lift" data-testid="v3-ott-lift" x={10} y={half - view.lift * half} width={6} height={view.lift * half} />}
        {view && view.cut > 0 && <rect className="pp-ott-cut" data-testid="v3-ott-cut" x={10} y={half} width={6} height={view.cut * half} />}
        <line className="pp-ott-mid" x1={9} x2={17} y1={half} y2={half} />
      </svg>
      <span className="pp-ott-read">
        <span className={`g${!view ? " none" : view.gainDb > 0.05 ? " up" : view.gainDb < -0.05 ? " dn" : ""}`} data-testid="v3-ott-gain">
          {view ? view.gainText : "–"}{view?.over ? "!" : ""}
        </span>
        <span className="nm">{def.label}</span>
      </span>
    </div>
  );
}

/** The panel's status column beside Output, in the dials' footer (value over its fixed
 *  "Clip" caption, like every control): the output clamp light (the final stage is a hard
 *  clip at ±0.999, MoshFxMath.h) while frames arrive, and one muted "no signal" in the value
 *  slot when none do. */
function OttStatus({ trackId, index, itemId }: { trackId: string; index: number; itemId?: string }) {
  const meter = ottMeterOf(usePluginMeter<PluginMeterReading>(trackId, index), itemId);
  const lit = useLatch(!!meter?.clipped, OTT_CLIP_HOLD_MS);
  return (
    <div className={`pp-ott-stat${meter ? "" : " idle"}`} data-testid="v3-ott-status">
      {meter ? (
        <span className={`pp-ott-clip${lit ? " on" : ""}`} data-testid="v3-ott-clip" data-on={lit ? "" : undefined}
          role="status" aria-label={lit ? "Output clipping" : "Output not clipping"}
          title="Lights when the output's hard clip at 0 dBFS engaged" />
      ) : <span className="v none" title="No meter frames: play to see the clip light">no signal</span>}
      <span className="nm">Clip</span>
    </div>
  );
}

// ── a band's trim (Low/Mid/High Gain, -12..+12 dB) ─────────────────────────────────────
const TRIM = OTT_RANGES.trim;
const TRIM_KEYS: Record<string, (db: number, fine: boolean) => number> = {
  ArrowUp: (d, f) => d + (f ? 0.1 : 0.5), ArrowRight: (d, f) => d + (f ? 0.1 : 0.5),
  ArrowDown: (d, f) => d - (f ? 0.1 : 0.5), ArrowLeft: (d, f) => d - (f ? 0.1 : 0.5),
  PageUp: (d) => d + 3, PageDown: (d) => d - 3,
  Home: () => TRIM.min, End: () => TRIM.max, Delete: () => 0, Backspace: () => 0,
};
const roundTenth = (db: number) => Math.round(db * 10) / 10;

/** A band trim as a thin bipolar bar with its dB read-out: drag sideways (Shift = fine),
 *  arrow keys ±0.5 dB (Shift ±0.1), PageUp/Down ±3 dB, Home/End the ends, double-click
 *  or Delete for 0 dB. One drag (or one burst of keys) is one undo step. */
function TrimSlider({ name, p, inert, onSend }: {
  name: string; p: ReturnType<typeof param>; inert?: boolean; onSend: (norm: number, gesture: string) => void;
}) {
  const drag = useDragSend<number>((db, g) => onSend(normOf(p, db, TRIM), g));
  const start = useRef<{ x: number; db: number; w: number } | null>(null);
  const db = drag.live ?? physOf(p, TRIM);
  const pos = (db - TRIM.min) / (TRIM.max - TRIM.min);     // 0..1, centre 0.5
  const lo = Math.min(pos, 0.5), hi = Math.max(pos, 0.5);
  const text = fmtDb(db);
  const finish = () => { if (start.current) { start.current = null; drag.end(); } };
  return (
    <div className={`pp-ott-trim${inert ? " inert" : ""}`} role="slider" tabIndex={0} data-testid="v3-ott-trim" aria-label={name}
      aria-valuemin={TRIM.min} aria-valuemax={TRIM.max} aria-valuenow={roundTenth(db)}
      aria-valuetext={`${text}${inert ? ", skipped at Amount 0" : ""}`}
      title={inert ? `${name}: skipped at Amount 0 (only Output applies)`
        : `${name}: a fixed trim on this band (drag, arrows; double-click for 0 dB)`}
      onPointerDown={(e: PointerEvent<HTMLDivElement>) => {
        if (e.button !== 0) return;
        e.preventDefault();
        e.stopPropagation();
        e.currentTarget.setPointerCapture?.(e.pointerId);
        e.currentTarget.focus();
        start.current = { x: e.clientX, db, w: e.currentTarget.getBoundingClientRect().width || 80 };
        drag.begin();
      }}
      onPointerMove={(e) => {
        const s = start.current;
        if (!s) return;
        const span = (TRIM.max - TRIM.min) * (e.shiftKey ? 0.25 : 1);
        drag.update(roundTenth(clamp(s.db + ((e.clientX - s.x) / s.w) * span, TRIM.min, TRIM.max)));
      }}
      onPointerUp={finish} onPointerCancel={finish} onLostPointerCapture={finish}
      onDoubleClick={() => drag.nudge(0)}
      onKeyDown={(e: KeyboardEvent<HTMLDivElement>) => {
        const k = TRIM_KEYS[e.key];
        if (!k) return;
        e.preventDefault();
        drag.nudge(roundTenth(clamp(k(physOf(p, TRIM), e.shiftKey), TRIM.min, TRIM.max)));
      }}>
      <span className="pp-ott-trimbar" aria-hidden="true">
        <i className="fill" style={{ left: `${(lo * 100).toFixed(1)}%`, width: `${((hi - lo) * 100).toFixed(1)}%` }} />
        <i className="ctr" />
      </span>
      <span className={`v${Math.abs(db) >= 0.05 ? " set" : ""}`}>{text}</span>
    </div>
  );
}

// ── the panel ──────────────────────────────────────────────────────────────────────────
function OttPanel({ plugin, trackId, setParam }: PanelProps) {
  const s = ottSettings(plugin);
  const send = (i: number) => (norm: number, gesture: string) => setParam(i, norm, { gesture });
  const def = (i: number, phys: number, r: Range) => normOf(param(plugin, i), phys, r);
  const norm = (i: number) => param(plugin, i)?.value ?? 0;
  const taus = ottTaus(s.time);
  const outputOnly = ottOutputOnly(s.amount);
  const skipped = outputOnly ? "skipped at Amount 0 (only Output applies)" : undefined;
  return (
    <div className={`pp-ott${plugin.enabled ? "" : " off"}`} data-testid="v3-ott">
      <div className={`pp-ott-bands${outputOnly ? " skipped" : ""}`}>
        {OTT_BANDS.map((b, i) => (
          <div key={b.key} className="pp-ott-band" data-band={b.key}>
            <span className="pp-ott-bh" title={b.title}>{b.range}</span>
            <OttBandLive trackId={trackId} index={plugin.index} itemId={plugin.itemId} band={i} def={b} />
            <TrimSlider name={param(plugin, b.param)?.name ?? `${b.label} Gain`} p={param(plugin, b.param)} inert={outputOnly}
              onSend={send(b.param)} />
          </div>
        ))}
      </div>
      <div className="pp-ott-dials">
        <Dial label="Amount" norm={norm(OTT_PARAM.amount)} display={fmtAmount(s.amount)}
          defaultNorm={def(OTT_PARAM.amount, OTT_DEFAULTS.amount, OTT_RANGES.amount)} onChange={send(OTT_PARAM.amount)}
          testId="v3-ott-amount" />
        <Dial label="Time" norm={norm(OTT_PARAM.time)} display={fmtMs(s.time)}
          valueText={`${fmtMs(taus.releaseMs)} release, ${fmtMs(taus.attackMs)} attack`}
          title={`Release ${fmtMs(taus.releaseMs)}, attack ${fmtMs(taus.attackMs)}`}
          defaultNorm={def(OTT_PARAM.time, OTT_DEFAULTS.time, OTT_RANGES.time)} onChange={send(OTT_PARAM.time)}
          testId="v3-ott-time" />
        {/* At Amount 0 the engine skips Mix: it stays adjustable (preset it before raising
            Amount) but has no effect, so only its arc is muted. */}
        <Dial label="Mix" norm={norm(OTT_PARAM.mix)} display={`${Math.round(s.mix * 100)}%`} inert={outputOnly}
          title={skipped && `Mix: ${skipped}`}
          valueText={`${Math.round(s.mix * 100)}%${outputOnly ? ", skipped at Amount 0" : ""}`}
          defaultNorm={def(OTT_PARAM.mix, OTT_DEFAULTS.mix, OTT_RANGES.mix)} onChange={send(OTT_PARAM.mix)}
          testId="v3-ott-mix" />
        <Dial label="Output" norm={norm(OTT_PARAM.output)} display={fmtDb(s.output)}
          origin={normOf(param(plugin, OTT_PARAM.output), 0, OTT_RANGES.output)}
          defaultNorm={def(OTT_PARAM.output, OTT_DEFAULTS.output, OTT_RANGES.output)} onChange={send(OTT_PARAM.output)}
          testId="v3-ott-output" />
        <OttStatus trackId={trackId} index={plugin.index} itemId={plugin.itemId} />
      </div>
      {outputOnly && (
        <div className="pp-ott-note" data-testid="v3-ott-note" title="At Amount 0 the bands, their trims and Mix are skipped">
          Amount 0: only Output applies.
        </div>
      )}
    </div>
  );
}

/** Minimized (44×14): each band's live gain change as a bipolar bar on one baseline (lift
 *  up, cut down); just the baseline when no frame arrives. */
const MINI_W = 44, MINI_H = 14, MINI_MID = MINI_H / 2;
function OttMini({ plugin, trackId }: PanelProps) {
  const meter = ottMeterOf(usePluginMeter<PluginMeterReading>(trackId, plugin.index), plugin.itemId);
  return (
    <svg className={`pp-ott-mini${meter ? "" : " idle"}`} data-testid="v3-ott-mini" viewBox={`0 0 ${MINI_W} ${MINI_H}`}
      width={MINI_W} height={MINI_H} role="img"
      aria-label={meter ? `Band gains ${OTT_BANDS.map((b, i) => `${b.label} ${ottBandView(meter, i)?.gainText ?? "–"}`).join(", ")}` : "No signal"}>
      <line className="pp-ott-mid" x1={0} x2={MINI_W} y1={MINI_MID} y2={MINI_MID} />
      {meter && OTT_BANDS.map((b, i) => {
        const v = ottBandView(meter, i);
        const x = 2 + i * 15;
        return (
          <g key={b.key}>
            {v && v.lift > 0 && <rect className="pp-ott-lift" x={x} y={MINI_MID - v.lift * MINI_MID} width={10} height={v.lift * MINI_MID} />}
            {v && v.cut > 0 && <rect className="pp-ott-cut" x={x} y={MINI_MID} width={10} height={v.cut * MINI_MID} />}
          </g>
        );
      })}
    </svg>
  );
}

export const ottPanelDef: PanelDef = { title: "OTT", Panel: OttPanel, summary: ottSummary, Mini: OttMini };
