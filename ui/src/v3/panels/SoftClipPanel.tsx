import type { KeyboardEvent } from "react";
import type { DynamicsMeter } from "../../types";
import { Dial } from "./Dial";
import { DragNode } from "./DragNode";
import { MeterBar, usePluginMeter } from "./meters";
import { clamp, fmtDb, normOf, param } from "./params";
import { curvePath, linScale, type Scale } from "./plot";
import { useDragSend } from "./useDragSend";
import { dynamicsFrame } from "./compressor";
import {
  CEILING, CEILING_DEFAULT_DB, CLIP_ZONE_FROM_KNEE_DB, clipHint, clipOutDb, clipSettings, clipSummary, DRIVE,
  DRIVE_DEFAULT_DB, fmtDbfs, IN_HI, IN_LO, kneeInDb, kneeTo, OUT_HI, OUT_LO, type ClipSettings,
} from "./softclip";
import type { PanelDef, PanelProps } from "./types";

const PW = 150, PH = 84;
/** The GR bar's full scale (dB): 6 dB is already heavy clipping. */
const GR_MAX = 12;
const XS = Array.from({ length: 64 }, (_, i) => IN_LO + ((IN_HI - IN_LO) * i) / 63);

function useClipFrame(trackId: string, index: number, type: string): DynamicsMeter | undefined {
  return dynamicsFrame(usePluginMeter(trackId, index), type);
}

/** The measured input and output sample peaks. The clipper is memoryless and monotonic,
 *  so the peak out is the curve at the peak in: the dot rides the curve. An arrow at the
 *  right edge when the input is beyond the plot. */
function LiveDot({ trackId, index, type, x, y }: { trackId: string; index: number; type: string; x: Scale; y: Scale }) {
  const m = useClipFrame(trackId, index, type);
  if (!m || m.inDb < IN_LO) return null;
  const cy = y.to(clamp(m.outDb, OUT_LO, OUT_HI));
  if (m.inDb > IN_HI) {
    return <path className="pp-softclip-over" data-testid="pp-softclip-over"
      d={`M${PW - 5} ${(cy - 3).toFixed(2)} L${PW} ${cy.toFixed(2)} L${PW - 5} ${(cy + 3).toFixed(2)} Z`} />;
  }
  return <circle className="pp-softclip-dot" data-testid="pp-softclip-dot" cx={x.to(m.inDb).toFixed(2)} cy={cy.toFixed(2)} r={2.6} />;
}

/** A live, vertical gain-reduction bar with its number. Idle when no frame arrives. */
function GrColumn({ trackId, index, type }: { trackId: string; index: number; type: string }) {
  const m = useClipFrame(trackId, index, type);
  const gr = m ? Math.max(0, m.grDb) : undefined;
  const level = gr === undefined ? "idle" : gr < 1 ? "low" : gr <= 6 ? "mid" : "hot";
  return (
    <div className="pp-softclip-gr" data-testid="pp-softclip-gr" data-level={level} data-live={m ? "" : undefined}>
      <MeterBar value={gr} max={GR_MAX} tone="gr" vertical label="Clipping"
        valueText={gr === undefined ? "No signal" : `${gr.toFixed(1)} dB of clipping`} />
      <span className="n" data-testid="pp-softclip-gr-num">{gr === undefined ? "–" : gr.toFixed(1)}</span>
      <span className="u">dB</span>
    </div>
  );
}

/** Mosh Soft Clipper: its exact tanh curve (input -36..+6 dBFS), the knee as a handle
 *  that follows the pointer or the arrows (its height is the ceiling; drive is the ceiling
 *  minus its input level), a live dot of the measured peaks, a live clipping bar, and
 *  Drive / Ceiling dials. */
