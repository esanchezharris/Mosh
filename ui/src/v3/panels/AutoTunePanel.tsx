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

export const autoTunePanelDef: PanelDef = {
  Panel: AutoTunePanel,
  summary: (plugin) => {
    const retune = param(plugin, 2)?.display;
    return [tunerScale(plugin).label, retune ? `retune ${retune}` : ""].filter(Boolean).join(" · ");
  },
};
