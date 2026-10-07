import { useRef } from "react";
import { Range } from "../Range";
import { choiceIndex, choiceValue, inspectorParams, isChoice } from "../pluginParams";
import type { PluginParam } from "../../types";
import type { PanelProps } from "./types";
import { useDragSend } from "./useDragSend";

/** One parameter as a plain row: a menu for a parameter with named choices, otherwise a
 *  slider with the engine's read-out. A slider drag is one undo step. */
function ParamRow({ p, setParam }: { p: PluginParam; setParam: PanelProps["setParam"] }) {
  const drag = useDragSend<number>((v, gesture) => setParam(p.index, v, { gesture }));
  const pointer = useRef(false);
  if (isChoice(p)) {
    return (
      <label className="fader" data-testid="v3-plugin-param" data-param-index={p.index}>
        <span className="nm">{p.name}</span>
        <select aria-label={p.name} value={choiceIndex(p.value, p.choices.length)}
          onChange={(e) => setParam(p.index, choiceValue(Number(e.target.value), p.choices.length))}>
          {p.choices.map((c, i) => <option key={c} value={i}>{c}</option>)}
        </select>
      </label>
    );
  }
  return (
    <label className="fader" data-testid="v3-plugin-param" data-param-index={p.index}>
      <span className="nm">{p.name}</span>
      <Range min={0} max={1} step={0.001} value={drag.live ?? p.value} aria-label={p.name}
        onPointerDown={() => { pointer.current = true; drag.begin(); }}
        onPointerUp={() => { if (pointer.current) { pointer.current = false; drag.end(); } }}
        onPointerCancel={() => { if (pointer.current) { pointer.current = false; drag.end(); } }}
        onChange={(e) => { const v = Number(e.target.value); if (pointer.current) drag.update(v); else drag.nudge(v); }} />
      <span className="v">{p.display ?? p.value.toFixed(2)}</span>
    </label>
  );
}

/** The plain list of a plugin's controls (what every native row showed before panels):
 *  the fallback for a type with no panel of its own. */
export function GenericParams({ plugin, setParam }: Pick<PanelProps, "plugin" | "setParam">) {
  return <>{inspectorParams(plugin).map((p) => <ParamRow key={p.index} p={p} setParam={setParam} />)}</>;
}

/** The minimized line for a plugin with no panel: its first two controls' read-outs. */
export function genericSummary(plugin: PanelProps["plugin"]): string {
  if (plugin.external) return plugin.type || "VST3";
  const shown = plugin.params.slice(0, 2).map((p) => `${p.name} ${p.display ?? p.value.toFixed(2)}`);
  return shown.length ? shown.join(" · ") : plugin.name;
}
