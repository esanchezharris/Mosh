import { create } from "zustand";

export type V3Pane = "none" | "browser" | "plugins";
/** studio: the arrangement (where the first-run checklist, StartChecklist.tsx, sits over
 *  the workspace). booth: the recording loop view, kept in the code but not reachable from
 *  the menus while its redesign is pending. */
export type V3Posture = "studio" | "booth";
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
  /** The "Add AI tools" setup card as a dialog (AiToolsLauncher), opened from the dock. */
  aiToolsOpen: boolean;
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
  setAiToolsOpen: (open: boolean) => void;
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
  aiToolsOpen: false,
  context: null,
  setPane: (pane) => set({ pane }),
  togglePane: (pane) => set({ pane: get().pane === pane ? "none" : pane }),
  setPosture: (posture) => set({ posture, fileOpen: false }),
  setBrowserTab: (browserTab) => set({ browserTab }),
  setFileOpen: (fileOpen) => set({ fileOpen, historyOpen: false, settingsOpen: false, mpOpen: false, phoneOpen: false, trainingOpen: false, context: null }),
  setHistoryOpen: (historyOpen) => set({ historyOpen, fileOpen: false, settingsOpen: false, mpOpen: false, phoneOpen: false, trainingOpen: false, context: null }),
  setSettingsOpen: (settingsOpen) => set({ settingsOpen, fileOpen: false, historyOpen: false, mpOpen: false, phoneOpen: false, trainingOpen: false, context: null }),
  setMpOpen: (mpOpen) => set({ mpOpen, fileOpen: false, historyOpen: false, settingsOpen: false, phoneOpen: false, trainingOpen: false, context: null }),
  setPhoneOpen: (phoneOpen) => set({ phoneOpen, fileOpen: false, historyOpen: false, settingsOpen: false, mpOpen: false, trainingOpen: false, context: null }),
  setTrainingOpen: (trainingOpen) => set({ trainingOpen, fileOpen: false, historyOpen: false, settingsOpen: false, mpOpen: false, phoneOpen: false, context: null }),
  setAiToolsOpen: (aiToolsOpen) => set({ aiToolsOpen, fileOpen: false, historyOpen: false, settingsOpen: false, mpOpen: false, phoneOpen: false, trainingOpen: false, context: null }),
  setContext: (context) => set({ context, fileOpen: false, historyOpen: false }),
}));

// Dev/e2e handle, like store.ts's __moshStore: the Booth view has no menu entry while its
// redesign is pending, so its own specs enter it through here. Never set in production.
if (
  (import.meta.env.MODE === "development" || import.meta.env.MODE === "e2e" || import.meta.env.MODE === "test")
  && typeof window !== "undefined"
) {
  (window as unknown as { __moshV3?: typeof useV3 }).__moshV3 = useV3;
}
