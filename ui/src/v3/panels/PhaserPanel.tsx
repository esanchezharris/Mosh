import { StateDial, useFreeRunningPhase } from "./ChorusPanel";
import { NEEDS_ENGINE, fmtPeriod, fmtRate, stateSettable } from "./chorus";
import { logFreqs, plotTopHz } from "./dsp";
import { useTransportPlaying } from "./meters";
import { fmtDb, fmtFreq } from "./params";
import {
  PHASER_SPEC, dcBoostDb, fmtFeedback, fmtOct, fmtSpan, nyquistBoostDb, peakBoostDb, phaserDb, phaserSettings,
  phaserSummary, smoothUpper, sweepAt, sweepEnvelope, sweepOctaves, sweepSpanHz, type PhaserKey, type PhaserSettings,
} from "./phaser";
import { curvePath, freqScale, linScale } from "./plot";
import type { PanelDef, PanelProps } from "./types";

// Drawn 273 px wide at the 320 px inspector, so one viewBox unit is one CSS pixel and the
// 9 px axis text renders at 9 px. The top STRIP holds the computed read-outs, above the
// plot's top dB line, which the response never crosses (the top holds the true peak).
export const PLOT_W = 273;
const W = PLOT_W, STRIP = 10, H = STRIP + 46, LO_HZ = 20, FLOOR_DB = -18;
const GRID_HZ = [100, 1000, 10000];
const AXIS_LABEL: Record<number, string> = { 100: "100", 1000: "1k", 10000: "10k" };

/** The plot's top in dB: the response's true peak, 1 + 1/(1−|g|), rounded up to 3 dB, so
 *  the curve uses the plot's height instead of hugging its top. */
export const phaserPlotTop = (g: number): number => Math.max(6, Math.ceil(peakBoostDb(g) / 3) * 3);

/** The words for where the in-band peak sits. */
export const peakRegion = (hz: number): "lows" | "highs" => (hz < 1000 ? "lows" : "highs");

const ILLUSTRATIVE = "The moving curve is illustrative: it moves at the set rate while playing but is not synced to the audio.";

/** The engine's exact magnitude response. Primary: the curve at one sweep position, which
 *  free-runs at the real rate (a triangle in octaves) while the transport plays but is NOT
 *  synced to the audio; it rests mid-sweep when stopped and under reduced motion. Behind
 *  it, static truth: the band the response travels over a whole sweep (highest and lowest
 *  |H| at each frequency), with a faint upper edge, over the span the notches sweep. A
 *  bypassed phaser draws the truth: flat, and still. Above the plot's top line, the two
 *  computed read-outs: the span the notches sweep (left) and the highest level (right). */
