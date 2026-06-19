// Pure region classification for a clip box. The Arrange clip handler feeds in the
// pointer's clip-local coordinates plus the live feel values (edge-grab width, header
// height) and gets back which sub-region was hit — no DOM reads, fully unit-testable.
//
// Priority: edge (trim) wins over header, header wins over body. That matches DAW
// muscle memory (grabbing a corner trims, it doesn't move). On a clip too narrow for
// two edge bands, the left edge wins deterministically.

import type { Region } from "./actions";

export interface ClipHit {
  x: number; // pointer X within the clip box (px)
  y: number; // pointer Y within the clip box (px)
  width: number;
  height: number;
  edgeGrabPx: number;
  headerPx: number;
}

export function classifyClipRegion(h: ClipHit): Region {
  const grab = Math.max(0, h.edgeGrabPx);
  if (h.x <= grab || h.x >= h.width - grab) return "clip.edge";
  if (h.headerPx > 0 && h.y <= h.headerPx) return "clip.header";
  return "clip.body";
}
