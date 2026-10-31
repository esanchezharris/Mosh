import { create } from "zustand";

export type V3Pane = "none" | "browser" | "plugins";
/** studio: the arrangement. booth: the recording loop. start: the guided Start page
 *  (StartPage.tsx), which replaces the workspace for a first-time singer. */
export type V3Posture = "studio" | "booth" | "start";
export type V3BrowserTab = "files" | "midi" | "presets";

/** The top bar's LoRA button: the training dialog hands focus back to it on close. */
export const TRAINING_TRIGGER_ID = "v3-training-trigger";

export interface V3ContextMenu {
  x: number;
  y: number;
  clipId: string;
  trackId: string;
  /** Session seconds under the pointer when the menu opened (snapped) — for Split here. */
  time?: number;
}

interface V3ShellState {
  pane: V3Pane;
  posture: V3Posture;
  browserTab: V3BrowserTab;
  fileOpen: boolean;
  historyOpen: boolean;
  settingsOpen: boolean;
  mpOpen: boolean;
  /** The Moshi phone-pad pairing dialog (PhoneLauncher). */
  phoneOpen: boolean;
  /** LoRA training tools: sources, the way into the LoRA Lab, the library (TrainingLauncher). */
  trainingOpen: boolean;
  context: V3ContextMenu | null;
  setPane: (pane: V3Pane) => void;
  togglePane: (pane: Exclude<V3Pane, "none">) => void;
  setPosture: (posture: V3Posture) => void;
  setBrowserTab: (tab: V3BrowserTab) => void;
  setFileOpen: (open: boolean) => void;
  setHistoryOpen: (open: boolean) => void;
  setSettingsOpen: (open: boolean) => void;
  setMpOpen: (open: boolean) => void;
  setPhoneOpen: (open: boolean) => void;
  setTrainingOpen: (open: boolean) => void;
  setContext: (ctx: V3ContextMenu | null) => void;
}

export const useV3 = create<V3ShellState>((set, get) => ({
  pane: "none",
  posture: "studio",
  browserTab: "files",
  fileOpen: false,
  historyOpen: false,
  settingsOpen: false,
  mpOpen: false,
  phoneOpen: false,
  trainingOpen: false,
  context: null,
  setPane: (pane) => set({ pane }),
  togglePane: (pane) => set({ pane: get().pane === pane ? "none" : pane }),
  // The Start page owns the whole workspace, so a side pane would sit beside nothing.
  setPosture: (posture) => set(posture === "start" ? { posture, fileOpen: false, pane: "none" } : { posture, fileOpen: false }),
  setBrowserTab: (browserTab) => set({ browserTab }),
  setFileOpen: (fileOpen) => set({ fileOpen, historyOpen: false, settingsOpen: false, mpOpen: false, phoneOpen: false, trainingOpen: false, context: null }),
  setHistoryOpen: (historyOpen) => set({ historyOpen, fileOpen: false, settingsOpen: false, mpOpen: false, phoneOpen: false, trainingOpen: false, context: null }),
  setSettingsOpen: (settingsOpen) => set({ settingsOpen, fileOpen: false, historyOpen: false, mpOpen: false, phoneOpen: false, trainingOpen: false, context: null }),
  setMpOpen: (mpOpen) => set({ mpOpen, fileOpen: false, historyOpen: false, settingsOpen: false, phoneOpen: false, trainingOpen: false, context: null }),
  setPhoneOpen: (phoneOpen) => set({ phoneOpen, fileOpen: false, historyOpen: false, settingsOpen: false, mpOpen: false, trainingOpen: false, context: null }),
  setTrainingOpen: (trainingOpen) => set({ trainingOpen, fileOpen: false, historyOpen: false, settingsOpen: false, mpOpen: false, phoneOpen: false, context: null }),
  setContext: (context) => set({ context, fileOpen: false, historyOpen: false }),
}));
