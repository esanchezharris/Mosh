import { create } from "zustand";
import type { TempoProposal } from "./beatImport";
import {
  EMPTY_PROGRESS, checklistOpensAtLaunch, type BeatLocal, type CheckChoice, type CheckKey, type ChecklistProgress,
  type PhoneLocal, type StartIds,
} from "./startFlow";

// What the first-run checklist remembers.
//
// Two lifetimes. The SONG part (which tracks the template made, the beat's proposal, the
// phone latch) lives for one app run and is dropped when the project changes: facts are
// re-read from the snapshot every render. The PROGRESS part (what was done, skipped or
// dismissed) is the "have I been through this" record: it is written to localStorage so
// the checklist does not come back on every launch. UI-local view state: it never crosses
// the bridge and is never an undo step.

export const PROGRESS_KEY = "mosh.startChecklist";

export interface SongMemory {
  epoch: number | null;
  ids: StartIds;
  beat: BeatLocal & { fileName: string; proposal: TempoProposal | null; bpmText: string };
  phone: PhoneLocal;
}
export const EMPTY_IDS: StartIds = { backingTrackId: null, leadTrackId: null, takesTrackId: null };
export const EMPTY_BEAT: SongMemory["beat"] = { clipId: null, confirmed: false, skipped: false, fileName: "", proposal: null, bpmText: "" };
export const EMPTY_PHONE: PhoneLocal = { everConnected: false, skipped: false };

const CHOICES: readonly CheckChoice[] = ["todo", "done", "skipped"];

/** Parse a stored progress record; anything unreadable is a fresh install. */
export function parseProgress(raw: string | null | undefined): ChecklistProgress {
  if (!raw) return EMPTY_PROGRESS;
  try {
    const v = JSON.parse(raw) as Partial<Record<keyof ChecklistProgress, unknown>> | null;
    if (!v || typeof v !== "object") return EMPTY_PROGRESS;
    const choice = (x: unknown): CheckChoice => (CHOICES.includes(x as CheckChoice) ? x as CheckChoice : "todo");
    return { beat: choice(v.beat), voice: choice(v.voice), phone: choice(v.phone), dismissed: v.dismissed === true };
  } catch {
    return EMPTY_PROGRESS;
  }
}

function loadProgress(): ChecklistProgress {
  try { return parseProgress(window.localStorage.getItem(PROGRESS_KEY)); } catch { return EMPTY_PROGRESS; }
}
function saveProgress(p: ChecklistProgress) {
  try { window.localStorage.setItem(PROGRESS_KEY, JSON.stringify(p)); } catch { /* private mode: this run only */ }
}

interface StartMemory extends SongMemory {
  progress: ChecklistProgress;
  /** The checklist panel is on screen. */
  open: boolean;
  /** The song is being made right now (the launch template, or "Set up a new song"). */
  settingUp: boolean;
  /** Why the song could not be made, in the rapper's words. */
  songError: string | null;
  /** One line under the checklist: the last thing that happened. */
  note: string | null;
  patch: (p: Partial<SongMemory>) => void;
  patchBeat: (p: Partial<SongMemory["beat"]>) => void;
  patchPhone: (p: Partial<PhoneLocal>) => void;
  /** Forget the song (the project changed). Progress is kept. */
  reset: () => void;
  setItem: (key: CheckKey, choice: CheckChoice) => void;
  /** Close the panel for good: it stays away on the next launch. */
  dismiss: () => void;
  /** File › Getting started: show it again, whatever was done before. */
  reopen: () => void;
  close: () => void;
  /** The launch decision: show it unless it was settled or dismissed before. */
  openAtLaunch: () => void;
  setNote: (note: string | null) => void;
  setSettingUp: (settingUp: boolean, songError?: string | null) => void;
}

const initialProgress = loadProgress();

export const useStartMemory = create<StartMemory>((set, get) => ({
  epoch: null, ids: EMPTY_IDS, beat: EMPTY_BEAT, phone: EMPTY_PHONE,
  progress: initialProgress,
  // Decided at launch (RecordingSetup.tsx), once the settings are known: the checklist only
  // shows by itself when "set up a song when Mosh opens" is on.
  open: false,
  settingUp: false, songError: null, note: null,
  patch: (p) => set(p),
  patchBeat: (p) => set((m) => ({ beat: { ...m.beat, ...p } })),
  patchPhone: (p) => set((m) => ({ phone: { ...m.phone, ...p } })),
  reset: () => set({ epoch: null, ids: EMPTY_IDS, beat: EMPTY_BEAT, phone: EMPTY_PHONE }),
  setItem: (key, choice) => {
    if (get().progress[key] === choice) return;
    const progress = { ...get().progress, [key]: choice };
    saveProgress(progress);
    set({ progress });
  },
  dismiss: () => {
    const progress = { ...get().progress, dismissed: true };
    saveProgress(progress);
    set({ progress, open: false });
  },
  reopen: () => {
    const progress = { ...get().progress, dismissed: false };
    saveProgress(progress);
    set({ progress, open: true });
  },
  close: () => set({ open: false }),
  openAtLaunch: () => { if (checklistOpensAtLaunch(get().progress)) set({ open: true }); },
  setNote: (note) => set({ note }),
  setSettingUp: (settingUp, songError = null) => set({ settingUp, songError }),
}));

/** Test hook: back to a fresh install (also re-reads localStorage). */
export function __resetStartMemoryForTests() {
  const progress = loadProgress();
  useStartMemory.setState({
    epoch: null, ids: EMPTY_IDS, beat: EMPTY_BEAT, phone: EMPTY_PHONE,
    progress, open: false, settingUp: false, songError: null, note: null,
  });
}
