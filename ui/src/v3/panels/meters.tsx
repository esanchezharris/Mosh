import { useEffect, useReducer, useRef } from "react";
import { useStore } from "../../store";
import { pluginKey } from "../../ui/tuner";
import type { PluginMeterReading } from "../../types";

/** How long the last meter frame stays after the rail stops sending (transport stopped,
 *  plugin bypassed): long enough not to flicker between frames, short enough to clear. */
export const METER_HOLD_MS = 350;

/** This plugin's live meter frame from the 30 Hz "plugin_meters" rail, held briefly after
 *  it stops. Subscribes to this one plugin only, so only the component using it re-renders. */
export function usePluginMeter<T extends PluginMeterReading>(
  trackId: string, index: number, expect?: { type?: string | readonly string[]; itemId?: string },
): T | undefined {
  // A frame is keyed by chain position, so right after a reorder or delete a frame can
  // belong to the plugin that used to sit here: check its type and id when given.
  const current = useStore((s) => {
    const m = s.pluginMeters[pluginKey(trackId, index)];
    if (!m) return undefined;
    if (expect?.type !== undefined && !(Array.isArray(expect.type) ? expect.type.includes(m.type) : m.type === expect.type)) return undefined;
    if (expect?.itemId && m.itemId && m.itemId !== expect.itemId) return undefined;
    return m;
  }) as T | undefined;
  // The last frame is kept in a ref (no extra render per 30 Hz frame); state is only used
  // to clear it METER_HOLD_MS after the frames stop.
  const last = useRef<T | undefined>(current);
  const [, expire] = useReducer((n: number) => n + 1, 0);
  if (current) last.current = current;
  useEffect(() => {
    if (current) return;
    const timer = setTimeout(() => { last.current = undefined; expire(); }, METER_HOLD_MS);
    return () => clearTimeout(timer);
  }, [current]);
  return current ?? last.current;
}

/** Whether the transport is playing: illustrative motion (an LFO dot) rests while it is not,
 *  so nothing moves that is not being heard. */
export function useTransportPlaying(): boolean {
  return useStore((s) => !!s.transport?.playing);
}

/** The fraction (0-1) a value fills on a meter scale. */
export const meterFill = (value: number, max: number, min = 0): number =>
  !Number.isFinite(value) || !(max > min) ? 0 : Math.min(1, Math.max(0, (value - min) / (max - min)));

/** Remembers the largest value seen in the last `holdMs`: a peak-hold tick. With no value
 *  (the meter is idle) there is nothing to hold: the peak resets. */
export function usePeakHold(value: number | undefined, holdMs = 1000): number | undefined {
  const peak = useRef<{ v: number; at: number } | null>(null);
  if (value === undefined) { peak.current = null; return undefined; }
  const now = Date.now();
  if (!peak.current || value >= peak.current.v || now - peak.current.at > holdMs) peak.current = { v: value, at: now };
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
  const peak = usePeakHold(value);
  const fill = meterFill(v, max, min), tick = peak === undefined ? 0 : meterFill(peak, max, min);
  // Gain reduction hangs from the top (vertical) or the right (horizontal); a level rises
  // from the bottom or the left. The peak tick sits at the same end the fill grows from.
  const dim = vertical ? "height" : "width";
  const pos = tone === "gr" ? (vertical ? "top" : "right") : (vertical ? "bottom" : "left");
  return (
    <div className={`pp-bar ${tone}${vertical ? " v" : ""}${value === undefined ? " idle" : ""}`} data-testid={testId}
      role="meter" aria-label={label} aria-valuemin={min} aria-valuemax={max} aria-valuenow={Number(v.toFixed(1))} aria-valuetext={valueText}>
      <i className="fill" style={{ [dim]: `${(fill * 100).toFixed(1)}%` }} />
      {peak !== undefined && tick >= 0.02 && <i className="tick" style={{ [pos]: `${(tick * 100).toFixed(1)}%` }} />}
    </div>
  );
}
