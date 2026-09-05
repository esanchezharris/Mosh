import { create } from "zustand";

export type V3Pane = "none" | "browser" | "plugins";
export type V3Posture = "studio" | "booth";
export type V3BrowserTab = "files" | "midi" | "presets";

export interface V3ContextMenu {
  x: number;
  y: number;
  clipId: string;
  trackId: string;
}

interface V3ShellState {
  pane: V3Pane;
  posture: V3Posture;
  browserTab: V3BrowserTab;
  fileOpen: boolean;
  historyOpen: boolean;
  settingsOpen: boolean;
  context: V3ContextMenu | null;
  selectedClipId: string | null;
  setPane: (pane: V3Pane) => void;
  togglePane: (pane: Exclude<V3Pane, "none">) => void;
  setPosture: (posture: V3Posture) => void;
  setBrowserTab: (tab: V3BrowserTab) => void;
  setFileOpen: (open: boolean) => void;
  setHistoryOpen: (open: boolean) => void;
  setSettingsOpen: (open: boolean) => void;
  setContext: (ctx: V3ContextMenu | null) => void;
  setSelectedClipId: (id: string | null) => void;
}

export const useV3 = create<V3ShellState>((set, get) => ({
  pane: "none",
  posture: "studio",
  browserTab: "files",
  fileOpen: false,
  historyOpen: false,
  settingsOpen: false,
  context: null,
  selectedClipId: null,
  setPane: (pane) => set({ pane }),
  togglePane: (pane) => set({ pane: get().pane === pane ? "none" : pane }),
  setPosture: (posture) => set({ posture, fileOpen: false }),
  setBrowserTab: (browserTab) => set({ browserTab }),
  setFileOpen: (fileOpen) => set({ fileOpen, historyOpen: false, settingsOpen: false, context: null }),
  setHistoryOpen: (historyOpen) => set({ historyOpen, fileOpen: false, settingsOpen: false, context: null }),
  setSettingsOpen: (settingsOpen) => set({ settingsOpen, fileOpen: false, historyOpen: false, context: null }),
  setContext: (context) => set({ context, fileOpen: false, historyOpen: false }),
  setSelectedClipId: (selectedClipId) => set({ selectedClipId }),
}));