function PhaserPlot({ s, fs, enabled }: { s: PhaserSettings; fs: number; enabled: boolean }) {
  const playing = useTransportPlaying();
  const { cycles, animating } = useFreeRunningPhase(s.rate, enabled && playing, 0.25);
  const top = plotTopHz(fs);
  const x = freqScale(LO_HZ, top, W);
  const yTop = phaserPlotTop(s.feedback);
  const yIn = linScale(FLOOR_DB, yTop, H - STRIP);
  const y = { to: (db: number) => STRIP + yIn.to(db), from: (px: number) => yIn.from(px - STRIP) };
  const env = sweepEnvelope(fs, s.depth, s.feedback, 128, LO_HZ);
  const at = (arr: number[]) => {
    const m = new Map(env.freqs.map((f, i) => [f, arr[i]] as const));
    return (f: number) => m.get(f) ?? 0;
  };
  const upper = curvePath(at(smoothUpper(env.maxDb)), env.freqs, x, y, STRIP, H);
  const lower = curvePath(at(env.minDb), [...env.freqs].reverse(), x, y, STRIP, H);
  const band = `${upper} ${lower.replace(/^M/, "L")} Z`;
  const swp = sweepAt(fs, sweepOctaves(s.depth, cycles));
  const now = curvePath((f) => phaserDb(f, fs, swp, s.feedback), env.freqs, x, y, STRIP, H);
  const flat = curvePath(() => 0, env.freqs, x, y, STRIP, H);
  const [spanLo, spanHi] = sweepSpanHz(fs, s.depth);
  const bx0 = x.to(Math.max(LO_HZ, spanLo)), bx1 = x.to(Math.min(top, spanHi));
  const lblRight = s.feedback >= 0;
  const lblX = lblRight ? W - 2 : 2, lblAnchor = lblRight ? "end" : "start";
  const region = peakRegion(env.peakHz);
  const nyq = `fs/2 (${fmtFreq(fs / 2)})`;
  return (
    <svg className={`pp-plot pp-phaser-plot${enabled ? "" : " bypassed"}`} data-testid="v3-phaser-plot"
      data-animating={animating ? "" : undefined} data-top-db={yTop} viewBox={`0 0 ${W} ${H}`} role="img"
      aria-label={`Phaser response: the notches sweep ${fmtSpan(fs, s.depth)} and back every ${fmtPeriod(s.rate)}; `
        + `the shaded band is everywhere the response goes, up to ${fmtDb(env.peakDb)} in the ${region}. ${ILLUSTRATIVE}`}>
      <title>{`The shaded band is where the response goes over a whole sweep; the top line is +${yTop} dB. ${ILLUSTRATIVE}`}</title>
      <rect className="pp-phaser-span" data-testid="v3-phaser-span" x={bx0} y={STRIP} width={Math.max(0, bx1 - bx0)} height={H - STRIP} />
      {GRID_HZ.filter((f) => f < top).map((f) => (
        <g key={f}>
          <line className="grid" x1={x.to(f)} x2={x.to(f)} y1={STRIP} y2={H} />
          <text className="axis" x={x.to(f) + 2} y={H - 2}>{AXIS_LABEL[f]}</text>
        </g>
      ))}
      <line className="grid" data-testid="v3-phaser-top" x1={0} x2={W} y1={y.to(yTop)} y2={y.to(yTop)} />
      <line className="zero" x1={0} x2={W} y1={y.to(0)} y2={y.to(0)} />
      {enabled ? (
        <>
          <path className="area" d={band} data-testid="v3-phaser-band" />
          <path className="pp-phaser-env" d={upper} data-testid="v3-phaser-peak" />
          <path className="curve" d={now} data-testid="v3-phaser-curve" />
        </>
      ) : (
        <path className="curve" d={flat} data-testid="v3-phaser-curve" />
      )}
      {/* "0" (haloed) hangs under its line on the side the response is LOW: positive
          feedback lifts the lows, negative the highs. The top line's value is in the hover
          title: a label there would sit where the moving curve's peaks pass. */}
      <text className="axis" data-testid="v3-phaser-db-zero" x={lblX} y={y.to(0) + 8} textAnchor={lblAnchor}>0</text>
      <text className="pp-phaser-read" data-testid="v3-phaser-sweep" x={3} y={8}>
        <title>The span the notches sweep: about 100 Hz up to 100 Hz × 2^depth.</title>
        sweeps <tspan className="v">{fmtSpan(fs, s.depth)}</tspan>
      </text>
      <text className="pp-phaser-read" data-testid="v3-phaser-boost" x={W - 3} y={8} textAnchor="end">
        <title>{"The phaser adds its filtered signal to the dry one with no output trim, so it is louder than the input. "
          + `This is the highest gain anywhere in the drawn band (20 Hz to ${fmtFreq(top)}) over a whole sweep, `
          + `in the ${region}, at about ${fmtFreq(env.peakHz)}. In closed form: ${fmtDb(dcBoostDb(s.feedback))} at DC `
          + `(1 + 1/(1 − feedback)), ${fmtDb(nyquistBoostDb(s.feedback))} at ${nyq}, which is above the plot and above hearing.`}</title>
        peak <tspan className="v">{fmtDb(env.peakDb)}</tspan> ({region})
      </text>
    </svg>
  );
}

/** Phaser: the response with its sweep span and level lift (the engine sums dry + wet 1:1,
 *  no output trim), then Rate, Depth (octaves, with the Hz span) and Feedback: the dial
 *  row holds only controls. */
