import { useEffect, useRef, useState } from "react";
import { useStore } from "../../store";
import { pluginKey } from "../../ui/tuner";
import type { PluginMeterReading } from "../../types";

/** How long the last meter frame stays after the rail stops sending (transport stopped,
 *  plugin bypassed): long enough not to flicker between frames, short enough to clear. */
export const METER_HOLD_MS = 350;

/** This plugin's live meter frame from the 30 Hz "plugin_meters" rail, held briefly after
 *  it stops. Subscribes to this one plugin only, so only the component using it re-renders. */
export function usePluginMeter<T extends PluginMeterReading>(trackId: string, index: number): T | undefined {
  const current = useStore((s) => s.pluginMeters[pluginKey(trackId, index)]) as T | undefined;
  const [held, setHeld] = useState<T | undefined>(current);
  useEffect(() => {
    if (current) { setHeld(current); return; }
    const timer = setTimeout(() => setHeld(undefined), METER_HOLD_MS);
    return () => clearTimeout(timer);
  }, [current]);
  return current ?? held;
}

/** The fraction (0-1) a value fills on a meter scale. */
export const meterFill = (value: number, max: number, min = 0): number =>
  !Number.isFinite(value) || !(max > min) ? 0 : Math.min(1, Math.max(0, (value - min) / (max - min)));

/** Remembers the largest value seen in the last `holdMs`: a peak-hold tick. */
export function usePeakHold(value: number, holdMs = 1000): number {
  const peak = useRef({ v: value, at: 0 });
  const now = Date.now();
  if (value >= peak.current.v || now - peak.current.at > holdMs) peak.current = { v: value, at: now };
  return peak.current.v;
}

type BarProps = {
  /** The value to show, in the bar's units (e.g. dB of gain reduction). */
  value: number | undefined;
  min?: number;
  max: number;
  /** "gr" fills from the top/right in the warning tone; "level" from the bottom/left. */
  tone?: "gr" | "level";
  vertical?: boolean;
  label: string;
  /** Screen-reader text for the current value. */
  valueText: string;
  testId?: string;
};

/** A thin live meter bar with a one-second peak-hold tick. Idle (no frame) reads as empty. */
export function MeterBar({ value, min = 0, max, tone = "level", vertical, label, valueText, testId }: BarProps) {
  const v = value ?? min;
  const peak = usePeakHold(v);
  const fill = meterFill(v, max, min), tick = meterFill(peak, max, min);
  // Gain reduction hangs from the top (vertical) or the right (horizontal); a level rises
  // from the bottom or the left. The peak tick sits at the same end the fill grows from.
  const dim = vertical ? "height" : "width";
  const pos = tone === "gr" ? (vertical ? "top" : "right") : (vertical ? "bottom" : "left");
  return (
    <div className={`pp-bar ${tone}${vertical ? " v" : ""}${value === undefined ? " idle" : ""}`} data-testid={testId}
      role="meter" aria-label={label} aria-valuemin={min} aria-valuemax={max} aria-valuenow={Number(v.toFixed(1))} aria-valuetext={valueText}>
      <i className="fill" style={{ [dim]: `${(fill * 100).toFixed(1)}%` }} />
      {peak > min && <i className="tick" style={{ [pos]: `${(tick * 100).toFixed(1)}%` }} />}
    </div>
  );
}
