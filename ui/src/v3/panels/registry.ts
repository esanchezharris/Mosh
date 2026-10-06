// Which plugin types have a panel of their own. A type that is not here (the instruments,
// externals, anything new) keeps the plain list of controls (GenericParams).
import type { PanelDef } from "./types";
import { autoTunePanelDef } from "./AutoTunePanel";

export const PANELS: Partial<Record<string, PanelDef>> = {
  moshAutoTune: autoTunePanelDef,
};
