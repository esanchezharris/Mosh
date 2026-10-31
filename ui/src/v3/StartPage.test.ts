import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../bridge", async () => ({
  ...(await vi.importActual<typeof import("../bridge")>("../bridge")),
  microphonePermissionStatus: vi.fn(),
  requestMicrophonePermission: vi.fn(),
  pickFiles: vi.fn(),
}));

import { microphonePermissionStatus, pickFiles, requestMicrophonePermission } from "../bridge";
import { useFileDrop } from "../hooks/useFileDrop";
import { useSettings } from "../settings/store";
import { useStore } from "../store";
import type { CommandResult, Plugin, Snapshot, Track } from "../types";
import { MIC_COPY } from "./micCheck";
import { useV3 } from "./shellState";
import { StartPage, useStartMemory } from "./StartPage";

// The Start page against an in-test FAKE ENGINE: a plain object whose exec mutates it and
// answers in the native shapes, and whose refresh writes a fresh snapshot into useStore.
// Every assertion reads either the command log or what the page renders.

type Call = { command: string; args: Record<string, unknown> };

const CLEAN_FILE = "/presets/track-chain/mosh-clean-lead-v0.json";
const TUNED_FILE = "/presets/track-chain/mosh-tuned-lead-v0.json";
const BEAT_SECONDS = 10.9;

const stage = (presetId: string, type: string, stageNo: number): Plugin => ({
  index: 0, name: type, type, enabled: true, external: false, isInstrument: false, params: [],
  preset: { id: presetId, name: presetId, revision: 1, stage: stageNo },
});
const presetStages = (file: string): Plugin[] => file === TUNED_FILE
  ? [stage("mosh.tuned-lead", "moshAutoTune", 0), stage("mosh.tuned-lead", "eq", 1), stage("mosh.tuned-lead", "compressor", 2)]
  : [stage("mosh.clean-lead", "highpass", 0), stage("mosh.clean-lead", "compressor", 1)];

interface EngineOpts {
  output?: string;
  tracks?: Track[];
  blockReason?: string;
  /** Return an error string to refuse a call. */
  refuse?: (call: Call) => string | null;
}

interface FakeState {
  tracks: Track[];
  tempo: number;
  metronome: boolean;
  transport: { playing: boolean; recording: boolean; position: number; looping: boolean; loopStart: number; loopEnd: number };
  loop: { engaged: boolean; leadTrackId: string | null; takesTrackId: string | null };
  key: { tonic: string; mode: string } | null;
  blockReason: string;
}