function PhaserPanel({ plugin, sampleRate, setState }: PanelProps) {
  const fs = sampleRate > 0 ? sampleRate : 48000;
  const s = phaserSettings(plugin);
  const common = { plugin, setState };
  /** The highest gain the drawn band reaches, with the region it is in. */
  const peakText = (g: number) => {
    const e = sweepEnvelope(fs, s.depth, g, 128, LO_HZ);
    return `${peakRegion(e.peakHz)} up to ${fmtDb(e.peakDb)}`;
  };
  // Depth 0: the sweep stands still, so Rate does nothing (still adjustable).
  const still = s.depth <= 0;
  const oldEngine = (Object.keys(PHASER_SPEC) as PhaserKey[]).some((k) => !stateSettable(plugin, k));
  return (
    <div className="pp-phaser" data-testid="v3-phaser">
      <PhaserPlot s={s} fs={fs} enabled={plugin.enabled} />
      <div className="pp-phaser-ctl">
        <StateDial {...common} stateKey="rate" label="Rate" spec={PHASER_SPEC.rate} fmt={fmtRate} testId="v3-phaser-rate"
          inert={still} title={still ? "No effect at depth 0: the sweep does not move" : undefined}
          valueText={(v) => `${fmtRate(v)}, up and back every ${fmtPeriod(v)}`} />
        <StateDial {...common} stateKey="depth" label="Depth" spec={PHASER_SPEC.depth} fmt={fmtOct} testId="v3-phaser-depth"
          valueText={(v) => `${v.toFixed(1)} octaves, sweeps ${fmtSpan(fs, v)}`} />
        <StateDial {...common} stateKey="feedback" label="Feedback" spec={PHASER_SPEC.feedback} fmt={fmtFeedback} bipolar
          testId="v3-phaser-feedback"
          valueText={(v) => `${fmtFeedback(v)}, ${peakText(v)}`} />
      </div>
      {oldEngine && <div className="pp-phaser-note" data-testid="v3-phaser-engine-note">{NEEDS_ENGINE}</div>}
    </div>
  );
}

export const MINI_W = 44, MINI_H = 14;

/** The minimized row's thumbnail, 44×14, static: the span the notches sweep, shaded on
 *  the plot's frequency axis, and the exact response at rest (mid-sweep, as the stopped
 *  plot draws it), on the plot's own dB axis. Bypassed: the flat truth, muted. */
function PhaserMini({ plugin, sampleRate }: PanelProps) {
  const fs = sampleRate > 0 ? sampleRate : 48000;
  const s = phaserSettings(plugin);
  const top = plotTopHz(fs);
  const x = freqScale(LO_HZ, top, MINI_W);
  const y = linScale(FLOOR_DB, phaserPlotTop(s.feedback), MINI_H);
  const freqs = logFreqs(64, LO_HZ, top);
  const swp = sweepAt(fs, sweepOctaves(s.depth, 0.25));
  const d = curvePath((f) => (plugin.enabled ? phaserDb(f, fs, swp, s.feedback) : 0), freqs, x, y, 0, MINI_H);
  const [spanLo, spanHi] = sweepSpanHz(fs, s.depth);
  const bx0 = x.to(Math.max(LO_HZ, spanLo)), bx1 = x.to(Math.min(top, spanHi));
  return (
    <svg className={`pp-phaser-mini${plugin.enabled ? "" : " bypassed"}`} data-testid="v3-phaser-mini"
      width={MINI_W} height={MINI_H} viewBox={`0 0 ${MINI_W} ${MINI_H}`} aria-hidden="true">
      <rect className="span" data-testid="v3-phaser-mini-span" x={bx0} y={0} width={Math.max(0, bx1 - bx0)} height={MINI_H} />
      <line className="z" x1={0} x2={MINI_W} y1={y.to(0)} y2={y.to(0)} />
      <path className="edge" d={d} />
    </svg>
  );
}

export const phaserPanelDef: PanelDef = { Panel: PhaserPanel, summary: phaserSummary, Mini: PhaserMini };
