// Which plugin types have a panel of their own. A type that is not here (the instruments,
// externals, anything new) keeps the plain list of controls (GenericParams).
import type { PanelDef } from "./types";
import { autoTunePanelDef } from "./AutoTunePanel";
import { eqPanelDef } from "./EqPanel";
import { filterPanelDef } from "./FilterPanel";
import { compressorPanelDef } from "./CompressorPanel";
import { softClipPanelDef } from "./SoftClipPanel";
import { reverbPanelDef } from "./ReverbPanel";
import { delayPanelDef } from "./DelayPanel";
import { chorusPanelDef } from "./ChorusPanel";
import { phaserPanelDef } from "./PhaserPanel";
import { pitchShifterPanelDef } from "./PitchPanel";
import { ottPanelDef } from "./OttPanel";
import { xFeedbackPanelDef } from "./XFeedbackPanel";

export const PANELS: Partial<Record<string, PanelDef>> = {
  moshAutoTune: autoTunePanelDef,
  "4bandEq": eqPanelDef,
  lowpass: filterPanelDef,
  highpass: filterPanelDef,
  compressor: compressorPanelDef,
  softclip: softClipPanelDef,
  reverb: reverbPanelDef,
  delay: delayPanelDef,
  chorus: chorusPanelDef,
  phaser: phaserPanelDef,
  pitchShifter: pitchShifterPanelDef,
  moshOTT: ottPanelDef,
  moshXFeedback: xFeedbackPanelDef,
};