function makeEngine(opts: EngineOpts = {}) {
  const calls: Call[] = [];
  const state: FakeState = {
    tracks: opts.tracks ?? [],
    tempo: 120,
    metronome: false,
    transport: { playing: false, recording: false, position: 0, looping: false, loopStart: 0, loopEnd: 0 },
    loop: { engaged: false, leadTrackId: null, takesTrackId: null },
    key: null,
    blockReason: opts.blockReason ?? "",
  };
  let nextId = 10;
  let nextClip = 1;
  const undo: string[] = [];
  let batch: { saved: boolean } | null = null;
  const save = () => {
    if (batch) { if (batch.saved) return; batch.saved = true; }
    undo.push(JSON.stringify(state));
  };
  const find = (id: unknown) => state.tracks.find((t) => t.id === id);
  const reindex = (t: Track) => (t.plugins ?? []).forEach((p, i) => { p.index = i; });
  const newTrack = (name: string, over: Partial<Track> = {}): Track => ({
    id: String(nextId++), index: state.tracks.length, name, type: "audio", volumeDb: 0, pan: 0,
    mute: false, solo: false, armed: false, monitor: "automatic", clips: [], plugins: [], ...over,
  }) as unknown as Track;
  const ok = (command: string, data?: unknown): CommandResult => ({ ok: true, command, ...(data === undefined ? {} : { data }) });
  const err = (command: string, error: string): CommandResult => ({ ok: false, command, error });

  const handle = (command: string, a: Record<string, unknown>): CommandResult => {
    switch (command) {
      case "new_project": {
        state.tracks = [];
        state.loop = { engaged: false, leadTrackId: null, takesTrackId: null };
        undo.length = 0;
        const backing = newTrack("Backing");
        const vocal = newTrack("Vocal", { armed: true });
        state.tracks.push(backing, vocal);
        return ok(command, { template: "vocal", backingTrackId: backing.id, vocalTrackId: vocal.id });
      }
      case "create_track": {
        save();
        const t = newTrack(String(a.name ?? "Track"));
        state.tracks.push(t);
        return ok(command, { trackId: t.id });
      }
      case "loop_setup": {
        const lead = find(a.trackId);
        if (!lead) return err(command, "track not found");
        save();
        const takes = newTrack(`${lead.name} · Takes`, { armed: true });
        state.tracks.splice(state.tracks.indexOf(lead) + 1, 0, takes);
        state.tracks.forEach((t, i) => { t.index = i; });
        lead.armed = false;
        state.loop = { engaged: true, leadTrackId: lead.id, takesTrackId: takes.id };
        return ok(command, { leadTrackId: lead.id, takesTrackId: takes.id, armed: true });
      }
      case "list_presets":
        return ok(command, { presets: [
          { plugin: "track-chain", name: "mosh-clean-lead-v0", file: CLEAN_FILE, source: "bundled" },
          { plugin: "track-chain", name: "mosh-tuned-lead-v0", file: TUNED_FILE, source: "bundled" },
        ] });
      case "apply_track_preset": {
        const t = find(a.trackId);
        if (!t) return err(command, "no track");
        if (a.file !== CLEAN_FILE && a.file !== TUNED_FILE) return err(command, "preset file not found");
        save();
        const fresh = presetStages(String(a.file));
        const id = fresh[0]!.preset!.id;
        const rack = t.plugins ?? [];
        const owned = rack.filter((p) => p.preset?.id === id);
        const at = owned.length > 0 ? rack.indexOf(owned[0]!) : rack.length;
        const kept = rack.filter((p) => p.preset?.id !== id);
        t.plugins = [...kept.slice(0, at), ...fresh, ...kept.slice(at)];
        reindex(t);
        return ok(command, { trackId: t.id, presetId: id, stages: t.plugins.filter((p) => p.preset?.id === id).map((p) => ({ index: p.index })) });
      }
      case "remove_plugin": {
        const t = find(a.trackId);
        const idx = (t?.plugins ?? []).findIndex((p) => p.index === a.index);
        if (!t || idx < 0) return err(command, "plugin not found");
        save();
        t.plugins!.splice(idx, 1);
        reindex(t);
        return ok(command);
      }
      case "set_plugin_param": {
        const p = find(a.trackId)?.plugins?.find((x) => x.index === a.index);
        if (!p) return err(command, "plugin not found");
        save();
        (p as Plugin & { values?: Record<number, unknown> }).values = { ...(p as { values?: Record<number, unknown> }).values, [Number(a.paramIndex)]: a.value };
        return ok(command);
      }
      case "set_input_monitor": {
        const t = find(a.trackId);
        if (!t) return err(command, "no track");
        t.monitor = a.mode as Track["monitor"];
        return ok(command, { applied: true });
      }
      case "arm_track": {
        const t = find(a.trackId);
        if (!t) return err(command, "no track");
        t.armed = !!a.armed;
        return ok(command, { applied: true });
      }
      case "import_clip":
      case "import_clip_data": {
        // The native fallback: a trackId that does not resolve lands on the FIRST audio track.
        const t = find(a.trackId) ?? state.tracks.find((x) => x.type === "audio");
        if (!t) return err(command, "no audio track");
        save();
        const name = command === "import_clip" ? String(a.file).split("/").pop()! : String(a.name);
        const start = Number(command === "import_clip" ? a.startSeconds : a.start) || 0;
        const clip = { id: `clip${nextClip++}`, name, type: "wave", start, length: BEAT_SECONDS, offset: 0 };
        t.clips = [...t.clips, clip] as Track["clips"];
        return ok(command, { clipId: clip.id, trackId: t.id });
      }
      case "detect_clip_bpm":
        return ok(command, { bpm: 88, confidence: 0.8 });
      case "set_tempo":
        save();
        state.tempo = Number(a.bpm);
        return ok(command, { tempo: state.tempo });
      case "set_transport":
        if (typeof a.loop === "boolean") state.transport.looping = a.loop;
        if (typeof a.loopStart === "number") state.transport.loopStart = a.loopStart;
        if (typeof a.loopEnd === "number") state.transport.loopEnd = a.loopEnd;
        if (a.action === "play") state.transport.playing = true;
        if (a.action === "stop") state.transport.playing = false;
        return ok(command, { playing: state.transport.playing });
      case "set_metronome":
        state.metronome = !!a.enabled;
        return ok(command);
      case "set_key":
        state.key = { tonic: String(a.tonic), mode: String(a.mode) };
        return ok(command);
      case "remove_clip": {
        const t = state.tracks.find((x) => x.clips.some((c) => c.id === a.clipId));
        if (!t) return err(command, "no clip");
        save();
        t.clips = t.clips.filter((c) => c.id !== a.clipId);
        return ok(command);
      }
      case "batch_begin":
        if (batch) return err(command, "a batch is already open");
        batch = { saved: false };
        return ok(command);
      case "batch_end":
        batch = null;
        return ok(command);
      case "undo": {
        const prev = undo.pop();
        if (!prev) return err(command, "nothing to undo");
        Object.assign(state, JSON.parse(prev) as FakeState);
        return ok(command);
      }
      default:
        return err(command, `fake engine: unhandled ${command}`);
    }
  };

  const snapshot = (): Snapshot => ({
    schemaVersion: 1,
    session: { sampleRate: 48000, tempo: state.tempo, length: 16, editFile: "", metronome: state.metronome },
    tracks: JSON.parse(JSON.stringify(state.tracks)) as Track[],
    transport: { ...state.transport },
    loop: {
      ...state.loop, phase: "idle",
      transport: { recording: false, playing: false, positionSec: 0 },
      listening: { qn: 0, bar: 1, entryQn: 0, leadQn: 0 },
      currentId: null, lastId: null, reviewId: null, auditionedId: null,
      contributions: [], phoneConnected: false, phoneSeenMs: 0, blockReason: state.blockReason,
    },
    audio: { outputDevice: opts.output ?? "External Headphones", inputDevice: "MacBook Pro Microphone" },
  }) as unknown as Snapshot;

  const exec = vi.fn(async (command: string, args: Record<string, unknown> = {}): Promise<CommandResult> => {
    const call = { command, args };
    calls.push(call);
    const refused = opts.refuse?.(call);
    if (refused) return err(command, refused);
    return handle(command, args);
  });
  const refresh = vi.fn(async () => { useStore.setState({ snapshot: snapshot() }); });
  const byName = (name: string) => state.tracks.find((t) => t.name === name);
  return { state, calls, exec, refresh, snapshot, byName };
}
type Engine = ReturnType<typeof makeEngine>;

