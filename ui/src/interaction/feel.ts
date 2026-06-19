// Continuous "feel" values + the pure helpers the pointer handlers read live. These
// are number settings in the schema (per-template), so a DAW preset can tune the
// click→drag threshold, double-click window, edge-grab width, snap magnetism, and
// wheel sensitivity. The defaults are the Mosh-native baseline.

export interface Feel {
  dragThreshold: number; // px of movement before a press becomes a drag
  doubleClickMs: number; // max gap between two clicks to count as a double-click
  edgeGrabPx: number; // width of the clip trim zones
  snapStrength: number; // 0 = no snap, 1 = always snap to grid
  zoomSensitivity: number; // wheel-zoom gain
  scrollSensitivity: number; // wheel-scroll gain
}

export const FEEL_DEFAULTS: Feel = {
  dragThreshold: 3,
  doubleClickMs: 300,
  edgeGrabPx: 7,
  snapStrength: 1,
  zoomSensitivity: 1,
  scrollSensitivity: 1,
};

// True once the pointer has moved strictly farther than `threshold` px from the
// press point (Euclidean). At/under the threshold it's still a click.
export function passedDragThreshold(dx: number, dy: number, threshold: number): boolean {
  return Math.hypot(dx, dy) > threshold;
}

// Two clicks `now` and `prev` ms apart count as a double-click within the window.
export function isDoubleClick(prev: number | null, now: number, windowMs: number): boolean {
  return prev !== null && now - prev <= windowMs;
}

// Magnetic snap: snap `raw` to `snapped` only when it falls inside the magnetic zone
// (strength × half a grid cell). strength 1 → always snaps; 0 → never snaps.
export function magneticSnap(raw: number, snapped: number, gridSec: number, strength: number): number {
  if (strength <= 0) return raw;
  if (strength >= 1) return snapped;
  const zone = strength * gridSec * 0.5;
  return Math.abs(raw - snapped) <= zone ? snapped : raw;
}
