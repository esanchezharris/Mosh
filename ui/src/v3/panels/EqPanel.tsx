import { useEffect, useRef, useState, type KeyboardEvent, type PointerEvent } from "react";
import { DragNode } from "./DragNode";
import { fmtDb, fmtFreq } from "./params";
import { clientToSvg, fillPath } from "./plot";
import { useDragSend } from "./useDragSend";
import {
  BANDS, PLOT_H, PLOT_PAD, RANGES, bandValueText, changedFields, curveD, dbRange, dragTarget, editText, editToParams, eqSummary,
  fmtQ, geometry, isBandOff, maxAbsDb, nodePos, parseField, qFromDrag, readBands, scrubField, stepField,
  wheelOctaves, wheelQ, withEdit,
  type BandEdit, type BandField, type BandValues, type StepKind,
} from "./eq";
import type { PanelDef, PanelProps } from "./types";

/** A burst of keys or wheel notches builds on the value it last sent, not on the snapshot
 *  (whose patch may not have arrived between two key repeats). */
const BURST_MS = 600;
/** A wheel gesture (one undo step) ends this long after its last event. */
const WHEEL_IDLE_MS = 150;

const FIELD_LABEL: Record<BandField, string> = { freq: "Freq", gain: "Gain", q: "Q" };
const OFF_HINT = "At 0 dB this band is off (the engine skips it): its frequency and Q do nothing until its gain moves.";

const fieldText = (field: BandField, v: number): string =>
  field === "freq" ? fmtFreq(v) : field === "gain" ? fmtDb(v) : fmtQ(v);

type Edit = ReturnType<typeof useDragSend<BandEdit>>;

/** One adjustable read-out (Freq / Gain / Q of the selected band): drag up/down to scrub
 *  (Shift for fine), arrows / PageUp / PageDown / Home / End, double-click or Enter to type. */
function Scrub({ field, band, bandName, value, edit, nudge, base, inert }: {
  field: BandField; band: number; bandName: string; value: number;
  edit: Edit; nudge: (e: BandEdit) => void; base: (band: number, field: BandField) => number;
  /** Adjustable, but without effect while the band sits at 0 dB. */
  inert?: boolean;
}) {
  const [typing, setTyping] = useState<string | null>(null);
  const start = useRef<{ y: number; v: number } | null>(null);
  const r = RANGES[field];
  const text = fieldText(field, value);
  const label = `${bandName} ${FIELD_LABEL[field].toLowerCase()}`;

  const commit = () => {
    if (typing === null) return;
    const v = parseField(field, typing);
    setTyping(null);
    if (Number.isFinite(v)) nudge({ band, [field]: v });
  };
  const finish = () => {
    if (!start.current) return;
    start.current = null;
    edit.end();
  };
  const onKeyDown = (e: KeyboardEvent<HTMLSpanElement>) => {
    const steps: Record<string, [1 | -1, StepKind]> = {
      ArrowUp: [1, e.shiftKey ? "fine" : "small"], ArrowRight: [1, e.shiftKey ? "fine" : "small"],
      ArrowDown: [-1, e.shiftKey ? "fine" : "small"], ArrowLeft: [-1, e.shiftKey ? "fine" : "small"],
      PageUp: [1, "page"], PageDown: [-1, "page"], Home: [-1, "home"], End: [1, "end"],
    };
    // Every key handled here stops at the panel: the app-wide shortcut router listens on
    // window and does not skip a focused role=slider, so an unstopped Home would also move
    // the playhead, an arrow nudge the selected clips (hooks/useKeyboardShortcuts.ts).
    if (e.key === "Enter") { e.preventDefault(); e.stopPropagation(); setTyping(editText(field, value)); return; }
    const s = steps[e.key];
    if (!s) return;
    e.preventDefault();
    e.stopPropagation();
    nudge({ band, [field]: stepField(field, base(band, field), s[0], s[1]) });
  };

  return (
    <span className={`pp-eq-f ${field}${inert ? " inert" : ""}`} title={inert ? OFF_HINT : undefined}>
      <span className="pp-eq-cap" aria-hidden="true">{FIELD_LABEL[field]}</span>
      {typing !== null ? (
        <input className="pp-eq-in" data-testid={`pp-eq-input-${field}`} aria-label={label} autoFocus value={typing}
          onChange={(e) => setTyping(e.target.value)} onBlur={commit}
          onKeyDown={(e) => {
            if (e.key === "Enter") { e.preventDefault(); e.stopPropagation(); commit(); }
            else if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); setTyping(null); }
          }} />
      ) : (
        <span className="pp-eq-v" role="slider" tabIndex={0} data-testid={`pp-eq-field-${field}`}
          aria-label={label} aria-valuemin={r.min} aria-valuemax={r.max} aria-valuenow={Number(value.toFixed(2))}
          aria-valuetext={inert ? `${text}, inactive while the band is at 0 dB` : text}
          onPointerDown={(e: PointerEvent<HTMLSpanElement>) => {
            if (e.button !== 0) return;
            e.preventDefault();
            (e.currentTarget as Element).setPointerCapture?.(e.pointerId);
            start.current = { y: e.clientY, v: value };
            edit.begin();
          }}
          onPointerMove={(e) => {
            if (!start.current) return;
            edit.update({ band, [field]: scrubField(field, start.current.v, start.current.y - e.clientY, e.shiftKey ? 600 : 150) });
          }}
          onPointerUp={finish} onPointerCancel={finish} onLostPointerCapture={finish}
          onKeyDown={onKeyDown}
          onDoubleClick={() => setTyping(editText(field, value))}>
          {text}
        </span>
      )}
    </span>
  );
}

