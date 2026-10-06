import { StateDial, useFreeRunningPhase } from "./ChorusPanel";
import { fmtPeriod, fmtRate } from "./chorus";
import { plotTopHz } from "./dsp";
import { fmtDb, fmtHz } from "./params";
import {
  PHASER_SPEC, dcBoostDb, fmtFeedback, fmtOct, fmtSpan, nyquistBoostDb, peakBoostDb, phaserDb, phaserSettings,
  phaserSummary, sweepAt, sweepEnvelope, sweepOctaves, sweepSpanHz, type PhaserSettings,
} from "./phaser";
import { curvePath, freqScale, linScale } from "./plot";
import type { PanelDef, PanelProps } from "./types";

const W = 286, H = 50, LO_HZ = 20, FLOOR_DB = -24;
const GRID_HZ = [100, 1000, 10000];
const AXIS_LABEL: Record<number, string> = { 100: "100", 1000: "1k", 10000: "10k" };

/** The plot's top in dB: the response's true peak, 1 + 1/(1−|g|), rounded up to 6 dB. */
export const phaserPlotTop = (g: number): number => Math.max(6, Math.ceil(peakBoostDb(g) / 6) * 6);

/** The words for where the in-band peak sits. */
export const peakRegion = (hz: number): "lows" | "highs" => (hz < 1000 ? "lows" : "highs");

const ILLUSTRATIVE = "The faint moving curve is illustrative: it moves at the set rate but is not synced to the audio.";

/** The engine's exact magnitude response. Primary, and static: the band the response
 *  travels over a whole sweep (highest and lowest |H| at each frequency) with its upper
 *  edge drawn as the curve, over the span the notches sweep. Secondary: a faint, thin
 *  curve at an illustrative sweep position that free-runs at the real rate (a triangle in
 *  octaves) but is NOT synced to the audio; it rests mid-sweep under reduced motion. A
 *  bypassed phaser draws the truth: flat, and still. */
function PhaserPlot({ s, fs, enabled }: { s: PhaserSettings; fs: number; enabled: boolean }) {
  const { cycles, animating } = useFreeRunningPhase(s.rate, enabled, 0.25);
  const top = plotTopHz(fs);
  const x = freqScale(LO_HZ, top, W);
  const yTop = phaserPlotTop(s.feedback);
  const y = linScale(FLOOR_DB, yTop, H);
  const env = sweepEnvelope(fs, s.depth, s.feedback, 128, LO_HZ);
  const at = (arr: number[]) => {
    const m = new Map(env.freqs.map((f, i) => [f, arr[i]] as const));
    return (f: number) => m.get(f) ?? 0;
  };
  const upper = curvePath(at(env.maxDb), env.freqs, x, y, 0, H);
  const lower = curvePath(at(env.minDb), [...env.freqs].reverse(), x, y, 0, H);
  const band = `${upper} ${lower.replace(/^M/, "L")} Z`;
  const swp = sweepAt(fs, sweepOctaves(s.depth, cycles));
  const now = curvePath((f) => phaserDb(f, fs, swp, s.feedback), env.freqs, x, y, 0, H);
  const flat = curvePath(() => 0, env.freqs, x, y, 0, H);
  const [spanLo, spanHi] = sweepSpanHz(fs, s.depth);
  const bx0 = x.to(Math.max(LO_HZ, spanLo)), bx1 = x.to(Math.min(top, spanHi));
  return (
    <svg className={`pp-plot pp-phaser-plot${enabled ? "" : " bypassed"}`} data-testid="v3-phaser-plot"
      data-animating={animating ? "" : undefined} data-top-db={yTop} viewBox={`0 0 ${W} ${H}`} role="img"
      aria-label={`Phaser response: the notches sweep ${fmtSpan(fs, s.depth)} and back every ${fmtPeriod(s.rate)}; `
        + `the shaded band is everywhere the response goes, up to ${fmtDb(env.peakDb)}. ${ILLUSTRATIVE}`}>
      <title>{`The shaded band is where the response goes over a whole sweep. ${ILLUSTRATIVE}`}</title>
      <rect className="pp-phaser-span" data-testid="v3-phaser-span" x={bx0} y={0} width={Math.max(0, bx1 - bx0)} height={H} />
      {GRID_HZ.filter((f) => f < top).map((f) => (
        <g key={f}>
          <line className="grid" x1={x.to(f)} x2={x.to(f)} y1={0} y2={H} />
          <text className="axis" x={x.to(f) + 2} y={H - 2}>{AXIS_LABEL[f]}</text>
        </g>
      ))}
      <line className="grid" x1={0} x2={W} y1={y.to(yTop)} y2={y.to(yTop)} />
      <text className="axis" x={W - 2} y={y.to(yTop) + 6.5} textAnchor="end">+{yTop}</text>
      <line className="zero" x1={0} x2={W} y1={y.to(0)} y2={y.to(0)} />
      <text className="axis" x={W - 2} y={y.to(0) - 1.5} textAnchor="end">0</text>
      {enabled ? (
        <>
          <path className="area" d={band} data-testid="v3-phaser-band" />
          <path className="curve" d={upper} data-testid="v3-phaser-peak" />
          <path className="pp-phaser-now" d={now} data-testid="v3-phaser-curve" />
        </>
      ) : (
        <path className="curve" d={flat} data-testid="v3-phaser-curve" />
      )}
    </svg>
  );
}

