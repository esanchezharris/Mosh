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

// ── event-like meter fields (4OSC `struck`, sampler `hits`) ─────────────────────────────
// A level is a STATE: holding the last frame on screen is right. A struck key or a pad hit
// is an EVENT: the frame says "this happened since the previous frame", so it must fire once
// per frame, and the same frame held on screen (usePluginMeter keeps it for METER_HOLD_MS)
// must never fire it again. A frame is told apart by its `seq` (the engine counts frames per
// plugin); a frame without one (an older engine) by its object identity, since the store
// builds a new object for every payload.

/** One event a frame reports: a 4OSC key struck (velocity unknown: 1) or a sampler hit. */
export type MeterEvent = { note: number; vel: number };
export type MeterEventField = "struck" | "hits";

/** How long a struck key / a pad hit stays lit after its frame: one short flash. */
export const METER_FLASH_MS = 140;

/** The events in `reading[field]`, as {note, vel} (largest velocity per note). */
export function meterEventsOf(reading: PluginMeterReading | undefined, field: MeterEventField): MeterEvent[] {
  const raw = (reading as Record<string, unknown> | undefined)?.[field];
  if (!Array.isArray(raw)) return [];
  const best = new Map<number, number>();
  for (const e of raw) {
    const note = typeof e === "number" ? e : (e as { note?: unknown })?.note;
    const vel = typeof e === "number" ? 1 : (e as { vel?: unknown })?.vel;
    if (typeof note !== "number" || !Number.isInteger(note) || note < 0 || note > 127) continue;
    const v = typeof vel === "number" && Number.isFinite(vel) ? Math.min(1, Math.max(0, vel)) : 1;
    best.set(note, Math.max(best.get(note) ?? 0, v));
  }
  return [...best].map(([note, vel]) => ({ note, vel }));
}

/** A frame's identity: its `seq` when the engine sends one, else the frame object. */
export const meterFrameKey = (reading: PluginMeterReading | undefined): unknown =>
  reading === undefined ? undefined : typeof reading.seq === "number" ? `seq:${reading.seq}` : reading;

/** One step of event consumption: the events of `reading` if it is a frame not consumed
 *  yet (its key differs from `lastKey`), else none. Pure: the hook below and tests use it. */
export function takeNewMeterEvents(
  lastKey: unknown, reading: PluginMeterReading | undefined, field: MeterEventField,
): { key: unknown; events: MeterEvent[] } {
  const key = meterFrameKey(reading);
  if (reading === undefined || key === lastKey) return { key: lastKey, events: [] };
  return { key, events: meterEventsOf(reading, field) };
}

/** A lit event: `serial` goes up every time the note fires again (key a CSS flash on it so
 *  a re-strike restarts it); `at` is when it fired (ms, Date.now()). */
export type MeterFlash = MeterEvent & { serial: number; at: number };

/** The notes `field` struck in the last `holdMs`, from a meter frame (usePluginMeter's
 *  result): each new frame's events fire ONCE, a held frame never re-fires, a note hit in
 *  two frames in a row fires twice (its serial goes up). Expired flashes clear by themselves. */
export function useMeterEvents(
  reading: PluginMeterReading | undefined, field: MeterEventField, holdMs = METER_FLASH_MS,
): ReadonlyMap<number, MeterFlash> {
  const state = useRef<{ key: unknown; serial: number; active: Map<number, MeterFlash> }>({
    key: undefined, serial: 0, active: new Map(),
  });
  const [, expire] = useReducer((n: number) => n + 1, 0);
  const s = state.current;
  const now = Date.now();
  // Consumed during render, like usePluginMeter's held frame: idempotent for a given frame
  // (a second render of the same frame finds its key already taken).
  const { key, events } = takeNewMeterEvents(s.key, reading, field);
  // A returned map is never mutated: any change makes a new one (so it can be a memo key).
  let next: Map<number, MeterFlash> | null = null;
  const edit = () => (next ??= new Map(s.active));
  for (const [note, f] of s.active) if (now - f.at >= holdMs) edit().delete(note);   // expired first,
  if (key !== s.key) {                                                                 // then this frame's
    s.key = key;
    if (events.length > 0) {
      s.serial += 1;
      for (const e of events) edit().set(e.note, { ...e, serial: s.serial, at: now });
    }
  }
  if (next) s.active = next;
  const active = s.active;
  useEffect(() => {
    if (active.size === 0) return;
    const next = Math.min(...[...active.values()].map((f) => f.at + holdMs)) - Date.now();
    const timer = setTimeout(expire, Math.max(0, next) + 1);
    return () => clearTimeout(timer);
  }, [active, holdMs]);
  return active;
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
