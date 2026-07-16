// Open Lanes (v3) view-state — a THIN slice for state the main store doesn't hold, mirroring
// the discipline of v2/shellState.ts. Track SELECTION stays in useStore (it fires the
// multiplayer broadcast/lock claim) — never mirror it here. This slice owns only genuinely-new
// v3 view concerns: which lane is focused (accordion), the zoom window, the Shift-fader mode,
// and the left/right dock openness.

import { create } from "zustand";

export type ZoomBars = 8 | 16 | "full";
export type LeftDock = "samples" | "files" | null;
export type RightDock = "mixer" | "inspect" | null;

interface OpenLanesState {
  focusIdx: number;          // which lane is expanded in single-focus (accordion) mode
  zoom: ZoomBars;            // the visible bar-window (8 / 16 / full)
  viewStartSec: number;      // left edge of the horizontal lane window (UI-local seconds)
  fadersEngaged: boolean;    // Shift-hold (or locked) → every lane shows a volume fader
  fadersLocked: boolean;     // settings toggle: make fader mode sticky
  leftDock: LeftDock;        // open left panel (SAMPLES / FILES) or none
  rightDock: RightDock;      // open right panel (MIXER / INSPECT) or none

  setFocusIdx: (i: number) => void;
  setZoom: (z: ZoomBars) => void;
  setViewStartSec: (seconds: number) => void;
  setFadersEngaged: (b: boolean) => void;
  toggleFadersLocked: () => void;
  setLeftDock: (d: LeftDock) => void;
  setRightDock: (d: RightDock) => void;
}

export const useOpenLanes = create<OpenLanesState>((set) => ({
  focusIdx: 0,
  zoom: 16,
  viewStartSec: 0,
  fadersEngaged: false,
  fadersLocked: false,
  leftDock: null,
  rightDock: null,

  setFocusIdx: (i) => set({ focusIdx: i }),
  setZoom: (z) => set({ zoom: z }),
  setViewStartSec: (seconds) => set({ viewStartSec: Number.isFinite(seconds) ? Math.max(0, seconds) : 0 }),
  setFadersEngaged: (b) => set({ fadersEngaged: b }),
  toggleFadersLocked: () => set((s) => ({ fadersLocked: !s.fadersLocked, fadersEngaged: !s.fadersLocked })),
  setLeftDock: (d) => set((s) => ({ leftDock: s.leftDock === d ? null : d })),
  setRightDock: (d) => set((s) => ({ rightDock: s.rightDock === d ? null : d })),
}));
