// Catalogs slice — plugin/device enumeration state and its fetch actions (the
// on-demand, engine-backed catalogs: plugin list + built-ins + scan lifecycle,
// audio devices, wave/MIDI inputs, track outputs). Slice boundary = event rail +
// laziness class (RFC 004): everything here is fetched lazily on first use
// (browser open / Settings open / inspector mount), never at init(). The
// transient `scanProgress` is completed by the plugin_scan_progress event rail
// (store/events.ts). Pure view state (browserOpen etc.) stays in the core store.
import type { StateCreator } from "zustand";
import { executeCommand, isNative } from "../bridge";
import type {
  CommandResult, AvailablePlugin, BuiltinPlugin, PluginCounts,
  AudioDevices, WaveInput, MidiInput, TrackOutputs,
} from "../types";
// Type-only imports from the store module (erased at compile time — no runtime cycle).
import type { State } from "../store";

export type CatalogsSlice = {
  availablePlugins: AvailablePlugin[];
  availableBuiltins: BuiltinPlugin[];
  pluginCounts: PluginCounts | null;          // per-format catalog counts (INS-005)
  // FIT-003: count/elapsedMs are optional so the older {format,done} shape (still sent
  // by the sync VST3 rescan path and the mock) stays valid — a live async sweep adds a
  // periodic running count + elapsed time, sampled from the backend's real plugin catalog.
  scanProgress: { format: string; done: boolean; count?: number; elapsedMs?: number } | null; // transient rescan state
  audioDevices: AudioDevices | null;       // full device enumeration (on-demand, lazy)
  waveInputs: WaveInput[] | null;          // RTG-001 input choices (on-demand, lazy)
  midiInputs: MidiInput[] | null;          // CTL-001 MIDI-input choices (on-demand, lazy)
  trackOutputs: TrackOutputs | null;       // RTG-002 output destinations (on-demand, lazy)

  ensurePluginCatalog: () => void;          // lazy-load the plugin list + built-ins (shared by the modal + the v2 drawer)
  // INS-005 — plugin scan / blocklist management (all via exec; UI-local view state otherwise).
  rescanPlugins: (format?: "vst3" | "au" | "all", allowAU?: boolean) => Promise<void>;
  refreshPluginList: () => Promise<void>;
  loadAudioDevices: () => Promise<void>;   // lazy + on-demand (force re-fetch after a device change)
  loadRouting: () => Promise<void>;        // RTG-001/002 — wave inputs + track outputs
  loadMidiInputs: () => Promise<void>;     // CTL-001 — MIDI inputs for the instrument picker
};

export const createCatalogsSlice: StateCreator<State, [], [], CatalogsSlice> = (set, get) => ({
  availablePlugins: [],
  availableBuiltins: [],
  pluginCounts: null,
  scanProgress: null,
  audioDevices: null,
  waveInputs: null,
  midiInputs: null,
  trackOutputs: null,

  ensurePluginCatalog: () => {
    if (get().availablePlugins.length === 0) void get().refreshPluginList();
    // Built-in palette (instruments + effects shipped inside the engine).
    if (get().availableBuiltins.length === 0)
      void executeCommand<CommandResult<{ plugins: BuiltinPlugin[] }>>({
        command: "list_builtins",
        args: {},
      }).then((res) => {
        if (res.ok && res.data) set({ availableBuiltins: res.data.plugins });
      });
  },

  // Fetch the scanned catalog + per-format counts (INS-005). Always overwrites —
  // small list, and a rescan can grow/shrink it.
  refreshPluginList: async () => {
    const res = await executeCommand<
      CommandResult<{ plugins: AvailablePlugin[]; counts: PluginCounts }>
    >({ command: "list_plugins", args: {} });
    if (res.ok && res.data)
      set({ availablePlugins: res.data.plugins, pluginCounts: res.data.counts ?? null });
  },

  // INS-005 — re-enumerate the catalog. AU is the slow/risky path (the backend
  // runs it off the message thread); we refresh the list when the scan reports done.
  // AUD-SCAN — `allowAU` is the per-call opt-in the backend requires before it will
  // sweep AudioUnits. Without it the native handler quietly does a VST3-only pass, so
  // every AU on the machine stayed invisible with no error to explain why.
  rescanPlugins: async (format = "all", allowAU = false) => {
    set({ scanProgress: { format, done: false, count: 0, elapsedMs: 0 } });
    const res = await get().exec("rescan_plugins", { format, allowAU });
    // Inline/VST3 rescans return done immediately; AU rescans complete via the
    // 'plugin_scan_progress' event (see init()).
    const status = (res.data as { status?: string } | undefined)?.status;
    if (status !== "scanning") {
      set({ scanProgress: null });
      await get().refreshPluginList();
    }
  },

  // Full device enumeration — fetched on Settings open and re-fetched after a
  // device change (always overwrites; the list is small and selection-dependent).
  loadAudioDevices: async () => {
    if (!isNative()) return;
    const res = await executeCommand<CommandResult<AudioDevices>>({
      command: "list_audio_devices",
      args: {},
    });
    if (res.ok && res.data) set({ audioDevices: res.data });
  },

  loadRouting: async () => {
    if (!isNative()) return;
    const wi = await executeCommand<CommandResult<{ inputs: WaveInput[] }>>({
      command: "list_wave_inputs", args: {},
    });
    if (wi.ok && wi.data) set({ waveInputs: wi.data.inputs });
    const to = await executeCommand<CommandResult<TrackOutputs>>({
      command: "list_track_outputs", args: {},
    });
    if (to.ok && to.data) set({ trackOutputs: to.data });
  },

  // CTL-001 — enumerate live MIDI inputs on demand (the v2 inspector's per-instrument
  // MIDI-input picker fetches this when it mounts). Read-only, like loadRouting.
  loadMidiInputs: async () => {
    if (!isNative()) return;
    const res = await executeCommand<CommandResult<{ inputs: MidiInput[] }>>({
      command: "list_midi_inputs", args: {},
    });
    if (res.ok && res.data) set({ midiInputs: res.data.inputs });
  },
});
