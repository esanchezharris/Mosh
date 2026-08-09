import type { Gesture } from "../interaction/actions";
import { classifyClipRegion } from "../interaction/region";

export type ProToolsMedia = "audio" | "midi" | "automation";
export type ProToolsTool = "zoomer" | "trimmer" | "selector" | "grabber" | "scrubber" | "pencil";
export type ProToolsIntent =
  | ProToolsTool
  | "fade-in"
  | "fade-out"
  | "marquee"
  | "velocity-trim"
  | "breakpoint";

export interface ProToolsHit {
  media: ProToolsMedia;
  x: number;
  y: number;
  width: number;
  height: number;
  edgeGrabPx: number;
  blank?: boolean;
  meta?: boolean;
  gesture?: Gesture;
  smartToolEnabled?: boolean;
  activeTool?: ProToolsTool;
}

export function classifyProToolsIntent(hit: ProToolsHit): ProToolsIntent {
  if (hit.smartToolEnabled === false) return hit.activeTool ?? "selector";

  const headerPx = hit.media === "audio"
    ? hit.height / 2
    : hit.media === "automation"
      ? hit.height / 4
      : 0;
  const region = classifyClipRegion({
    x: hit.x,
    y: hit.y,
    width: hit.width,
    height: hit.height,
    edgeGrabPx: hit.edgeGrabPx,
    headerPx,
  });

  if (hit.media === "audio") {
    if (region === "clip.edge") {
      const isTopCorner = hit.y <= Math.max(0, hit.edgeGrabPx);
      if (isTopCorner) return hit.x <= hit.width / 2 ? "fade-in" : "fade-out";
      return "trimmer";
    }
    return region === "clip.header" ? "selector" : "grabber";
  }

  if (hit.media === "midi") {
    if (region === "clip.edge") return "trimmer";
    if (hit.blank) return "marquee";
    if (hit.meta) return "velocity-trim";
    return "grabber";
  }

  if (hit.meta && hit.gesture === "click") return "breakpoint";
  return hit.y <= headerPx ? "trimmer" : "selector";
}
