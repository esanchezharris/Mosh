import type { ProToolsRuler } from "./proToolsState";

export type ProToolsRulerSpec = {
  readonly id: ProToolsRuler;
  readonly label: string;
  readonly hint: string;
};

export const PRO_TOOLS_RULER_SPECS: readonly ProToolsRulerSpec[] = [
  { id: "markers", label: "Markers", hint: "saved Memory Locations" },
  { id: "barsBeats", label: "Bars+Beats", hint: "musical bars and beats" },
  { id: "timecode", label: "Timecode", hint: "30 frames per second" },
  { id: "minutesSeconds", label: "Minutes:Seconds", hint: "elapsed minutes and seconds" },
  { id: "samples", label: "Samples", hint: "audio samples" },
] as const;