/** Tracktion's 4-band EQ: the exact composite response with four draggable band nodes,
 *  and Freq / Gain / Q of the selected band underneath. */
function EqPanel({ plugin, sampleRate, setParam }: PanelProps) {
  const [sel, setSel] = useState(0);
  // The dB range is held still during a node drag, so the axis does not rescale under the
  // pointer when a gain crosses ±12 dB; it widens on release.
  const [frozen, setFrozen] = useState<number | null>(null);
  const edit = useDragSend<BandEdit>((e, gesture) => {
    for (const { paramIndex, norm } of editToParams(plugin, e)) setParam(paramIndex, norm, { gesture });
  });
  const bands = withEdit(readBands(plugin), edit.live);
  const range = frozen ?? dbRange(bands, sampleRate);
  const clipped = maxAbsDb(bands, sampleRate) > range + 1e-6;
  const g = geometry(sampleRate, range);
  const curve = curveD(bands, sampleRate, g);
  const zeroY = g.y.to(0);
  const solo = isBandOff(bands[sel].gain) ? "" : curveD(bands, sampleRate, g, g.w, sel);

  // Keys and wheel notches: one undo step per burst, each step built on the last one sent.
  const last = useRef<{ band: number; vals: Partial<BandValues>; at: number } | null>(null);
  const bandsRef = useRef(bands);
  bandsRef.current = bands;
  const base = (band: number, field: BandField): number => {
    const l = last.current;
    const v = l && l.band === band && Date.now() - l.at < BURST_MS ? l.vals[field] : undefined;
    return v ?? bandsRef.current[band][field];
  };
  const nudge = (e: BandEdit) => {
    // Only what would change is sent: End at the top, or a reset of a band already at its
    // defaults, sends nothing rather than an empty undo step.
    const c = changedFields(plugin, e, (field) => base(e.band, field));
    if (!c) return;
    const { band, ...vals } = c;
    const prev = last.current && last.current.band === band && Date.now() - last.current.at < BURST_MS ? last.current.vals : {};
    last.current = { band, vals: { ...prev, ...vals }, at: Date.now() };
    edit.nudge(c);
  };
  const baseRef = useRef(base);
  baseRef.current = base;
  const editRef = useRef(edit);
  editRef.current = edit;

  // Wheel on a node sets its Q, in proportion to the wheel's travel, as ONE gesture (one undo
  // step, sends throttled to a frame) that ends WHEEL_IDLE_MS after the last event. A native
  // listener, because React's wheel handler is passive and could not stop the inspector
  // scrolling underneath.
  const svgRef = useRef<SVGSVGElement>(null);
  const wheel = useRef<{ band: number; q0: number; oct: number; sent: number; begun: boolean; timer: ReturnType<typeof setTimeout> | null } | null>(null);
  useEffect(() => {
    const svg = svgRef.current;
    if (!svg) return;
    const finish = () => {
      const w = wheel.current;
      if (!w) return;
      if (w.timer) clearTimeout(w.timer);
      wheel.current = null;
      if (w.begun) editRef.current.end();
    };
    const onWheel = (ev: WheelEvent) => {
      if (ev.ctrlKey) return;                       // a trackpad pinch, not a scroll
      const el = (ev.target as Element | null)?.closest?.("[data-band]");
      // macOS turns Shift+mouse-wheel into a horizontal scroll.
      const delta = ev.deltaY !== 0 ? ev.deltaY : ev.shiftKey ? ev.deltaX : 0;
      if (!el || delta === 0) return;
      ev.preventDefault();
      const i = Number(el.getAttribute("data-band"));
      if (wheel.current && wheel.current.band !== i) finish();
      if (!wheel.current) {
        const q0 = baseRef.current(i, "q");
        wheel.current = { band: i, q0, oct: 0, sent: wheelQ(q0, 0).q, begun: false, timer: null };
        setSel(i);
      }
      const w = wheel.current;
      if (w.timer) clearTimeout(w.timer);
      w.timer = setTimeout(finish, WHEEL_IDLE_MS);
      const next = wheelQ(w.q0, w.oct + wheelOctaves(delta, ev.deltaMode, svg.clientHeight || PLOT_H, ev.shiftKey));
      w.oct = next.octaves;
      if (next.q === w.sent) return;
      if (!w.begun) { editRef.current.begin(); w.begun = true; }
      w.sent = next.q;
      // Keys pressed straight after build on the wheel's value, not on a stale snapshot.
      last.current = { band: i, vals: { q: next.q }, at: Date.now() };
      editRef.current.update({ band: i, q: next.q });
    };
    svg.addEventListener("wheel", onWheel, { passive: false });
    return () => { svg.removeEventListener("wheel", onWheel); finish(); };
  }, []);

  const drag = useRef<{
    band: number; alt: boolean; x0: number; y0: number; offX: number; offY: number; q0: number; movedX: boolean; movedY: boolean;
  } | null>(null);

  const nodeKey = (i: number, e: KeyboardEvent<SVGGElement>) => {
    const fine = e.shiftKey ? "fine" : "small";
    const map: Record<string, () => BandEdit> = {
      ArrowRight: () => ({ band: i, freq: stepField("freq", base(i, "freq"), 1, fine) }),
      ArrowLeft: () => ({ band: i, freq: stepField("freq", base(i, "freq"), -1, fine) }),
      ArrowUp: () => ({ band: i, gain: stepField("gain", base(i, "gain"), 1, fine) }),
      ArrowDown: () => ({ band: i, gain: stepField("gain", base(i, "gain"), -1, fine) }),
      PageUp: () => ({ band: i, q: stepField("q", base(i, "q"), 1, "small") }),
      PageDown: () => ({ band: i, q: stepField("q", base(i, "q"), -1, "small") }),
      Delete: () => ({ band: i, ...BANDS[i].defaults }),
      Backspace: () => ({ band: i, ...BANDS[i].defaults }),
    };
    const f = map[e.key];
    if (!f) return;
    // Stop here as well as preventDefault: otherwise the window shortcut router would also
    // delete the selected clips on Backspace, or nudge them on an arrow.
    e.preventDefault();
    e.stopPropagation();
    nudge(f());
  };

  // The band picker is a radio group: arrows / Home / End move the choice (and focus), and
  // stay inside the panel.
  const bandRefs = useRef<(HTMLButtonElement | null)[]>([]);
  const bandsKey = (e: KeyboardEvent<HTMLDivElement>) => {
    const n = BANDS.length;
    const at = bandRefs.current.indexOf(e.target as HTMLButtonElement);
    const cur = at >= 0 ? at : sel;
    const to = e.key === "ArrowRight" || e.key === "ArrowDown" ? (cur + 1) % n
      : e.key === "ArrowLeft" || e.key === "ArrowUp" ? (cur + n - 1) % n
        : e.key === "Home" ? 0 : e.key === "End" ? n - 1 : null;
    if (to === null) return;
    e.preventDefault();
    e.stopPropagation();
    setSel(to);
    bandRefs.current[to]?.focus();
  };

  const gridHz = [100, 1000, 10000].filter((f) => f < g.top);
  const spec = BANDS[sel], v = bands[sel], off = isBandOff(v.gain);

  return (
    <div className="pp-eq" data-testid="pp-eq">
      <svg ref={svgRef} className={`pp-plot pp-eq-plot${plugin.enabled ? "" : " bypassed"}`} data-testid="pp-eq-plot"
        viewBox={`0 0 ${g.w} ${g.h}`} role="group"
        aria-label={`4-band EQ response, ${eqSummary(plugin)}`}>
        {gridHz.map((f) => <line key={f} className="grid" x1={g.x.to(f)} x2={g.x.to(f)} y1={0} y2={g.h} />)}
        {[range / 2, -range / 2].map((db) => <line key={db} className="grid" x1={0} x2={g.w} y1={g.y.to(db)} y2={g.y.to(db)} />)}
        <line className="zero" x1={0} x2={g.w} y1={zeroY} y2={zeroY} />
        <path className="area" d={fillPath(curve, 0, g.w, zeroY)} />
        {solo && <path className="pp-eq-solo" data-testid="pp-eq-solo" d={solo} />}
        <path className="curve" data-testid="pp-eq-curve" d={curve} />
        {/* Axis text after the curve, so its halo keeps it legible where the curve runs through. */}
        {gridHz.map((f) => <text key={f} className="axis" x={g.x.to(f) + 2} y={g.h - 2}>{f >= 1000 ? `${f / 1000}k` : f}</text>)}
        <text className="axis" x={2} y={PLOT_PAD + 5}>+{range}</text>
        <text className="axis" x={2} y={g.h - PLOT_PAD - 1}>-{range}</text>
        {clipped && (
          <text className="axis pp-eq-clip" data-testid="pp-eq-clip" x={g.w - 2} y={PLOT_PAD + 5} textAnchor="end">
            <title>The response goes past ±{range} dB here; the curve is cut at the edge.</title>
            beyond ±{range} dB
          </text>
        )}
        {BANDS.map((b, i) => {
          const p = nodePos(bands[i], g);
          return (
            <g key={b.label} data-band={i}
              onPointerDownCapture={(e) => {
                if (e.button !== 0 || !svgRef.current) return;
                const pt = clientToSvg(svgRef.current, e.clientX, e.clientY);
                drag.current = {
                  band: i, alt: e.altKey, x0: pt.x, y0: pt.y, offX: p.x - pt.x, offY: p.y - pt.y, q0: bands[i].q,
                  movedX: false, movedY: false,
                };
                setSel(i);
                setFrozen(range);
              }}>
              <DragNode x={p.x} y={p.y} r={6.5} label={b.label} hollow={isBandOff(bands[i].gain)} active={sel === i}
                ariaLabel={`${b.name} (drag: frequency and gain; Alt-drag or wheel: Q)`}
                ariaValueText={bandValueText(bands[i])} testId={`pp-eq-node-${b.label}`}
                valueNow={bands[i].gain} valueMin={-20} valueMax={20}
                onStart={() => edit.begin()}
                onMove={(pt) => {
                  const d = drag.current;
                  if (!d) return;
                  if (d.alt) { edit.update({ band: i, q: qFromDrag(d.q0, d.y0 - pt.y) }); return; }
                  // An axis is written only once the pointer has moved along it, so a purely
                  // vertical drag keeps the band's frequency (a node clamped to the right edge
                  // at a low sample rate would otherwise have it rewritten to the edge's Hz).
                  d.movedX ||= Math.abs(pt.x - d.x0) > 1;
                  d.movedY ||= Math.abs(pt.y - d.y0) > 1;
                  if (!d.movedX && !d.movedY) return;
                  const t = dragTarget({ x: pt.x + d.offX, y: pt.y + d.offY }, g);
                  edit.update({ band: i, ...(d.movedX ? { freq: t.freq } : {}), ...(d.movedY ? { gain: t.gain } : {}) });
                }}
                onEnd={() => { drag.current = null; setFrozen(null); edit.end(); }}
                onKeyDown={(e) => nodeKey(i, e)}
                onDoubleClick={() => nudge({ band: i, ...b.defaults })}
                onFocus={() => setSel(i)} />
            </g>
          );
        })}
      </svg>
      <div className="pp-eq-row">
        {/* The selected band is the pressed segment; a band that is processing carries a small
            lit LED under its letter (at 0 dB the engine skips it, and its node on the plot is hollow). */}
        <div className="pp-seg pp-eq-bands" role="radiogroup" aria-label="Band" onKeyDown={bandsKey}>
          {BANDS.map((b, i) => {
            const bandOff = isBandOff(bands[i].gain);
            return (
              <button key={b.label} ref={(el) => { bandRefs.current[i] = el; }} type="button" role="radio"
                aria-checked={sel === i} tabIndex={sel === i ? 0 : -1} title={bandOff ? `${b.name}: off at 0 dB` : b.name}
                aria-label={b.name} data-testid={`pp-eq-band-${b.label}`}
                className={`pp-eq-b${bandOff ? "" : " live"}`}
                onClick={() => setSel(i)}>{b.label}</button>
            );
          })}
        </div>
        <Scrub key={`f${sel}`} field="freq" band={sel} bandName={spec.name} value={v.freq} edit={edit} nudge={nudge} base={base} inert={off} />
        <Scrub key={`g${sel}`} field="gain" band={sel} bandName={spec.name} value={v.gain} edit={edit} nudge={nudge} base={base} />
        <Scrub key={`q${sel}`} field="q" band={sel} bandName={spec.name} value={v.q} edit={edit} nudge={nudge} base={base} inert={off} />
      </div>
    </div>
  );
}

/** The minimized row's thumbnail: the same exact composite curve, 44×14. */
function EqMini({ plugin, sampleRate }: PanelProps) {
  const bands = readBands(plugin);
  const g = geometry(sampleRate, dbRange(bands, sampleRate), 44, 14, 1);
  const zeroY = g.y.to(0);
  return (
    <svg className={`pp-eq pp-eq-mini${plugin.enabled ? "" : " bypassed"}`} data-testid="pp-eq-mini"
      width={44} height={14} viewBox="0 0 44 14" aria-hidden="true">
      <line className="z" x1={0} x2={44} y1={zeroY} y2={zeroY} />
      <path className="c" d={curveD(bands, sampleRate, g, 44)} />
    </svg>
  );
}

/** "4-Band EQ", not the engine's "4-Band Equaliser". */
export const eqPanelDef: PanelDef = { title: "4-Band EQ", Panel: EqPanel, summary: eqSummary, Mini: EqMini };
