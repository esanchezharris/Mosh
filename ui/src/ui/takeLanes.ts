// Derive the take-lane rows the arrangement renders for a clip. Tracktion keeps
// alternative recordings in a native take tree on ONE clip (shared position); we
// surface them as stacked lanes within the clip footprint so each take is visible
// and individually auditionable. Pure (snapshot in → view rows out) so the layout
// math stays testable without React.

import type { Clip } from "../types";

export type TakeLane = {
  index: number;       // the take handle for set_current_take {takeIndex}
  label: string;       // "Take 1".. (1-based, predictable)
  title?: string;      // engine description as a hover tooltip, when meaningful
  isCurrent: boolean;  // the playing take — highlighted, owns the keep affordance
};

// A clip with fewer than two takes has nothing to choose between → no lanes.
export function deriveTakeLanes(clip: Pick<Clip, "takes" | "currentTakeIndex" | "numTakes">): TakeLane[] {
  const takes = clip.takes;
  if (!takes || takes.length < 2) return [];
  return takes.map((t) => {
    const desc = t.description?.trim();
    return {
      index: t.index,
      label: `Take ${t.index + 1}`,
      title: desc ? desc : undefined,
      isCurrent: t.isCurrent ?? t.index === clip.currentTakeIndex,
    };
  });
}
