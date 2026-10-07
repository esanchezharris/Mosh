import { useEffect, useState } from "react";
import { useStore } from "../store";
import type { Plugin, TunerReading } from "../types";
import {
  describeTuner, formatCents, KEYBOARD_KEYS, NOTE_NAMES, pitchClassOf, scalePitchClasses, tunerKey, tunerView,
} from "../ui/tuner";
import { choiceIndex, isChoice } from "./pluginParams";

// How long the last note stays on screen after the pitch stops. A consonant or a breath
// between two notes is a gap of a few tens of milliseconds; without this the display
// would blank on every one of them.
export const TUNER_HOLD_MS = 350;

/** The reading to draw: the current one, or the last one for a moment after it stops. */
function useHeldReading(current: TunerReading | undefined): TunerReading | undefined {
  const [held, setHeld] = useState<TunerReading | undefined>(current);
  useEffect(() => {
    if (current) { setHeld(current); return; }
    const timer = setTimeout(() => setHeld(undefined), TUNER_HOLD_MS);
    return () => clearTimeout(timer);
  }, [current]);
  return current ?? held;
}

/** The key and scale an AutoTune is set to, read from its Key and Scale menus. */
export function tunerScale(plugin: Plugin): { root: number; scale: string; label: string } {
  const key = plugin.params.find((p) => p.index === 0);
  const scale = plugin.params.find((p) => p.index === 1);
  const root = key && isChoice(key) ? choiceIndex(key.value, key.choices.length) : 0;
  const scaleName = scale && isChoice(scale) ? scale.choices[choiceIndex(scale.value, scale.choices.length)] : "Chromatic";
  const keyName = key && isChoice(key) ? key.choices[root] : NOTE_NAMES[root];
  return { root, scale: scaleName, label: scaleName === "Chromatic" ? "Chromatic" : `${keyName} ${scaleName}` };
}

// Key geometry in SVG units: seven white keys, black keys two-thirds as tall and
// centred on the boundary between two white keys.
const WHITE_W = 20, WHITE_H = 34, BLACK_W = 12, BLACK_H = 21;

/** Mosh AutoTune's live display: a one-octave keyboard with the notes of the chosen key
 *  and scale lit and the rest greyed out, the note being sung lit up, and an outline on
 *  the note it is being pulled to when that is a different one. Beside it, the sung note
 *  with its octave and how far off it is. Subscribes to its own tuner only, so the 30 Hz
 *  readings redraw this strip and nothing else. */
export function TunerReadout({ plugin, trackId }: { plugin: Plugin; trackId: string }) {
  const reading = useHeldReading(useStore((s) => s.tuners[tunerKey(trackId, plugin.index)]));
  const view = tunerView(reading);
  const { root, scale, label } = tunerScale(plugin);
  const allowed = scalePitchClasses(root, scale);
  const sung = view && reading ? pitchClassOf(reading.inputHz) : null;
  const target = view && reading ? pitchClassOf(reading.targetHz) : null;
  return (
    <div className={`tuner${view ? "" : " idle"}`} data-testid="v3-tuner" data-live={view ? "" : undefined}
      data-scale={label} role="img" aria-label={describeTuner(view, label)}
      title={`${label}. Lit keys are the notes AutoTune can pull to; the bright key is the note being sung.`}>
      <svg className="keys" viewBox={`0 0 ${WHITE_W * 7} ${WHITE_H}`} preserveAspectRatio="none" aria-hidden="true">
        {KEYBOARD_KEYS.map((k) => {
          const x = k.black ? k.x * WHITE_W - BLACK_W / 2 : k.x * WHITE_W;
          const cls = [
            "key", k.black ? "black" : "white", allowed.has(k.pc) ? "in" : "out",
            k.pc === root && scale !== "Chromatic" ? "root" : "",
            k.pc === sung ? "sung" : "", k.pc === target && target !== sung ? "target" : "",
          ].filter(Boolean).join(" ");
          return (
            <rect key={k.pc} className={cls} data-testid="v3-tuner-key" data-note={NOTE_NAMES[k.pc]}
              data-in-scale={allowed.has(k.pc) ? "" : undefined} data-sung={k.pc === sung ? "" : undefined}
              data-target={k.pc === target ? "" : undefined}
              x={x + 0.5} y={0.5} width={(k.black ? BLACK_W : WHITE_W) - 1} height={(k.black ? BLACK_H : WHITE_H) - 1} rx={1.5} />
          );
        })}
      </svg>
      <span className="read">
        <span className="heard" data-testid="v3-tuner-heard">{view ? view.heard : "–"}</span>
        <span className="cents" data-testid="v3-tuner-cents">{view ? formatCents(view.cents) : ""}</span>
      </span>
    </div>
  );
}
