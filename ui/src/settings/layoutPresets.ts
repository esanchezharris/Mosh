// DAW-template panel arrangements. Selecting a template now RESTRUCTURES the dock —
// which rails open, which windows float — to that DAW's resting shape, on top of the
// skin/theme/keymap/gesture/feel bundle the template already carries (templates.ts).
// UI-local only (honors the swappable seam). Applied ON template SWITCH, never the
// initial mount, so it never clobbers a user's later dock drags. Pure logic + an
// injected-deps applier so it unit-tests without React. Pro Tools and Logic map onto
// EXISTING affordances: PT tucks both rails for a focused Edit timeline (the Mixer view
// is its "Mix window"); Logic opens the left Library + the right Inspector rail.

import type { Snapshot } from "../types";
import type { View } from "../store"; // "arrange" | "mixer"

export type ZonePreset = { collapsed?: boolean; size?: number };
export type LayoutPreset = {
  left?: ZonePreset;             // the browser rail (the main per-DAW IA difference)
  right?: ZonePreset;            // the Session/Inspector rail (Logic's inspector; PT tucks it)
  drumWindow?: "open" | "close"; // FL's floating channel-rack / drum window
  mainView?: View;               // drive the existing Arrange/Mixer toggle (PT Edit window)
};

export const LAYOUT_PRESETS: Record<string, LayoutPreset> = {
  // Minimal, agent-driven default: browser tucked, the Moshi/Inspector rail kept open.
  mosh: { left: { collapsed: true }, right: { collapsed: false }, drumWindow: "close" },
  // Browser-forward — the Ableton/Live resting shape.
  ableton: { left: { collapsed: false, size: 260 }, right: { collapsed: false }, drumWindow: "close" },
  // Browser-forward + the floating channel-rack / drum window — FL's signature.
  fl: { left: { collapsed: false, size: 220 }, right: { collapsed: false }, drumWindow: "open" },
  // Pro Tools — the Edit window: both rails out of the way → a focused timeline. The
  // existing Mixer view is PT's "Mix window," reached by the existing toggle.
  protools: { left: { collapsed: true }, right: { collapsed: true }, drumWindow: "close", mainView: "arrange" },
  // Logic — Library (left) + Inspector (right, our Session rail), arrange in the middle.
  logic: { left: { collapsed: false, size: 230 }, right: { collapsed: false, size: 300 }, drumWindow: "close", mainView: "arrange" },
};

export type LayoutDeps = {
  applyDock: (p: { left?: ZonePreset; right?: ZonePreset }) => void;
  openDrumWindow: (clipId: string) => void;
  closeDrumWindow: () => void;
  setMainView: (v: View) => void;
  snapshot: Snapshot | null;
};

/** Apply a template's panel arrangement. Pure over injected deps (testable headless). */
export function applyLayoutArrangement(layout: string, deps: LayoutDeps): void {
  const preset = LAYOUT_PRESETS[layout] ?? LAYOUT_PRESETS.mosh;
  deps.applyDock({ left: preset.left, right: preset.right });
  if (preset.mainView) deps.setMainView(preset.mainView);
  if (preset.drumWindow === "open") {
    const clip = deps.snapshot?.tracks.find((t) => t.type === "drum")?.clips.find((c) => c.type === "midi");
    if (clip) deps.openDrumWindow(clip.id);
  } else if (preset.drumWindow === "close") {
    deps.closeDrumWindow();
  }
}
