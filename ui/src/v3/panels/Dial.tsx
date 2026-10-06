import { useEffect, useRef, type KeyboardEvent, type PointerEvent } from "react";
import { useDragSend } from "./useDragSend";

const START = -135, SWEEP = 270;   // degrees, 0 = up, clockwise

function polar(cx: number, cy: number, r: number, deg: number): [number, number] {
  const a = ((deg - 90) * Math.PI) / 180;
  return [cx + r * Math.cos(a), cy + r * Math.sin(a)];
}

/** An SVG arc from angle a to b (degrees, clockwise from 12 o'clock). */
export function arcPath(cx: number, cy: number, r: number, a: number, b: number): string {
  const [lo, hi] = a <= b ? [a, b] : [b, a];
  if (hi - lo < 0.01) return "";
  const [x1, y1] = polar(cx, cy, r, lo);
  const [x2, y2] = polar(cx, cy, r, hi);
  return `M${x1.toFixed(2)} ${y1.toFixed(2)} A${r} ${r} 0 ${hi - lo > 180 ? 1 : 0} 1 ${x2.toFixed(2)} ${y2.toFixed(2)}`;
}

/** The angle (degrees) a 0-1 value sits at on the dial. */
export const dialAngle = (norm: number): number => START + SWEEP * Math.min(1, Math.max(0, norm));

type Props = {
  label: string;
  /** 0-1, the snapshot's normalised value (or any 0-1 position the caller maps). */
  norm: number;
  /** The value read-out under the dial, e.g. "-24.0 dB". */
  display: string;
  /** Called with the new 0-1 position and the gesture id that groups one drag. */
  onChange: (norm: number, gesture: string) => void;
  /** Double-click returns here. */
  defaultNorm?: number;
  /** Snap a position (e.g. whole semitones). */
  quantize?: (norm: number) => number;
  /** Draw the value arc from the centre (for ± controls). */
  bipolar?: boolean;
  size?: number;
  disabled?: boolean;
  /** The words a screen reader hears for the value; defaults to `display`. */
  valueText?: string;
  testId?: string;
};

/** A compact rotary control: drag up/down (Shift for fine), wheel, arrow keys (PageUp/Down
 *  for big steps, Home/End for the ends), double-click for the default. Every drag, and
 *  every burst of keys or wheel, is one undo step. */
export function Dial({ label, norm, display, onChange, defaultNorm, quantize, bipolar, size = 40, disabled, valueText, testId }: Props) {
  const q = (v: number) => {
    const c = Math.min(1, Math.max(0, v));
    return quantize ? quantize(c) : c;
  };
  const drag = useDragSend<number>((v, g) => onChange(v, g));
  const start = useRef<{ y: number; norm: number } | null>(null);
  const shown = drag.live ?? norm;
  const c = size / 2, r = size / 2 - 4;
  const from = bipolar ? 0 : START, to = dialAngle(shown);
  const [px, py] = polar(c, c, r - 6, to);

  const onPointerDown = (e: PointerEvent<SVGSVGElement>) => {
    if (disabled || e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    (e.currentTarget as Element).setPointerCapture?.(e.pointerId);
    start.current = { y: e.clientY, norm: shown };
    drag.begin();
  };
  const onPointerMove = (e: PointerEvent<SVGSVGElement>) => {
    if (!start.current) return;
    const span = e.shiftKey ? 600 : 150;
    drag.update(q(start.current.norm + (start.current.y - e.clientY) / span));
  };
  const finish = () => {
    if (!start.current) return;
    start.current = null;
    drag.end();
  };
  const step = (delta: number) => drag.nudge(q(norm + delta));
  const onKeyDown = (e: KeyboardEvent<SVGSVGElement>) => {
    if (disabled) return;
    const fine = e.shiftKey ? 0.1 : 1;
    const keys: Record<string, () => void> = {
      ArrowUp: () => step(0.01 * fine), ArrowRight: () => step(0.01 * fine),
      ArrowDown: () => step(-0.01 * fine), ArrowLeft: () => step(-0.01 * fine),
      PageUp: () => step(0.1), PageDown: () => step(-0.1),
      Home: () => drag.nudge(q(0)), End: () => drag.nudge(q(1)),
    };
    const k = keys[e.key];
    if (!k) return;
    e.preventDefault();
    k();
  };
  // The wheel turns the dial and must not also scroll the inspector, which needs a
  // non-passive native listener (React's onWheel cannot preventDefault). Trackpads send
  // many small deltas: they are summed into notches of ~100 px (3 lines) each.
  const svgRef = useRef<SVGSVGElement | null>(null);
  const wheelState = useRef({ acc: 0, norm, disabled, quantize: q, nudge: drag.nudge });
  wheelState.current.norm = drag.live ?? norm;
  wheelState.current.disabled = !!disabled;
  wheelState.current.quantize = q;
  wheelState.current.nudge = drag.nudge;
  useEffect(() => {
    const el = svgRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      const st = wheelState.current;
      if (st.disabled || e.deltaY === 0) return;
      e.preventDefault();
      st.acc += e.deltaMode === 1 ? e.deltaY * 33 : e.deltaMode === 2 ? e.deltaY * 400 : e.deltaY;
      const notches = Math.trunc(st.acc / 100);
      if (notches === 0) return;
      st.acc -= notches * 100;
      const next = st.quantize(st.norm - notches * (e.shiftKey ? 0.002 : 0.01));
      st.norm = next;
      st.nudge(next);
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, []);

  return (
    <div className={`pp-dial${disabled ? " off" : ""}`} data-testid={testId}>
      <svg ref={svgRef} width={size} height={size} viewBox={`0 0 ${size} ${size}`} role="slider" tabIndex={disabled ? -1 : 0}
        aria-label={label} aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(shown * 100)}
        aria-valuetext={valueText ?? display} aria-disabled={disabled || undefined}
        onPointerDown={onPointerDown} onPointerMove={onPointerMove} onPointerUp={finish} onPointerCancel={finish}
        onLostPointerCapture={finish} onKeyDown={onKeyDown}
        onDoubleClick={() => { if (!disabled && defaultNorm !== undefined) drag.nudge(q(defaultNorm)); }}>
        <path className="track" d={arcPath(c, c, r, START, START + SWEEP)} />
        <path className="value" d={arcPath(c, c, r, from, to)} />
        <line className="pointer" x1={c} y1={c} x2={px} y2={py} />
      </svg>
      <span className="v">{display}</span>
      <span className="nm">{label}</span>
    </div>
  );
}
