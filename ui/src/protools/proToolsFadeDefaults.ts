import { useSettings } from "../settings/store";
import {
  PROTOOLS_FADE_CURVES,
  type ProToolsFadeCurve,
  type ProToolsFadeOptions,
} from "./proToolsFades";

export const DEFAULT_PROTOOLS_FADE_OPTIONS: ProToolsFadeOptions = {
  fadeIns: true,
  fadeOuts: true,
  crossfades: true,
  edgeLengthMs: 10,
  curveIn: "linear",
  curveOut: "linear",
};

export function currentProToolsDefaultFadeOptions(): ProToolsFadeOptions {
  const settings = useSettings.getState();
  const length = settings.get("protoolsDefaultFadeLengthMs");
  return {
    ...DEFAULT_PROTOOLS_FADE_OPTIONS,
    edgeLengthMs: typeof length === "number" ? length : DEFAULT_PROTOOLS_FADE_OPTIONS.edgeLengthMs,
    curveIn: fadeCurve(settings.get("protoolsDefaultFadeCurveIn")),
    curveOut: fadeCurve(settings.get("protoolsDefaultFadeCurveOut")),
  };
}

export function rememberProToolsDefaultFadeOptions(options: ProToolsFadeOptions): void {
  const settings = useSettings.getState();
  settings.set("protoolsDefaultFadeLengthMs", options.edgeLengthMs);
  settings.set("protoolsDefaultFadeCurveIn", options.curveIn);
  settings.set("protoolsDefaultFadeCurveOut", options.curveOut);
}

function fadeCurve(value: string | number | boolean): ProToolsFadeCurve {
  return typeof value === "string"
    ? PROTOOLS_FADE_CURVES.find((curve) => curve === value) ?? "linear"
    : "linear";
}
