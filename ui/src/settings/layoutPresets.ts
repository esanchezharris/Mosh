// DAW-template panel arrangements. Selecting a template now RESTRUCTURES the dock —
// which rails open, which windows float — to that DAW's resting shape, on top of the
// skin/theme/keymap/gesture/feel bundle the template already carries (templates.ts).
// UI-local only (honors the swappable seam). Applied ON template SWITCH, never the
// initial mount, so it never clobbers a user's later dock drags. Pure logic + an
// injected-deps applier so it unit-tests without React. Pro Tools (Edit/Mix split) and
// Logic (left inspector) are deferred — bigger structural changes.

import type { Snapshot } from "../types";

export type ZonePreset = { collapsed?: boolean; size?: number };
export type LayoutPreset = {
  left?: ZonePreset;            // the browser rail (the main per-DAW IA difference)
  drumWindow?: "open" | "close"; // FL's floating channel-rack / drum window
};

export const LAYOUT_PRESETS: Record<string, LayoutPreset> = {
  // Minimal, agent-driven default: browser tucked to a rail, nothing floating.
  mosh: { left: { collapsed: true }, drumWindow: "close" },
  // Browser-forward — the Ableton/Live resting shape.
  ableton: { left: { collapsed: false, size: 260 }, drumWindow: "close" },
  // Browser-forward + the floating channel-rack / drum window — FL's signature.
  fl: { left: { collapsed: false, size: 220 }, drumWindow: "open" },
};

export type LayoutDeps = {
  applyDock: (p: { left?: ZonePreset }) => void;
  openDrumWindow: (clipId: string) => void;
  closeDrumWindow: () => void;
  snapshot: Snapshot | null;
};

/** Apply a template's panel arrangement. Pure over injected deps (testable headless). */
export function applyLayoutArrangement(layout: string, deps: LayoutDeps): void {
  const preset = LAYOUT_PRESETS[layout] ?? LAYOUT_PRESETS.mosh;
  deps.applyDock({ left: preset.left });
  if (preset.drumWindow === "open") {
    const clip = deps.snapshot?.tracks.find((t) => t.type === "drum")?.clips.find((c) => c.type === "midi");
    if (clip) deps.openDrumWindow(clip.id);
  } else if (preset.drumWindow === "close") {
    deps.closeDrumWindow();
  }
}
