import type { InputHTMLAttributes } from "react";

/** Where `value` sits between `min` and `max`, clamped to 0..1 (the slider's fill length). */
export function rangePct(value: number, min: number, max: number): number {
  if (!(max > min) || !Number.isFinite(value)) return 0;
  return Math.min(1, Math.max(0, (value - min) / (max - min)));
}

type Props = Omit<InputHTMLAttributes<HTMLInputElement>, "type" | "value" | "min" | "max" | "step"> & {
  value: number; min: number; max: number; step?: number;
};

/** The V3 slider: a plain range input that publishes its fill as `--pct`, so shell.css can
 *  draw the value as a line with a rounded end instead of the browser's knob (`.rng`). */
export function Range({ value, min, max, step, className, style, ...rest }: Props) {
  return (
    <input type="range" {...rest} min={min} max={max} step={step} value={value}
      className={className ? `rng ${className}` : "rng"}
      style={{ ...style, ["--pct" as string]: `${(rangePct(value, min, max) * 100).toFixed(2)}%` }} />
  );
}