function SoftClipPanel({ plugin, trackId, setParam }: PanelProps) {
  const s = clipSettings(plugin);
  const p0 = param(plugin, 0), p1 = param(plugin, 1);
  const send = (v: ClipSettings, gesture: string) => {
    setParam(0, normOf(p0, v.driveDb, DRIVE), { gesture });
    setParam(1, normOf(p1, v.ceilDb, CEILING), { gesture });
  };
  const knee = useDragSend<ClipSettings>(send);
  const shown = knee.live ?? s;
  const x = linScale(IN_HI, IN_LO, PW);   // reversed arguments: IN_LO at the left edge
  const y = linScale(OUT_LO, OUT_HI, PH);
  const curve = curvePath((v) => clipOutDb(v, shown.driveDb, shown.ceilDb), XS, x, y, 0, PH);
  const kIn = kneeInDb(shown.driveDb, shown.ceilDb);
  const zoneX = clamp(x.to(kIn + CLIP_ZONE_FROM_KNEE_DB), 0, PW);
  const lowStartIn = Math.max(IN_LO, OUT_LO - shown.driveDb);
  const onKneeKey = (e: KeyboardEvent<SVGGElement>) => {
    const st = e.shiftKey ? 0.1 : 0.5;
    const k0 = kneeInDb(s.driveDb, s.ceilDb);
    // The arrows move the knee the way a drag does: Right (knee later) is LESS drive; Up
    // raises the ceiling and the drive together, so the knee's input level stays put.
    const move = (dx: number, dy: number) => knee.nudge(kneeTo(k0 + dx, s.ceilDb + dy));
    const steps: Record<string, () => void> = {
      ArrowRight: () => move(st, 0), ArrowLeft: () => move(-st, 0),
      ArrowUp: () => move(0, st), ArrowDown: () => move(0, -st),
    };
    const k = steps[e.key];
    if (!k) return;
    e.preventDefault();
    k();
  };
  return (
    <div className="pp-softclip" data-testid="pp-softclip">
      <div className="pp-softclip-main">
        <svg className={`pp-plot pp-softclip-plot${plugin.enabled ? "" : " bypassed"}`} viewBox={`0 0 ${PW} ${PH}`}
          data-testid="pp-softclip-plot" role="group" aria-label="Transfer curve: input dBFS in, output dBFS out">
          <title>Sample peaks, no oversampling: peaks between samples can pass the ceiling.</title>
          <rect className="pp-softclip-zone" x={zoneX} y={0} width={Math.max(0, PW - zoneX)} height={PH} />
          {[-24, -12, 0].map((g) => <line key={`x${g}`} className="grid" x1={x.to(g)} y1={0} x2={x.to(g)} y2={PH} />)}
          {[-24, -12].map((g) => <line key={`y${g}`} className="grid" x1={0} y1={y.to(g)} x2={PW} y2={y.to(g)} />)}
          {/* Unity (out = in): the curve above it on the left is the level drive adds. */}
          <line className="zero" x1={x.to(OUT_LO)} y1={y.to(OUT_LO)} x2={x.to(OUT_HI)} y2={y.to(OUT_HI)} />
          {/* The two asymptotes the knee joins: out = in + drive, and the ceiling. */}
          <line className="pp-softclip-asym" x1={x.to(lowStartIn)} y1={y.to(lowStartIn + shown.driveDb)} x2={x.to(kIn)} y2={y.to(shown.ceilDb)} />
          <line className="pp-softclip-asym" x1={x.to(kIn)} y1={y.to(shown.ceilDb)} x2={PW} y2={y.to(shown.ceilDb)} />
          <path className="curve" data-testid="pp-softclip-curve" d={curve} />
          <text className="axis" x={2} y={7}>0</text>
          <text className="axis" x={x.to(0) - 2} y={PH - 2} textAnchor="end">0 in</text>
          <LiveDot trackId={trackId} index={plugin.index} type={plugin.type} x={x} y={y} />
          <DragNode x={x.to(kIn)} y={y.to(shown.ceilDb)} r={4} active={knee.live !== null} testId="pp-softclip-knee"
            ariaLabel="Knee: its height is the ceiling; drive is the ceiling minus its input level"
            ariaValueText={`knee ${fmtDbfs(kIn)}, drive ${fmtDb(shown.driveDb)}, ceiling ${fmtDbfs(shown.ceilDb)}`}
            valueNow={shown.ceilDb} valueMin={-12} valueMax={0}
            onStart={knee.begin} onEnd={knee.end} onKeyDown={onKneeKey}
            onDoubleClick={() => knee.nudge({ driveDb: DRIVE_DEFAULT_DB, ceilDb: CEILING_DEFAULT_DB })}
            onMove={(pt) => knee.update(kneeTo(x.from(pt.x), y.from(pt.y)))} />
        </svg>
        <GrColumn trackId={trackId} index={plugin.index} type={plugin.type} />
        <div className="pp-softclip-dials">
          <Dial label="Drive" testId="pp-softclip-drive" size={30} norm={p0?.value ?? normOf(undefined, DRIVE_DEFAULT_DB, DRIVE)}
            defaultNorm={normOf(p0, DRIVE_DEFAULT_DB, DRIVE)} display={fmtDb(s.driveDb)}
            onChange={(v, gesture) => setParam(0, v, { gesture })} />
          <Dial label="Ceiling" testId="pp-softclip-ceiling" size={30} norm={p1?.value ?? normOf(undefined, CEILING_DEFAULT_DB, CEILING)}
            defaultNorm={normOf(p1, CEILING_DEFAULT_DB, CEILING)} display={fmtDbfs(s.ceilDb)}
            onChange={(v, gesture) => setParam(1, v, { gesture })} />
        </div>
      </div>
      <div className="pp-softclip-hint" data-testid="pp-softclip-hint">{clipHint(shown)}</div>
    </div>
  );
}

/** Minimized: a tiny live clipping bar (idle when no frame). */
function SoftClipMini({ plugin, trackId }: PanelProps) {
  const m = useClipFrame(trackId, plugin.index, plugin.type);
  return (
    <span className="pp-softclip mini" data-testid="pp-softclip-mini" data-live={m ? "" : undefined}>
      <MeterBar value={m ? Math.max(0, m.grDb) : undefined} max={GR_MAX} tone="gr" label="Clipping"
        valueText={m ? `${Math.max(0, m.grDb).toFixed(1)} dB of clipping` : "No signal"} />
    </span>
  );
}

export const softClipPanelDef: PanelDef = {
  Panel: SoftClipPanel,
  summary: clipSummary,
  Mini: SoftClipMini,
};
