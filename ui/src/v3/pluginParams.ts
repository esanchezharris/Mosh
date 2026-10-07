import type { Plugin, PluginParam } from "../types";

// How a built-in plugin's controls appear in the inspector.
//
// The engine describes each parameter: a stepped one names its choices (`choices`), and
// every one reads back in its own units (`display`). So a choice is a MENU and a
// continuous value is a slider with a real read-out; nothing here knows what a "key" is.
// What IS decided here is which controls a row shows and in what order.

/** Plugins whose row shows every control, in this order (parameter indices). The engine
 *  only ever appends parameters, so the order a person expects is kept here. */
const FULL_LAYOUTS: Record<string, number[]> = {
  // Key, Scale, Retune speed, Glide, Amount, Range, Mix, Output, Look-ahead
  moshAutoTune: [0, 1, 2, 7, 3, 4, 5, 6, 8],
};

/** True when the row shows every control with unit read-outs (it needs a wider value column). */
export function showsEveryParam(plugin: Plugin): boolean {
  return plugin.type in FULL_LAYOUTS || !!plugin.preset;
}

/** The parameters a native plugin's inspector row shows, in display order. */
export function inspectorParams(plugin: Plugin): PluginParam[] {
  const layout = FULL_LAYOUTS[plugin.type];
  if (layout) {
    const byIndex = new Map(plugin.params.map((p) => [p.index, p]));
    const ordered = layout.map((i) => byIndex.get(i)).filter((p): p is PluginParam => p !== undefined);
    // A parameter the layout does not know yet (added to the engine later) still shows, last.
    return [...ordered, ...plugin.params.filter((p) => !layout.includes(p.index))];
  }
  // A preset's stages show EVERY parameter: the chain is only inspectable if the controls
  // it set are on screen (the compressor's output trim is its fifth).
  return plugin.preset ? plugin.params : plugin.params.slice(0, 4);
}

/** A parameter the engine offers as named choices. */
export function isChoice(p: PluginParam): p is PluginParam & { choices: string[] } {
  return Array.isArray(p.choices) && p.choices.length >= 2;
}

/** Which choice a stepped parameter is on: the nearest one to its 0-1 value. */
export function choiceIndex(value: number, count: number): number {
  if (count < 2) return 0;
  const i = Math.round(Math.min(1, Math.max(0, Number.isFinite(value) ? value : 0)) * (count - 1));
  return Math.min(count - 1, Math.max(0, i));
}

/** The 0-1 value that selects choice `index` of `count` (what set_plugin_param takes). */
export function choiceValue(index: number, count: number): number {
  if (count < 2) return 0;
  return Math.min(count - 1, Math.max(0, Math.round(index))) / (count - 1);
}

/** A note shown under a plugin's controls when a setting makes another one do nothing.
 *  AutoTune on the chromatic scale allows every note, so its Key changes nothing; a
 *  person moving Key and hearing no difference should be told why. */
export function pluginHint(plugin: Plugin): string | null {
  if (plugin.type !== "moshAutoTune") return null;
  const scale = plugin.params.find((p) => p.index === 1);
  if (!scale || !isChoice(scale)) return null;
  const chosen = scale.choices[choiceIndex(scale.value, scale.choices.length)];
  return chosen === "Chromatic"
    ? "Chromatic allows every note, so Key has no effect. Choose Major or Minor to keep the voice in a key."
    : null;
}
