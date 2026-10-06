import { useEffect, useRef, useState, type KeyboardEvent, type PointerEvent } from "react";
import type { PluginMeterReading } from "../../types";
import { Dial } from "./Dial";
import { usePluginMeter } from "./meters";
import { clamp, fmtDb, fmtMs, normOf, param, physOf, type Range } from "./params";
import {
  OTT_BANDS, OTT_DEFAULTS, OTT_LEVEL_AXIS, OTT_LIFT_WINDOW_DB, OTT_PARAM, OTT_RANGES, OTT_THRESHOLD_DB,
  fmtAmount, ottBandView, ottMeterOf, ottOutputOnly, ottSettings, ottSummary, ottTaus,
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
const BAR_H = 30;
const yOfDb = (db: number) => (1 - (db - OTT_LEVEL_AXIS.min) / (OTT_LEVEL_AXIS.max - OTT_LEVEL_AXIS.min)) * BAR_H;

/** One band's envelope level (with the -20 dBFS threshold tick and the -76..-38 dBFS lift
 *  window shaded) and its applied gain change, both from the 30 Hz meter rail. Subscribes
 *  to this plugin's frame only. */
function OttBandLive({ trackId, index, itemId, band, label }: { trackId: string; index: number; itemId?: string; band: number; label: string }) {
  const view = ottBandView(ottMeterOf(usePluginMeter<PluginMeterReading>(trackId, index), itemId), band);
  const half = BAR_H / 2;
  const desc = view ? `${label}: level ${view.levelText}, gain ${view.gainText}` : `${label}: no signal`;
  return (
    <div className={`pp-ott-live${view ? "" : " idle"}`} data-testid="v3-ott-band-live" data-live={view ? "" : undefined}
      role="img" aria-label={desc}>
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
        <span className={`g${view && view.gainDb > 0.05 ? " up" : view && view.gainDb < -0.05 ? " dn" : ""}`} data-testid="v3-ott-gain">
          {view ? view.gainText : "–"}{view?.over ? "!" : ""}
        </span>
        <span className="l">{view ? view.levelText : "idle"}</span>
      </span>
    </div>
  );
}

/** The output clamp light (the final stage is a hard clip at ±0.999, MoshFxMath.h). */
function OttClip({ trackId, index, itemId }: { trackId: string; index: number; itemId?: string }) {
  const meter = ottMeterOf(usePluginMeter<PluginMeterReading>(trackId, index), itemId);
  const lit = useLatch(!!meter?.clipped, OTT_CLIP_HOLD_MS);
  return (
    <span className={`pp-ott-clip${lit ? " on" : ""}`} data-testid="v3-ott-clip" data-on={lit ? "" : undefined}
      role="status" aria-label={lit ? "Output clipping" : "Output not clipping"}
      title="Lights when the output's hard clip at 0 dBFS engaged">clip</span>
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
function TrimSlider({ name, p, onSend }: { name: string; p: ReturnType<typeof param>; onSend: (norm: number, gesture: string) => void }) {
  const drag = useDragSend<number>((db, g) => onSend(normOf(p, db, TRIM), g));
  const start = useRef<{ x: number; db: number; w: number } | null>(null);
  const db = drag.live ?? physOf(p, TRIM);
  const pos = (db - TRIM.min) / (TRIM.max - TRIM.min);     // 0..1, centre 0.5
  const lo = Math.min(pos, 0.5), hi = Math.max(pos, 0.5);
  const text = fmtDb(db);
  const finish = () => { if (start.current) { start.current = null; drag.end(); } };
  return (
    <div className="pp-ott-trim" role="slider" tabIndex={0} data-testid="v3-ott-trim" aria-label={name}
      aria-valuemin={TRIM.min} aria-valuemax={TRIM.max} aria-valuenow={roundTenth(db)} aria-valuetext={text}
      title={`${name}: a fixed trim on this band (drag, arrows; double-click for 0 dB)`}
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
  return (
    <div className={`pp-ott${plugin.enabled ? "" : " off"}`} data-testid="v3-ott">
      <div className={`pp-ott-bands${outputOnly ? " skipped" : ""}`}>
        {OTT_BANDS.map((b, i) => (
          <div key={b.key} className="pp-ott-band" data-band={b.key}>
            <span className="pp-ott-bh" title={b.title}><b>{b.label}</b> {b.range}</span>
            <OttBandLive trackId={trackId} index={plugin.index} itemId={plugin.itemId} band={i} label={b.title} />
            <TrimSlider name={param(plugin, b.param)?.name ?? `${b.label} Gain`} p={param(plugin, b.param)} onSend={send(b.param)} />
          </div>
        ))}
      </div>
      <div className="pp-ott-dials">
        <Dial label="Amount" size={38} norm={norm(OTT_PARAM.amount)} display={fmtAmount(s.amount)}
          defaultNorm={def(OTT_PARAM.amount, OTT_DEFAULTS.amount, OTT_RANGES.amount)} onChange={send(OTT_PARAM.amount)}
          testId="v3-ott-amount" />
        <Dial label="Time" size={30} norm={norm(OTT_PARAM.time)} display={fmtMs(s.time)}
          valueText={`${fmtMs(taus.releaseMs)} release, ${fmtMs(taus.attackMs)} attack`}
          defaultNorm={def(OTT_PARAM.time, OTT_DEFAULTS.time, OTT_RANGES.time)} onChange={send(OTT_PARAM.time)}
          testId="v3-ott-time" />
        {/* At Amount 0 the engine skips Mix, so it dims, but it stays adjustable (preset it
            before raising Amount); the note below says why it has no effect. */}
        <div className={`pp-ott-mixw${outputOnly ? " inert" : ""}`} data-testid="v3-ott-mixw">
          <Dial label="Mix" size={30} norm={norm(OTT_PARAM.mix)} display={`${Math.round(s.mix * 100)}%`}
            valueText={`${Math.round(s.mix * 100)}%${outputOnly ? ", skipped at Amount 0" : ""}`}
            defaultNorm={def(OTT_PARAM.mix, OTT_DEFAULTS.mix, OTT_RANGES.mix)} onChange={send(OTT_PARAM.mix)}
            testId="v3-ott-mix" />
        </div>
        <div className="pp-ott-out">
          <Dial label="Output" size={30} norm={norm(OTT_PARAM.output)} display={fmtDb(s.output)}
            defaultNorm={def(OTT_PARAM.output, OTT_DEFAULTS.output, OTT_RANGES.output)} onChange={send(OTT_PARAM.output)}
            testId="v3-ott-output" />
          <OttClip trackId={trackId} index={plugin.index} itemId={plugin.itemId} />
        </div>
      </div>
      {outputOnly && (
        <div className="pp-ott-note" data-testid="v3-ott-note">Amount 0: bands, trims and Mix are skipped; only Output applies.</div>
      )}
    </div>
  );
}

/** Minimized: each band's live gain change as a tiny bipolar tick (lift up, cut down). */
function OttMini({ plugin, trackId }: PanelProps) {
  const meter = ottMeterOf(usePluginMeter<PluginMeterReading>(trackId, plugin.index), plugin.itemId);
  return (
    <svg className={`pp-ott-mini${meter ? "" : " idle"}`} data-testid="v3-ott-mini" viewBox="0 0 22 12" width={22} height={12}
      role="img" aria-label={meter ? `Band gains ${OTT_BANDS.map((b, i) => `${b.label} ${ottBandView(meter, i)?.gainText ?? "–"}`).join(", ")}` : "No signal"}>
      {OTT_BANDS.map((b, i) => {
        const v = ottBandView(meter, i);
        const x = i * 8;
        return (
          <g key={b.key}>
            <line className="pp-ott-mid" x1={x} x2={x + 6} y1={6} y2={6} />
            {v && v.lift > 0 && <rect className="pp-ott-lift" x={x + 1} y={6 - v.lift * 6} width={4} height={v.lift * 6} />}
            {v && v.cut > 0 && <rect className="pp-ott-cut" x={x + 1} y={6} width={4} height={v.cut * 6} />}
          </g>
        );
      })}
    </svg>
  );
}

export const ottPanelDef: PanelDef = { Panel: OttPanel, summary: ottSummary, Mini: OttMini };