/** Phaser: the response, then Rate, Depth (octaves, with the Hz span) and Feedback, and the
 *  level lift the engine really applies (dry + wet summed 1:1, no output trim). */
function PhaserPanel({ plugin, sampleRate, setState }: PanelProps) {
  const fs = sampleRate > 0 ? sampleRate : 48000;
  const s = phaserSettings(plugin);
  const common = { plugin, setState };
  const env = sweepEnvelope(fs, s.depth, s.feedback, 128, LO_HZ);
  const nyq = `fs/2 (${fmtHz(fs / 2)})`;
  /** The highest gain the drawn band reaches, with the region it is in. */
  const peakText = (g: number) => {
    const e = sweepEnvelope(fs, s.depth, g, 128, LO_HZ);
    return `${peakRegion(e.peakHz)} up to ${fmtDb(e.peakDb)}`;
  };
  return (
    <div className="pp-phaser" data-testid="v3-phaser">
      <PhaserPlot s={s} fs={fs} enabled={plugin.enabled} />
      <div className="pp-phaser-ctl">
        <StateDial {...common} stateKey="rate" label="Rate" spec={PHASER_SPEC.rate} fmt={fmtRate} testId="v3-phaser-rate"
          valueText={(v) => `${fmtRate(v)}, up and back every ${fmtPeriod(v)}`} />
        <StateDial {...common} stateKey="depth" label="Depth" spec={PHASER_SPEC.depth} fmt={fmtOct} testId="v3-phaser-depth"
          valueText={(v) => `${v.toFixed(1)} octaves, sweeps ${fmtSpan(fs, v)}`} />
        <StateDial {...common} stateKey="feedback" label="Feedback" spec={PHASER_SPEC.feedback} fmt={fmtFeedback} bipolar
          testId="v3-phaser-feedback"
          valueText={(v) => `${fmtFeedback(v)}, ${peakText(v)}`} />
        <div className="pp-phaser-read">
          <span data-testid="v3-phaser-sweep" title="The span the notches sweep: about 100 Hz up to 100 Hz × 2^depth.">
            <i>sweep</i>{fmtSpan(fs, s.depth)}
          </span>
          <span data-testid="v3-phaser-boost"
            title={`The phaser adds its filtered signal to the dry one with no output trim, so it is louder than the input. `
              + `This is the highest gain anywhere in the drawn band (20 Hz to ${fmtHz(plotTopHz(fs))}) over a whole sweep, `
              + `at about ${fmtHz(env.peakHz)}. In closed form: ${fmtDb(dcBoostDb(s.feedback))} at DC (1 + 1/(1 − feedback)), `
              + `${fmtDb(nyquistBoostDb(s.feedback))} at ${nyq}, which is above the plot and above hearing.`}>
            <i>{peakRegion(env.peakHz)} peak</i>{fmtDb(env.peakDb)}
          </span>
        </div>
      </div>
    </div>
  );
}

export const phaserPanelDef: PanelDef = { Panel: PhaserPanel, summary: phaserSummary };
