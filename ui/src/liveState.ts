// Live-clone shell view-state — the same discipline as v2/shellState.ts: a THIN
// zustand slice for state the main store doesn't already hold (selection, transport,
// editingClipId, pxPerSec all stay in useStore; track selection MUST stay there for
// the multiplayer broadcast/lock-claim). Everything here is UI-local and never
// crosses the bridge.

import { create } from "zustand";

interface LiveState {
  /** The Moshi drawer inside the detail dock (SPEC §11: collapsed by default,
   *  toggled from the ONE control-bar spark button; no persistent rail). */
  moshiOpen: boolean;
  /** Live's pencil (B). A stub by design in Phase 1: the MIDI editor that would
   *  read it lands in Phase 2, so today it is only the control-bar toggle state.
   *  (SPEC §3 claims draw mode "already persists as a setting" — it doesn't;
   *  nothing in the codebase holds one, so it lives here, UI-local like `snap`.) */
  drawMode: boolean;
  /** Live 12's Automation Mode (A — the top-bar toggle): a global VIEW state for
   *  automation lanes. UI-local like drawMode (not engine state, not undoable);
   *  the lane rendering itself is a later wave (see PARITY.md).
   */
  automationView: boolean;
  /** The live shell's Settings overlay (⌘, — Live's Preferences). Mounts the
   *  shared SettingsPanel as a modal; UI-local like other overlay state. */
  settingsOpen: boolean;
  /** The clip mid inline-rename (⌘R — Live's rename idiom, resolved through the
   *  keymap in useLiveKeys). UI-local view state; the rename itself is the
   *  rename_clip command, committed by the lane overlay in Arrangement. */
  renamingClipId: string | null;
  /** The devices view (the dock's no-clip-open half) dismissed for the current
   *  track selection. Selecting another track re-shows it — see DetailDock. */
  devicesHidden: boolean;
  /** Per-track lane heights (WIDGETS §1: divider drag, 17–443pt, default 86).
   *  Absent = default. Session-scoped like the v2 shellState it mirrors. */
  laneHeights: Record<string, number>;
  /** The track mid inline-rename (⌘R from the header context menu). */
  renamingTrackId: string | null;
  /** Browser width when open (divider drag) and the remembered width while hidden
   *  (drag the divider far left = hide entirely, WIDGETS §1). null = the CSS default. */
  browserWidth: number | null;
  browserHidden: boolean;
  /** An empty-lane pointer gesture is in flight. The selection-follow sync
   *  (selectionFollow.ts) suppresses its close while this is set: the pointer-down
   *  deselect of a TIME-SELECTION drag must not close the clip view — only the
   *  click/deselect closes it (decided at pointer-up in Arrangement's onEmptyUp). */
  emptyDragInFlight: boolean;

  toggleMoshi: () => void;
  setMoshiOpen: (b: boolean) => void;
  toggleDrawMode: () => void;
  toggleAutomationView: () => void;
  toggleSettings: () => void;
  setSettingsOpen: (b: boolean) => void;
  setRenamingClip: (id: string | null) => void;
  setDevicesHidden: (b: boolean) => void;
  setLaneHeight: (trackId: string, px: number) => void;
  setRenamingTrack: (id: string | null) => void;
  setBrowserWidth: (px: number | null) => void;
  setBrowserHidden: (b: boolean) => void;
  setEmptyDragInFlight: (b: boolean) => void;
}

export const useLive = create<LiveState>((set) => ({
  moshiOpen: false,
  drawMode: false,
  renamingClipId: null,
  devicesHidden: false,
  laneHeights: {},
  renamingTrackId: null,
  browserWidth: null,
  browserHidden: false,
  emptyDragInFlight: false,
  automationView: false,
  settingsOpen: false,
  toggleMoshi: () => set((s) => ({ moshiOpen: !s.moshiOpen })),
  setMoshiOpen: (b) => set({ moshiOpen: b }),
  toggleDrawMode: () => set((s) => ({ drawMode: !s.drawMode })),
  toggleAutomationView: () => set((s) => ({ automationView: !s.automationView })),
  toggleSettings: () => set((s) => ({ settingsOpen: !s.settingsOpen })),
  setSettingsOpen: (b) => set({ settingsOpen: b }),
  setRenamingClip: (id) => set({ renamingClipId: id }),
  setDevicesHidden: (b) => set({ devicesHidden: b }),
  setLaneHeight: (trackId, px) => set((s) => ({ laneHeights: { ...s.laneHeights, [trackId]: px } })),
  setRenamingTrack: (id) => set({ renamingTrackId: id }),
  setBrowserWidth: (px) => set({ browserWidth: px }),
  setBrowserHidden: (b) => set({ browserHidden: b }),
  setEmptyDragInFlight: (b) => set({ emptyDragInFlight: b }),
}));
