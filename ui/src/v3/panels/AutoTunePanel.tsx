import { useStore } from "../../store";
import { KEYBOARD_KEYS, pitchClassOf, scalePitchClasses, tunerKey } from "../../ui/tuner";
import { TunerReadout, tunerScale } from "../TunerReadout";
import { pluginHint } from "../pluginParams";
import { param } from "./params";
import { GenericParams } from "./GenericParams";
import type { PanelDef, PanelProps } from "./types";

/** Mosh AutoTune: the live scale keyboard, then every control (Key and Scale as menus). */
function AutoTunePanel(props: PanelProps) {
  const { plugin, trackId } = props;
  const hint = pluginHint(plugin);
  return (
    <>
      {plugin.enabled && <TunerReadout plugin={plugin} trackId={trackId} />}
      <GenericParams {...props} />
      {hint && <div className="set-hint" data-testid="v3-plugin-hint">{hint}</div>}
    </>
  );
}

/** The minimized row's thumbnail: the same scale keyboard, 44×14, with the sung key lit. */
function AutoTuneMini({ plugin, trackId }: PanelProps) {
  const reading = useStore((s) => s.tuners[tunerKey(trackId, plugin.index)]);
  const { root, scale } = tunerScale(plugin);
  const allowed = scalePitchClasses(root, scale);
  const sung = reading && plugin.enabled ? pitchClassOf(reading.inputHz) : null;
  const W = 6, H = 14, BW = 4, BH = 8;
  return (
    <svg className="pp-at-mini" viewBox={`0 0 ${W * 7} ${H}`} width={42} height={14} aria-hidden="true" data-testid="pp-autotune-mini">
      {KEYBOARD_KEYS.map((k) => {
        const x = k.black ? k.x * W - BW / 2 : k.x * W;
        const cls = ["k", k.black ? "b" : "w", allowed.has(k.pc) ? "in" : "out", k.pc === sung ? "sung" : ""].filter(Boolean).join(" ");
        return <rect key={k.pc} className={cls} x={x + 0.25} y={0.25} width={(k.black ? BW : W) - 0.5} height={(k.black ? BH : H) - 0.5} rx={0.8} />;
      })}
    </svg>
  );
}

export const autoTunePanelDef: PanelDef = {
  shortTitle: "AutoTune",
  Mini: AutoTuneMini,
  Panel: AutoTunePanel,
  // The minimized row has room for about 16 characters: "a minor 80 ms", "chromatic 80 ms".
  summary: (plugin) => {
    const retune = param(plugin, 2)?.display?.replace(/\s+ms$/, " ms");
    return [tunerScale(plugin).label.toLowerCase(), retune ?? ""].filter(Boolean).join(" ");
  },
};
