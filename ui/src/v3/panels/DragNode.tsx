import { useRef, type KeyboardEvent, type PointerEvent } from "react";
import { clientToSvg } from "./plot";

type Props = {
  x: number; y: number;
  r?: number;
  /** Text inside or beside the node ("L", "1", "H"). */
  label?: string;
  /** Drawn hollow (e.g. an EQ band at 0 dB, which the engine skips). */
  hollow?: boolean;
  active?: boolean;
  ariaLabel: string;
  ariaValueText: string;
  testId?: string;
  onStart?: () => void;
  /** The pointer's position in the SVG's viewBox coordinates. */
  onMove: (pt: { x: number; y: number }, e: PointerEvent<SVGGElement>) => void;
  onEnd?: () => void;
  onKeyDown?: (e: KeyboardEvent<SVGGElement>) => void;
  onDoubleClick?: () => void;
  onFocus?: () => void;
};

/** A focusable, draggable handle on a panel plot. It reports positions in the plot's own
 *  coordinates; the panel turns those into parameter values. */
export function DragNode({ x, y, r = 5, label, hollow, active, ariaLabel, ariaValueText, testId, onStart, onMove, onEnd, onKeyDown, onDoubleClick, onFocus }: Props) {
  const dragging = useRef(false);
  const svgOf = (el: Element) => (el as SVGElement).ownerSVGElement;
  const finish = () => {
    if (!dragging.current) return;
    dragging.current = false;
    onEnd?.();
  };
  return (
    <g className={`pp-node${hollow ? " hollow" : ""}${active ? " active" : ""}`} data-testid={testId}
      transform={`translate(${x.toFixed(2)} ${y.toFixed(2)})`} tabIndex={0} role="slider"
      aria-label={ariaLabel} aria-valuetext={ariaValueText}
      onPointerDown={(e) => {
        if (e.button !== 0) return;
        e.preventDefault();
        e.stopPropagation();
        (e.currentTarget as Element).setPointerCapture?.(e.pointerId);
        (e.currentTarget as unknown as HTMLElement).focus?.();
        dragging.current = true;
        onStart?.();
      }}
      onPointerMove={(e) => {
        if (!dragging.current) return;
        const svg = svgOf(e.currentTarget);
        if (svg) onMove(clientToSvg(svg, e.clientX, e.clientY), e);
      }}
      onPointerUp={finish} onPointerCancel={finish} onLostPointerCapture={finish}
      onKeyDown={onKeyDown} onDoubleClick={onDoubleClick} onFocus={onFocus}>
      <circle r={r + 6} className="hit" />
      <circle r={r} className="dot" />
      {label && <text className="lbl" y={0.5} textAnchor="middle" dominantBaseline="middle">{label}</text>}
    </g>
  );
}
