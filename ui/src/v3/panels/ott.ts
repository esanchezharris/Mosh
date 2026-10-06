// Mosh OTT: the view maths for its panel, pure so it is unit-tested.
//
// The engine (src/plugins/moshfx/MoshOTTDsp.cpp, MoshOTTPlugin.cpp) splits the signal into
// three bands with two FIXED one-pole crossovers (120 Hz and 3.5 kHz), follows each band
// with a peak envelope, and moves each band's gain with a fixed law scaled by Amount:
// downward 4:1 above -20 dBFS (weighted 0.35), an upward lift inside -76..-38 dBFS
// (weighted 0.25), nothing in between. Every parameter is linear in its normalised value.
import type { OttMeter, Plugin, PluginMeterReading } from "../../types";
import { fmtDb, fmtMs, param, physOf, type Range } from "./params";

export const OTT_RANGES = {
  amount: { min: 0, max: 1 },
  time: { min: 5, max: 500 },
  trim: { min: -12, max: 12 },
  mix: { min: 0, max: 1 },
  output: { min: -18, max: 6 },
} satisfies Record<string, Range>;

/** Param indices (MoshOTTPlugin.cpp:45-51). */
export const OTT_PARAM = { amount: 0, time: 1, low: 2, mid: 3, high: 4, mix: 5, output: 6 } as const;

/** The engine's defaults in physical units (MoshOTTPlugin.cpp:37-43). */
export const OTT_DEFAULTS = { amount: 0.12, time: 120, trim: 0, mix: 1, output: -1 } as const;

/** The fixed crossovers (MoshOTTDsp.cpp:66-67). */
export const OTT_SPLIT_HZ = { low: 120, high: 3500 } as const;

export type OttBandDef = { key: "low" | "mid" | "high"; label: string; range: string; title: string; param: number };
export const OTT_BANDS: readonly OttBandDef[] = [
  { key: "low", label: "LOW", range: "<120 Hz", title: "Low band: below 120 Hz", param: OTT_PARAM.low },
  { key: "mid", label: "MID", range: "120–3.5k", title: "Mid band: 120 Hz to 3.5 kHz", param: OTT_PARAM.mid },
  { key: "high", label: "HIGH", range: ">3.5 kHz", title: "High band: above 3.5 kHz", param: OTT_PARAM.high },
];

/** The fixed gain law's landmarks (MoshOTTDsp.cpp:16-34). */
export const OTT_THRESHOLD_DB = -20;
export const OTT_LIFT_WINDOW_DB = { lo: -76, hi: -38 } as const;
/** Amount at or below this takes the output-only path (MoshOTTDsp.cpp:57-64). */
export const OTT_AMOUNT_EPS = 0.0001;

/** The axis the band level bar spans (dBFS) and the bipolar gain bar's half-scale (dB):
 *  the law's largest movement is 5.25 dB down (0 dBFS envelope) and 4.275 dB up. */
export const OTT_LEVEL_AXIS = { min: -80, max: 0 } as const;
export const OTT_GAIN_SCALE_DB = 6;

/** The band gain (dB) the engine applies for an envelope level `levelDb`, Amount `amount`
 *  (0-1) and the band's trim: the exact law of MoshOTTDsp.cpp ottGainDb with the fixed
 *  upward 0.25 and downward 0.35 weights (MoshFxDsp.h:13-14). */
export function ottGainDb(levelDb: number, amount: number, trimDb = 0): number {
  const a = Math.min(1, Math.max(0, amount));
  let g = trimDb;
  if (levelDb > -20) {
    const compressed = -20 + (levelDb + 20) / 4;
    g += (compressed - levelDb) * 0.35 * a;
  }
  if (levelDb > -76 && levelDb < -38) g += Math.min(18, (-38 - levelDb) * 0.45) * 0.25 * a;
  return g;
}

/** The envelope's time constants (ms) for a Time setting: release = Time, attack =
 *  0.18 × Time, each at least 1 ms (MoshOTTDsp.cpp:68-70). */
export function ottTaus(timeMs: number): { attackMs: number; releaseMs: number } {
  const t = Math.max(0.001, timeMs / 1000);
  return { attackMs: Math.max(0.001, 0.18 * t) * 1000, releaseMs: t * 1000 };
}

export type OttSettings = { amount: number; time: number; low: number; mid: number; high: number; mix: number; output: number };