// The page takes its snapshot as a prop, like AppV3 gives it; the host re-renders on every
// refresh and mounts the app's drop hook beside it.
function Host() {
  const snap = useStore((s) => s.snapshot);
  useFileDrop();
  return snap ? React.createElement(StartPage, { snapshot: snap }) : null;
}

const initialStore = useStore.getState();

describe("v3 Start page (StartPage.tsx) against a fake engine", () => {
  let host: HTMLDivElement;
  let root: Root;
  let engine: Engine;

  const el = <T extends HTMLElement = HTMLElement>(id: string) => host.querySelector<T>(`[data-testid="${id}"]`);
  const must = <T extends HTMLElement = HTMLElement>(id: string): T => {
    const found = el<T>(id);
    if (!found) throw new Error(`missing [data-testid="${id}"] on step ${el("v3-start")?.dataset.step}`);
    return found;
  };
  const stepOf = () => el("v3-start")?.dataset.step;
  const settle = async () => {
    for (let i = 0; i < 6; i += 1) {
      await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
    }
  };
  const click = async (id: string) => {
    await act(async () => { must(id).click(); });
    await settle();
  };
  const choose = async (id: string, value: string) => {
    await act(async () => {
      const select = must<HTMLSelectElement>(id);
      select.value = value;
      select.dispatchEvent(new Event("change", { bubbles: true }));
    });
    await settle();
  };
  const commands = (from = 0) => engine.calls.slice(from).map((c) => c.command);
  const argsOf = (command: string, from = 0) => engine.calls.slice(from).filter((c) => c.command === command).map((c) => c.args);

  async function boot(opts: EngineOpts = {}) {
    engine = makeEngine(opts);
    useStore.setState({
      snapshot: engine.snapshot(),
      exec: engine.exec as unknown as typeof initialStore.exec,
      refresh: engine.refresh,
      ensurePeaks: vi.fn(),
      refreshRemote: vi.fn(async () => {}),
      startRemotePairing: vi.fn(async () => {}),
      remoteStatus: null,
      projectEpoch: 0,
      projectTransitioning: false,
      lastError: null,
      peaks: {},
    });
    await act(async () => { root.render(React.createElement(Host)); });
    await settle();
    return engine;
  }

  async function newSong() {
    await click("v3-start-new");
    expect(stepOf()).toBe("beat");
    const lead = engine.byName("Vocal")!;
    const takes = engine.byName("Vocal · Takes")!;
    const backing = engine.byName("Backing")!;
    return { lead, takes, backing };
  }

  async function toVoice() {
    const song = await newSong();
    await click("v3-start-skip-beat");
    expect(stepOf()).toBe("voice");
    return song;
  }

  beforeEach(() => {
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    vi.mocked(microphonePermissionStatus).mockReset().mockResolvedValue({ status: "granted" });
    vi.mocked(requestMicrophonePermission).mockReset().mockResolvedValue({ status: "granted" });
    vi.mocked(pickFiles).mockReset().mockResolvedValue({ ok: false, files: [] });
    useStartMemory.getState().reset();
    useStartMemory.setState({ visited: false });
    useSettings.getState().reset();
    useV3.setState({ posture: "start" });
    // jsdom has no 2D canvas; MoshiFace already tolerates a null context, this just keeps
    // jsdom's "not implemented" noise out of the log.
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(null);
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
  });

  afterEach(() => {
    act(() => root.unmount());
    host.remove();
    useStore.setState(initialStore, true);
    useV3.setState({ posture: "studio" });
    useSettings.getState().reset();
    vi.restoreAllMocks();
  });

  // (1)
  it("Welcome on an empty session offers a new song and nothing to continue", async () => {
    await boot();
    expect(stepOf()).toBe("welcome");
    expect(el("v3-start-new")).not.toBeNull();
    expect(el<HTMLButtonElement>("v3-start-new")!.disabled).toBe(false);
    expect(el("v3-start-continue")).toBeNull();
    expect(engine.calls, "arriving must not mutate the session").toEqual([]);
  });

  it("Welcome with tracks offers Continue too", async () => {
    await boot({ tracks: [{ id: "1", index: 0, name: "Beat", type: "audio", clips: [], plugins: [] } as unknown as Track] });
    expect(stepOf()).toBe("welcome");
    expect(el("v3-start-new")).not.toBeNull();
    expect(el("v3-start-continue")).not.toBeNull();
    expect(el("v3-start-continue-summary")!.textContent).toContain("1 tracks");
  });

  // (2)
  it("a new song on headphones: new_project → loop_setup on Vocal → list_presets → Clean on Lead then Takes", async () => {
    await boot();
    const { lead, takes } = await newSong();
    expect(commands()).toEqual(["new_project", "loop_setup", "list_presets", "apply_track_preset", "apply_track_preset"]);
    expect(argsOf("new_project")).toEqual([{ template: "vocal" }]);
    expect(argsOf("loop_setup")).toEqual([{ trackId: lead.id }]);
    expect(argsOf("list_presets")).toEqual([{ plugin: "track-chain" }]);
    expect(argsOf("apply_track_preset")).toEqual([{ trackId: lead.id, file: CLEAN_FILE }, { trackId: takes.id, file: CLEAN_FILE }]);
    expect(useStartMemory.getState().ids).toEqual({ backingTrackId: engine.byName("Backing")!.id, leadTrackId: lead.id, takesTrackId: takes.id });
    expect(el("v3-start-pip-beat")!.dataset.state).toBe("current");
  });

  // (3)
  it("on laptop speakers: Hear myself goes off on Takes BEFORE the chain is looked up", async () => {
    await boot({ output: "MacBook Pro Speakers" });
    const { takes } = await newSong();
    expect(commands()).toEqual(["new_project", "loop_setup", "set_input_monitor", "list_presets", "apply_track_preset", "apply_track_preset"]);
    expect(argsOf("set_input_monitor")).toEqual([{ trackId: takes.id, mode: "off" }]);
    expect(engine.byName("Vocal · Takes")!.monitor).toBe("off");
    expect(el("v3-start-note")!.textContent).toContain("Hear myself is off");
  });

  // (4)
  it("an undecided microphone is asked about BEFORE new_project", async () => {
    vi.mocked(microphonePermissionStatus).mockResolvedValue({ status: "not-determined" });
    vi.mocked(requestMicrophonePermission).mockImplementation(async () => {
      engine.calls.push({ command: "@request_microphone_permission", args: {} });
      return { status: "granted" };
    });
    await boot();
    await newSong();
    expect(requestMicrophonePermission).toHaveBeenCalledTimes(1);
    expect(commands().slice(0, 2)).toEqual(["@request_microphone_permission", "new_project"]);
  });

  // (5)
  it("Choose a file… imports to Backing at 0, detects 88, and Use 88 BPM sets tempo then the loop", async () => {
    await boot();
    const { backing } = await newSong();
    vi.mocked(pickFiles).mockResolvedValue({ ok: true, files: ["/Users/me/beats/late night.wav"] });
    const mark = engine.calls.length;
    await click("v3-start-choose");
    expect(pickFiles).toHaveBeenCalledWith(expect.objectContaining({ title: "Choose a beat" }));
    expect(commands(mark)).toEqual(["import_clip", "detect_clip_bpm"]);
    expect(argsOf("import_clip", mark)).toEqual([{ file: "/Users/me/beats/late night.wav", trackId: backing.id, startSeconds: 0 }]);
    const clipId = engine.byName("Backing")!.clips[0]!.id;
    expect(argsOf("detect_clip_bpm", mark)).toEqual([{ clipId }]);
    expect(must("v3-start-tempo-line").textContent).toBe("Sounds like 88 BPM.");
    expect(must<HTMLInputElement>("v3-start-bpm").value).toBe("88");

    const confirm = engine.calls.length;
    await click("v3-start-bpm-confirm");
    expect(engine.calls.slice(confirm, confirm + 2)).toEqual([
      { command: "set_tempo", args: { bpm: 88 } },
      { command: "set_transport", args: { loop: true, loopStart: 0, loopEnd: BEAT_SECONDS } },
    ]);
    expect(engine.state.tempo).toBe(88);
    expect(must("v3-start-tempo-line").textContent).toBe("Your beat is at 88 BPM.");
    expect(el("v3-start-beat-next")).not.toBeNull();
  });

  // (6)
  it("a beat the engine put on another track is undone and reported, never left on the vocal", async () => {
    await boot();
    const { backing } = await newSong();
    // Backing vanishes engine-side (another client, an undo) before the page refreshes: the
    // engine falls back to the first audio track, which is now the Vocal.
    engine.state.tracks = engine.state.tracks.filter((t) => t.id !== backing.id);
    vi.mocked(pickFiles).mockResolvedValue({ ok: true, files: ["/Users/me/beats/late night.wav"] });
    const mark = engine.calls.length;
    await click("v3-start-choose");
    expect(commands(mark)).toEqual(["import_clip", "undo"]);
    expect(argsOf("import_clip", mark)[0]).toMatchObject({ trackId: backing.id });
    expect(commands(mark)).not.toContain("detect_clip_bpm");
    expect(engine.byName("Vocal")!.clips).toEqual([]);
    expect(must("v3-start-note").textContent).toContain("Backing");
    expect(el("v3-start-tempo")).toBeNull();
  });

  // (7)
  describe("drops on the Beat step", () => {
    const drop = async (file: File) => {
      await act(async () => {
        const ev = new Event("drop", { bubbles: true, cancelable: true });
        Object.defineProperty(ev, "dataTransfer", { value: { files: [file], types: ["Files"] } });
        window.dispatchEvent(ev);
      });
      await settle();
    };
    const fileOf = (text: string, name: string, type: string) => {
      const f = new File([text], name, { type });
      if (typeof (f as { arrayBuffer?: unknown }).arrayBuffer !== "function") {
        Object.defineProperty(f, "arrayBuffer", { value: async () => new TextEncoder().encode(text).buffer });
      }
      return f;
    };

    it("refuses a file that isn't audio with a plain sentence, importing nothing", async () => {
      await boot();
      await newSong();
      const mark = engine.calls.length;
      await drop(fileOf("hello", "lyrics.txt", "text/plain"));
      expect(must("v3-start-note").textContent).toContain("isn't an audio file");
      expect(commands(mark)).toEqual([]);
    });

    it("imports a dropped .wav onto Backing at 0 (not the selected track at the playhead)", async () => {
      await boot();
      const { backing, lead } = await newSong();
      useStore.setState({ selectedTrackId: lead.id });
      const mark = engine.calls.length;
      await drop(fileOf("RIFF", "beat.wav", "audio/wav"));
      expect(commands(mark)).toEqual(["import_clip_data", "detect_clip_bpm"]);
      expect(argsOf("import_clip_data", mark)).toEqual([{ name: "beat.wav", dataBase64: btoa("RIFF"), trackId: backing.id, start: 0 }]);
      expect(engine.byName("Backing")!.clips).toHaveLength(1);
      expect(engine.byName("Vocal")!.clips).toHaveLength(0);
    });
  });

  // (8)
  describe("the Voice step's ready gate", () => {
    it("Clean on both lanes, Takes armed, mic granted: I'm ready is enabled", async () => {
      await boot();
      await toVoice();
      expect(must("v3-start-clean").getAttribute("aria-checked")).toBe("true");
      const ready = must<HTMLButtonElement>("v3-start-ready");
      expect(ready.textContent).toBe("I'm ready");
      expect(ready.disabled).toBe(false);
    });

    it("a denied microphone disables it, says why, and shows the denied copy", async () => {
      vi.mocked(microphonePermissionStatus).mockResolvedValue({ status: "denied" });
      await boot();
      await toVoice();
      const ready = must<HTMLButtonElement>("v3-start-ready");
      expect(ready.disabled).toBe(true);
      expect(ready.textContent).toBe("Fix the microphone first");
      expect(must("v3-start-mic").textContent).toContain(MIC_COPY.denied);
      expect(el("v3-start-mic-retry")).not.toBeNull();
    });

    it("a loop blockReason reads as recording being unavailable", async () => {
      await boot({ blockReason: "No audio device — recording is unavailable on this Mac" });
      await toVoice();
      const ready = must<HTMLButtonElement>("v3-start-ready");
      expect(ready.disabled).toBe(true);
      expect(ready.textContent).toBe("Recording is unavailable on this Mac");
    });
  });

  // (9)
  describe("Tuned Lead", () => {
    it("with A Minor: one batch that clears each lane, applies Tuned, sets Key then Scale on the AutoTune, then set_key", async () => {
      await boot();
      const { lead, takes } = await toVoice();
      // A plain utility ahead of the Takes chain, so the AutoTune lands at a NON-zero index there.
      await act(async () => {
        const t = engine.state.tracks.find((x) => x.id === takes.id)!;
        t.plugins = [{ index: 0, name: "Gate", type: "gate", enabled: true, external: false, isInstrument: false, params: [] }, ...(t.plugins ?? [])];
        t.plugins.forEach((p, i) => { p.index = i; });
        await engine.refresh();
      });
      await click("v3-start-tuned");
      expect(el("v3-start-key")).not.toBeNull();
      await choose("v3-start-key-root", "A");
      await choose("v3-start-key-scale", "Minor");
      const mark = engine.calls.length;
      await click("v3-start-tuned-apply");

      const leadTuner = engine.byName("Vocal")!.plugins!.find((p) => p.type === "moshAutoTune")!;
      const takesTuner = engine.byName("Vocal · Takes")!.plugins!.find((p) => p.type === "moshAutoTune")!;
      expect(leadTuner.index).toBe(0);
      expect(takesTuner.index).toBe(1);
      expect(engine.calls.slice(mark).filter((c) => c.command !== "list_presets")).toEqual([
        { command: "batch_begin", args: { name: "Tuned Lead" } },
        { command: "remove_plugin", args: { trackId: lead.id, index: 1 } },
        { command: "remove_plugin", args: { trackId: lead.id, index: 0 } },
        { command: "apply_track_preset", args: { trackId: lead.id, file: TUNED_FILE } },
        { command: "set_plugin_param", args: { trackId: lead.id, index: leadTuner.index, paramIndex: 0, value: 9 / 11 } },
        { command: "set_plugin_param", args: { trackId: lead.id, index: leadTuner.index, paramIndex: 1, value: 1 } },
        { command: "remove_plugin", args: { trackId: takes.id, index: 2 } },
        { command: "remove_plugin", args: { trackId: takes.id, index: 1 } },
        { command: "apply_track_preset", args: { trackId: takes.id, file: TUNED_FILE } },
        { command: "set_plugin_param", args: { trackId: takes.id, index: takesTuner.index, paramIndex: 0, value: 9 / 11 } },
        { command: "set_plugin_param", args: { trackId: takes.id, index: takesTuner.index, paramIndex: 1, value: 1 } },
        { command: "batch_end", args: {} },
        { command: "set_key", args: { tonic: "A", mode: "minor" } },
      ]);
      expect(engine.byName("Vocal · Takes")!.plugins![0]!.type, "the producer's own Gate survives").toBe("gate");
      expect(must("v3-start-tuned").getAttribute("aria-checked")).toBe("true");
      expect(must("v3-start-ready").textContent).toBe("I'm ready");
    });

    it("with 'keep it loose': no key is written anywhere", async () => {
      await boot();
      await toVoice();
      await click("v3-start-tuned");
      expect(must<HTMLSelectElement>("v3-start-key-root").value).toBe("loose");
      const mark = engine.calls.length;
      await click("v3-start-tuned-apply");
      const sent = commands(mark);
      expect(sent).toContain("batch_begin");
      expect(sent).toContain("batch_end");
      expect(argsOf("apply_track_preset", mark).map((a) => a.file)).toEqual([TUNED_FILE, TUNED_FILE]);
      expect(sent).not.toContain("set_plugin_param");
      expect(sent).not.toContain("set_key");
      expect(engine.state.key).toBeNull();
    });
  });

  // (10)
  it("I'm ready celebrates exactly once, and Go to the Booth hands off", async () => {
    await boot();
    await toVoice();
    const before = useStore.getState().celebrateTick;
    await click("v3-start-ready");
    expect(stepOf()).toBe("ready");
    expect(el("v3-start-ready-card")).not.toBeNull();
    expect(useStore.getState().celebrateTick).toBe(before + 1);
    expect(useV3.getState().posture).toBe("start");
    await click("v3-start-go-booth");
    expect(useV3.getState().posture).toBe("booth");
  });

  // (11)
  describe("the Phone step", () => {
    const pairingAt = (expiresAtMs: number) => ({
      running: true, port: 8792,
      pairing: { host: "192.168.1.9", port: 8792, token: "ab".repeat(16), expiresAtMs,
        pairingUrl: "mosh://pair", webUrl: "http://192.168.1.9:8792/web", padUrl: "http://192.168.1.9:8792/pad#token=abab" },
    });
    async function toPhone(expiresAtMs: number) {
      await boot();
      await toVoice();
      await click("v3-start-ready");
      await click("v3-start-add-phone");
      expect(stepOf()).toBe("phone");
      const start = vi.fn(async () => { useStore.setState({ remoteStatus: pairingAt(expiresAtMs) }); });
      useStore.setState({ startRemotePairing: start });
      return start;
    }

    it("an expired code says so and offers a new one", async () => {
      const start = await toPhone(Date.now() - 1_000);
      expect(el("v3-start-pad-url")).toBeNull();
      await click("v3-start-show-code");
      expect(start).toHaveBeenCalledTimes(1);
      expect(el("v3-start-pair-expired")).not.toBeNull();
      expect(el("v3-start-new-code")).not.toBeNull();
      expect(el("v3-start-pair-ttl")).toBeNull();
      expect(useStore.getState().refreshRemote).toHaveBeenCalled();
    });

    it("a live code shows how long it lasts", async () => {
      await toPhone(Date.now() + 4 * 60_000);
      await click("v3-start-show-code");
      expect(el("v3-start-pair-expired")).toBeNull();
      expect(must("v3-start-pair-ttl").textContent).toMatch(/^Code valid for [34]:\d\d$/);
      expect(must("v3-start-pad-url").textContent).toBe("http://192.168.1.9:8792/pad#token=abab");
    });

    it("a link that won't start says so and offers Try again", async () => {
      await toPhone(0);
      useStore.setState({ startRemotePairing: vi.fn(async () => { useStore.setState({ lastError: "remote companion failed to start: port in use" }); }) });
      await click("v3-start-show-code");
      expect(must("v3-start-pair-failed").textContent).toContain("port in use");
      expect(el("v3-start-pad-url")).toBeNull();
    });

    // The leave-step cleanup reads the error through a ref: it belongs to the render the
    // singer ARRIVED in, when there was no error yet (the bug this test caught).
    it("a phone-link start error leaves the app's error slot when the singer leaves the step", async () => {
      await toPhone(0);
      useStore.setState({ startRemotePairing: vi.fn(async () => { useStore.setState({ lastError: "remote companion failed to start: port in use" }); }) });
      await click("v3-start-show-code");
      expect(el("v3-start-pair-failed")).not.toBeNull();
      await click("v3-start-over");
      expect(stepOf()).toBe("welcome");
      expect(useStore.getState().lastError).toBeNull();
    });

    it("Skip goes to the Booth and marks the phone skipped", async () => {
      await toPhone(Date.now() + 60_000);
      await click("v3-start-skip-phone");
      expect(useV3.getState().posture).toBe("booth");
      expect(useStartMemory.getState().phone.skipped).toBe(true);
    });
  });

  // (12)
  it("the footer writes startOnLaunch and opens the studio", async () => {
    await boot();
    // Independent of the schema default (which the owner may flip): the box mirrors the
    // setting, and each click writes the opposite.
    const initial = useSettings.getState().get("startOnLaunch") === true;
    expect(must<HTMLInputElement>("v3-start-on-launch").checked).toBe(initial);
    await click("v3-start-on-launch");
    expect(useSettings.getState().get("startOnLaunch")).toBe(!initial);
    expect(must<HTMLInputElement>("v3-start-on-launch").checked).toBe(!initial);
    await click("v3-start-on-launch");
    expect(useSettings.getState().get("startOnLaunch")).toBe(initial);
    await click("v3-start-studio");
    expect(useV3.getState().posture).toBe("studio");
  });

  // (13)
  it("someone else replacing the project sends the page back to Welcome and says so", async () => {
    await boot();
    await newSong();
    expect(useStartMemory.getState().epoch).toBe(0);
    await act(async () => { useStore.setState({ projectEpoch: 1 }); });
    await settle();
    expect(stepOf()).toBe("welcome");
    expect(must("v3-start-note").textContent).toContain("The song changed");
    expect(useStartMemory.getState().ids).toEqual({ backingTrackId: null, leadTrackId: null, takesTrackId: null });
  });
});
