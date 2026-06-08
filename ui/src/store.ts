import { create } from "zustand";
import { executeCommand, getSnapshot, onEvent, isNative } from "./bridge";
import type { Snapshot, Transport, MoshEvent, CommandResult } from "./types";

type State = {
  snapshot: Snapshot | null;
  connected: boolean;
  lastError: string | null;
  refresh: () => Promise<void>;
  exec: (command: string, args?: Record<string, unknown>) => Promise<CommandResult>;
  init: () => void;
};

export const useStore = create<State>((set, get) => ({
  snapshot: null,
  connected: isNative(),
  lastError: null,

  refresh: async () => {
    if (!isNative()) return;
    try {
      const snap = await getSnapshot<Snapshot>();
      set({ snapshot: snap, connected: true });
    } catch (e) {
      set({ lastError: String(e) });
    }
  },

  exec: async (command, args = {}) => {
    const res = await executeCommand<CommandResult>({ command, args });
    if (!res.ok) set({ lastError: res.error ?? `${command} failed` });
    return res;
  },

  init: () => {
    // The snapshot+events feed (02 §4). Structural changes invalidate the
    // snapshot (we refetch); transport pushes a light delta.
    onEvent("mosh_event", (raw) => {
      const ev = raw as MoshEvent;
      if (ev.type === "snapshot_invalidated") {
        void get().refresh();
      } else if (ev.type === "transport") {
        const t = ev.payload as Transport;
        set((s) =>
          s.snapshot ? { snapshot: { ...s.snapshot, transport: t } } : {}
        );
      }
    });
    void get().refresh();
  },
}));