export function ottSettings(plugin: Plugin): OttSettings {
  const p = (i: number, r: Range) => physOf(param(plugin, i), r);
  return {
    amount: p(OTT_PARAM.amount, OTT_RANGES.amount),
    time: p(OTT_PARAM.time, OTT_RANGES.time),
    low: p(OTT_PARAM.low, OTT_RANGES.trim),
    mid: p(OTT_PARAM.mid, OTT_RANGES.trim),
    high: p(OTT_PARAM.high, OTT_RANGES.trim),
    mix: p(OTT_PARAM.mix, OTT_RANGES.mix),
    output: p(OTT_PARAM.output, OTT_RANGES.output),
  };
}

/** True when Amount is so low the engine skips the bands: only Output applies. */
export const ottOutputOnly = (amount: number): boolean => amount <= OTT_AMOUNT_EPS;

/** "12%"; a non-zero Amount that rounds to 0 reads "<1%" (it is still active). */
export function fmtAmount(amount: number): string {
  if (amount > OTT_AMOUNT_EPS && amount < 0.005) return "<1%";
  return `${Math.round(amount * 100)}%`;
}

/** A dB value with no unit, one decimal, never "-0.0": "+2.0", "-1.5", "0.0". */
export function fmtDbBare(db: number): string {
  return fmtDb(db).replace(/ dB$/, "");
}

/** The minimized line: what the OTT is doing. */
export function ottSummary(plugin: Plugin): string {
  const s = ottSettings(plugin);
  const out = Math.abs(s.output) >= 0.05 ? `out ${fmtDb(s.output)}` : "";
  if (ottOutputOnly(s.amount)) return out ? `amount 0 · ${out} only` : "flat";
  const trims = (["low", "mid", "high"] as const)
    .filter((k) => Math.abs(s[k]) >= 0.05)
    .map((k) => `${k[0].toUpperCase()} ${fmtDbBare(s[k])}`);
  return [
    fmtAmount(s.amount),
    fmtMs(s.time),
    trims.length ? `${trims.join(" ")} dB` : "",
    s.mix < 0.995 ? `mix ${Math.round(s.mix * 100)}%` : "",
    out,
  ].filter(Boolean).join(" · ");
}

export type OttBandView = {
  /** 0-1 of the level bar (OTT_LEVEL_AXIS). */
  level: number;
  /** 0-1 of the gain bar's half: lift draws up, cut draws down; one of them is 0. */
  lift: number;
  cut: number;
  /** The gain is beyond the bar's ±6 dB half-scale. The scale is sized for the law's dynamic
   *  movement (5.25 dB down, 4.275 dB up at most), so it assumes the meter's gainDb is that
   *  movement WITHOUT the band trim (as the mock sends it; the trim is shown exactly by its
   *  slider). The contract does not yet say which; see the framework request to pin it. */
  over: boolean;
  gainText: string;
  levelText: string;
  levelDb: number;
  gainDb: number;
};

/** This plugin's frame, or undefined when the entry at its key belongs to another plugin
 *  (frames are keyed by track and index, so a delete or reorder can briefly leave another
 *  plugin's frame there) or is malformed. */
export function ottMeterOf(m: PluginMeterReading | undefined, itemId?: string): OttMeter | undefined {
  if (!m || m.type !== "moshOTT") return undefined;
  if (itemId && m.itemId && m.itemId !== itemId) return undefined;
  return Array.isArray((m as OttMeter).bands) ? (m as OttMeter) : undefined;
}

const frac = (v: number, lo: number, hi: number) => Math.min(1, Math.max(0, (v - lo) / (hi - lo)));

/** One band's live bars from a meter frame, or null when there is no frame or band. */
export function ottBandView(meter: OttMeter | undefined, band: number): OttBandView | null {
  const b = meter?.bands?.[band];
  if (!b || !Number.isFinite(b.levelDb) || !Number.isFinite(b.gainDb)) return null;
  const g = b.gainDb;
  return {
    level: frac(b.levelDb, OTT_LEVEL_AXIS.min, OTT_LEVEL_AXIS.max),
    lift: g > 0 ? Math.min(1, g / OTT_GAIN_SCALE_DB) : 0,
    cut: g < 0 ? Math.min(1, -g / OTT_GAIN_SCALE_DB) : 0,
    over: Math.abs(g) > OTT_GAIN_SCALE_DB,
    gainText: fmtDb(g),
    levelText: b.levelDb <= -99.5 ? "-∞ dBFS" : `${Math.round(b.levelDb)} dBFS`,
    levelDb: b.levelDb,
    gainDb: g,
  };
}
