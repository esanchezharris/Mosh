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
import type { AiToolsSnapshot, CommandResult, Plugin, Snapshot, Track } from "../types";
import { __resetMockForTests } from "../bridge.mock";
import { useV3 } from "./shellState";
import { StartChecklist } from "./StartChecklist";
import { RecordingSetup, __resetLaunchForTests } from "./RecordingSetup";
import { PROGRESS_KEY, __resetStartMemoryForTests, useStartMemory } from "./startMemory";

// The first-run checklist against an in-test FAKE ENGINE: a plain object whose exec mutates it and
// answers in the native shapes, and whose refresh writes a fresh snapshot into useStore.
// Every assertion reads either the command log or what the checklist renders.

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
  /** snapshot.aiTools, when the test needs a Mac with or without the optional tools. */
  aiTools?: AiToolsSnapshot;
  /** Return an error string to refuse a call. */
  refuse?: (call: Call) => string | null;
  /** Return a promise to hold a call (logged at once) until the test settles it. */
  hold?: (call: Call) => Promise<void> | null;
}

interface FakeState {
  tracks: Track[];
  tempo: number;
  metronome: boolean;
  transport: { playing: boolean; recording: boolean; position: number; looping: boolean; loopStart: number; loopEnd: number };
  loop: { engaged: boolean; leadTrackId: string | null; takesTrackId: string | null };
  key: { tonic: string; mode: string } | null;
  blockReason: string;
  phoneConnected: boolean;
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
    phoneConnected: false,
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
        // The native template: Beat, Lead vocal (Tuned Lead) with its Takes lane already
        // under it (armed, the same chain, the phone remote's pair), Ad-libs (Clean Lead).
        const beat = newTrack("Beat");
        state.tracks.push(beat);
        const vocal = newTrack("Lead vocal", { plugins: presetStages(TUNED_FILE) });
        state.tracks.push(vocal);
        const takes = newTrack("Lead vocal · Takes", { armed: true, plugins: presetStages(TUNED_FILE) });
        state.tracks.push(takes);
        state.loop = { engaged: true, leadTrackId: vocal.id, takesTrackId: takes.id };
        const adlib = newTrack("Ad-libs", { plugins: presetStages(CLEAN_FILE) });
        state.tracks.push(adlib);
        state.tracks.forEach((t) => reindex(t));
        return ok(command, { template: "vocal", backingTrackId: beat.id, vocalTrackId: vocal.id, adlibTrackId: adlib.id,
          beatTrackId: beat.id, leadTrackId: vocal.id, takesTrackId: takes.id });
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
        // Already paired (the template made it): reuse the lane, as the engine does.
        const paired = state.loop.engaged && state.loop.leadTrackId === lead.id ? find(state.loop.takesTrackId) : null;
        if (paired) {
          paired.armed = true; lead.armed = false;
          return ok(command, { leadTrackId: lead.id, takesTrackId: paired.id, created: false, armed: true });
        }
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
      contributions: [], phoneConnected: state.phoneConnected, phoneSeenMs: 0, blockReason: state.blockReason,
    },
    audio: { outputDevice: opts.output ?? "External Headphones", inputDevice: "MacBook Pro Microphone" },
    ...(opts.aiTools ? { aiTools: opts.aiTools } : {}),
  }) as unknown as Snapshot;

  const exec = vi.fn(async (command: string, args: Record<string, unknown> = {}): Promise<CommandResult> => {
    const call = { command, args };
    calls.push(call);
    const held = opts.hold?.(call);
    if (held) await held;
    const refused = opts.refuse?.(call);
    if (refused) return err(command, refused);
    return handle(command, args);
  });
  const refresh = vi.fn(async () => { useStore.setState({ snapshot: snapshot() }); });
  const byName = (name: string) => state.tracks.find((t) => t.name === name);
  return { state, calls, exec, refresh, snapshot, byName };
}
type Engine = ReturnType<typeof makeEngine>;

// The checklist takes its snapshot as a prop, like AppV3 gives it; the host re-renders on
// every refresh and mounts the app's drop hook and the always-on setup beside it.
function Host() {
  const snap = useStore((s) => s.snapshot);
  useFileDrop();
  return snap ? React.createElement(React.Fragment, null,
    React.createElement(RecordingSetup, { snapshot: snap }),
    React.createElement(StartChecklist, { snapshot: snap })) : null;
}

const initialStore = useStore.getState();

describe("v3 first-run checklist (StartChecklist.tsx) against a fake engine", () => {
  let host: HTMLDivElement;
  let root: Root;
  let engine: Engine;

  const el = <T extends HTMLElement = HTMLElement>(id: string) => host.querySelector<T>(`[data-testid="${id}"]`);
  const must = <T extends HTMLElement = HTMLElement>(id: string): T => {
    const found = el<T>(id);
    if (!found) throw new Error(`missing [data-testid="${id}"] with item ${el("v3-checklist")?.dataset.current} open`);
    return found;
  };
  const currentItem = () => el("v3-checklist")?.dataset.current;
  const stateOf = (key: string) => must(`v3-check-item-${key}`).dataset.state;
  const settle = async () => {
    for (let i = 0; i < 8; i += 1) {
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
  const presetIds = (t: Track | undefined) => (t?.plugins ?? []).map((p) => p.preset?.id);

  async function boot(opts: EngineOpts = {}) {
    engine = makeEngine(opts);
    useStore.setState({
      snapshot: engine.snapshot(),
      exec: engine.exec as unknown as typeof initialStore.exec,
      refresh: engine.refresh,
      ensurePeaks: vi.fn(),
      refreshRemote: vi.fn(async () => {}),
      startRemotePairing: vi.fn(async () => {
        useStore.setState({ remoteStatus: { pairing: { padUrl: "http://10.0.0.2:8765/pad#token=t", host: "10.0.0.2", expiresAtMs: Date.now() + 300_000 } } as never });
      }),
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
  const song = () => ({ beat: engine.byName("Beat")!, lead: engine.byName("Lead vocal")!, adlib: engine.byName("Ad-libs")! });
  const phoneArrives = async () => {
    engine.state.phoneConnected = true;
    await act(async () => { await engine.refresh(); });
    await settle();
  };

  beforeEach(() => {
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    vi.mocked(microphonePermissionStatus).mockReset().mockResolvedValue({ status: "granted" });
    vi.mocked(requestMicrophonePermission).mockReset().mockResolvedValue({ status: "granted" });
    vi.mocked(pickFiles).mockReset().mockResolvedValue({ ok: false, files: [] });
    window.localStorage.removeItem(PROGRESS_KEY);
    __resetStartMemoryForTests();
    __resetLaunchForTests();
    useSettings.getState().reset();
    useV3.setState({ posture: "studio" });
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
  });

  afterEach(async () => {
    await act(async () => { root.unmount(); });
    host.remove();
    useStore.setState(initialStore, true);
    __resetMockForTests();
    vi.restoreAllMocks();
  });

  // ── launch ──────────────────────────────────────────────────────────────────────────
  it("an empty session at launch becomes the recording song, asked for the mic first, and the checklist opens on Beat", async () => {
    vi.mocked(microphonePermissionStatus).mockResolvedValue({ status: "not-determined" });
    await boot();
    expect(vi.mocked(requestMicrophonePermission)).toHaveBeenCalledTimes(1);
    expect(commands().filter((c) => c === "new_project")).toHaveLength(1);
    expect(argsOf("new_project")[0]).toEqual({ template: "vocal" });
    expect(engine.state.tracks.map((t) => t.name)).toEqual(["Beat", "Lead vocal", "Lead vocal · Takes", "Ad-libs"]);
    // The template made the Takes lane itself; the UI adds nothing on top of it.
    expect(commands()).not.toContain("loop_setup");
    expect(engine.byName("Lead vocal · Takes")!.armed).toBe(true);
    expect(song().lead.armed).toBe(false);
    expect(currentItem()).toBe("beat");
    expect(must("v3-check-beat")).toBeTruthy();
    expect(["beat", "voice", "phone"].map(stateOf)).toEqual(["todo", "todo", "todo"]);
    expect(useV3.getState().posture).toBe("studio");
  });

  it("macOS still undecided about the mic: no song is made (the template would freeze on the prompt), and the button retries", async () => {
    vi.mocked(microphonePermissionStatus).mockResolvedValue({ status: "not-determined" });
    vi.mocked(requestMicrophonePermission).mockResolvedValue({ status: "not-determined" });
    await boot();
    expect(commands()).not.toContain("new_project");
    expect(must("v3-check-song-error").textContent).toContain("macOS may ask");
    vi.mocked(microphonePermissionStatus).mockResolvedValue({ status: "granted" });
    await click("v3-check-new-song");
    expect(commands()).toContain("new_project");
    expect(el("v3-check-song")).toBeNull();
  });

  it("a session that already has tracks is never replaced at launch", async () => {
    await boot({ tracks: [{ id: "1", index: 0, name: "My song", type: "audio", clips: [], plugins: [], armed: false, monitor: "automatic" } as unknown as Track] });
    expect(commands()).not.toContain("new_project");
    expect(engine.state.tracks.map((t) => t.name)).toEqual(["My song"]);
  });

  it("with 'Set up a song when Mosh opens' off, launch makes nothing", async () => {
    useSettings.getState().set("startOnLaunch", false);
    await boot();
    expect(commands()).not.toContain("new_project");
    // …and the checklist does not open by itself; the Start button still reaches it.
    expect(el("v3-checklist")).toBeNull();
    await act(async () => { useStartMemory.getState().reopen(); });
    await settle();
    expect(must("v3-check-new-song")).toBeTruthy();
  });

  it("on laptop speakers the new song's Hear myself is turned off, and the checklist says why", async () => {
    await boot({ output: "MacBook Pro Speakers" });
    // On the Takes lane: that is the track holding the mic.
    expect(argsOf("set_input_monitor")).toContainEqual({ trackId: engine.byName("Lead vocal · Takes")!.id, mode: "off" });
    expect(engine.byName("Lead vocal · Takes")!.monitor).toBe("off");
    expect(must("v3-check-note").textContent).toContain("plug in headphones");
  });

  // ── beat ────────────────────────────────────────────────────────────────────────────
  it("Beat: a chosen file lands on the Beat track at bar 1, the tempo is proposed, ÷2 and ×2 nudge it, and Use sets tempo and loop", async () => {
    await boot();
    vi.mocked(pickFiles).mockResolvedValue({ ok: true, files: ["/music/my beat.wav"] });
    const from = engine.calls.length;
    await click("v3-check-choose");
    expect(argsOf("import_clip", from)).toEqual([{ file: "/music/my beat.wav", trackId: song().beat.id, startSeconds: 0 }]);
    expect(song().beat.clips).toHaveLength(1);
    expect(song().lead.clips).toHaveLength(0);
    expect(must("v3-check-tempo-line").textContent).toContain("88");
    await click("v3-check-bpm-half");
    expect(must<HTMLInputElement>("v3-check-bpm").value).toBe("44");
    await click("v3-check-bpm-double");
    expect(must<HTMLInputElement>("v3-check-bpm").value).toBe("88");
    await click("v3-check-bpm-confirm");
    expect(engine.state.tempo).toBe(88);
    expect(engine.state.transport.loopEnd).toBeCloseTo(BEAT_SECONDS, 3);
    expect(stateOf("beat")).toBe("done");
    expect(currentItem()).toBe("voice");
  });

  it("Beat: a second beat replaces the first instead of stacking on it", async () => {
    await boot();
    vi.mocked(pickFiles).mockResolvedValue({ ok: true, files: ["/music/one.wav"] });
    await click("v3-check-choose");
    vi.mocked(pickFiles).mockResolvedValue({ ok: true, files: ["/music/two.wav"] });
    await click("v3-check-choose");
    expect(song().beat.clips.map((c) => c.name)).toEqual(["two.wav"]);
  });

  it("Beat: ⌘Z of the tempo brings the item back to To do", async () => {
    await boot();
    vi.mocked(pickFiles).mockResolvedValue({ ok: true, files: ["/music/beat.wav"] });
    await click("v3-check-choose");
    await click("v3-check-bpm-confirm");
    expect(stateOf("beat")).toBe("done");
    engine.state.tempo = 120;
    await act(async () => { await engine.refresh(); });
    await settle();
    expect(stateOf("beat")).toBe("todo");
  });

  it("each item can be skipped, and skipping all three shows You're set", async () => {
    await boot();
    await click("v3-check-skip-beat");
    expect(stateOf("beat")).toBe("skipped");
    expect(currentItem()).toBe("voice");
    await click("v3-check-skip-voice");
    expect(currentItem()).toBe("phone");
    await click("v3-check-skip-phone");
    expect(["beat", "voice", "phone"].map(stateOf)).toEqual(["skipped", "skipped", "skipped"]);
    expect(must("v3-check-set")).toBeTruthy();
    await click("v3-check-close");
    expect(el("v3-checklist")).toBeNull();
  });

  // ── voice ───────────────────────────────────────────────────────────────────────────
  it("Voice: the template's Lead is tuned and armed, so the check passes on headphones and Sounds right marks it done", async () => {
    await boot();
    await click("v3-check-item-voice");
    expect(must("v3-check-tuned").getAttribute("aria-checked")).toBe("true");
    expect(must("v3-check-voice-say").textContent).toContain("tuned");
    expect(must("v3-check-mic").textContent).toContain("MacBook Pro Microphone");
    expect(must("v3-check-monitor").textContent).toContain("On");
    expect(must<HTMLButtonElement>("v3-check-voice-ok").disabled).toBe(false);
    await click("v3-check-voice-ok");
    expect(stateOf("voice")).toBe("done");
  });

  it("Voice: a denied microphone blocks Sounds right with the fix, and Skip still works", async () => {
    vi.mocked(microphonePermissionStatus).mockResolvedValue({ status: "denied" });
    await boot();
    await click("v3-check-item-voice");
    expect(must("v3-check-mic").textContent).toContain("isn't allowed");
    expect(must<HTMLButtonElement>("v3-check-voice-ok").disabled).toBe(true);
    expect(must("v3-check-voice-ok").textContent).toBe("Fix the microphone first");
    await click("v3-check-skip-voice");
    expect(stateOf("voice")).toBe("skipped");
  });

  it("Voice: Clean Lead replaces Tuned Lead on the Lead and its Takes lane, as one batch", async () => {
    await boot();
    await click("v3-check-item-voice");
    const from = engine.calls.length;
    await click("v3-check-clean");
    expect(commands(from).filter((c) => c !== "list_presets")).toEqual([
      "batch_begin",
      "remove_plugin", "remove_plugin", "remove_plugin", "apply_track_preset",   // the Lead
      "remove_plugin", "remove_plugin", "remove_plugin", "apply_track_preset",   // its Takes lane: what you hear live
      "batch_end",
    ]);
    expect(presetIds(song().lead)).toEqual(["mosh.clean-lead", "mosh.clean-lead"]);
    expect(presetIds(engine.byName("Lead vocal · Takes")!)).toEqual(["mosh.clean-lead", "mosh.clean-lead"]);
    // Ad-libs keeps its own chain: the voice check is about the Lead.
    expect(presetIds(song().adlib)).toEqual(["mosh.clean-lead", "mosh.clean-lead"]);
    expect(must("v3-check-voice-say").textContent).not.toContain("tuned");
  });

  it("Voice: choosing a key writes it to the AutoTune on the Lead and on its Takes lane, and to the song, as one batch", async () => {
    await boot();
    await click("v3-check-item-voice");
    await click("v3-check-tuned");
    await choose("v3-check-key-root", "A");
    await choose("v3-check-key-scale", "Minor");
    const from = engine.calls.length;
    await click("v3-check-tuned-apply");
    const params = argsOf("set_plugin_param", from);
    const takesId = engine.byName("Lead vocal · Takes")!.id;
    expect(params.map((a) => [a.trackId, a.paramIndex])).toEqual([[song().lead.id, 0], [song().lead.id, 1], [takesId, 0], [takesId, 1]]);
    for (const i of [0, 2]) expect(params[i]!.value).toBeCloseTo(9 / 11, 6);
    for (const i of [1, 3]) expect(params[i]!.value).toBe(1);
    expect(engine.state.key).toEqual({ tonic: "A", mode: "minor" });
    expect(commands(from).filter((c) => c === "batch_begin" || c === "batch_end")).toEqual(["batch_begin", "batch_end"]);
    expect(presetIds(song().lead)).toEqual(["mosh.tuned-lead", "mosh.tuned-lead", "mosh.tuned-lead"]);
  });

  it("Voice: Hear myself on laptop speakers is the rapper's call, and the guard then stands down", async () => {
    await boot({ output: "MacBook Pro Speakers" });
    await click("v3-check-item-voice");
    expect(must("v3-check-headphones").textContent).toContain("MacBook Pro Speakers");
    expect(must("v3-check-monitor").textContent).toContain("Off");
    await click("v3-check-monitor");
    expect(song().lead.monitor).toBe("automatic");
    await settle();
    expect(song().lead.monitor).toBe("automatic");   // not turned back off
  });

  // ── phone ───────────────────────────────────────────────────────────────────────────
  it("Phone: Show the code finds the pair the song started with: no second Takes lane, no chain added twice", async () => {
    await boot();
    await click("v3-check-item-phone");
    const from = engine.calls.length;
    await click("v3-check-show-code");
    const takes = engine.byName("Lead vocal · Takes")!;
    expect(argsOf("loop_setup", from)).toEqual([]);
    expect(argsOf("apply_track_preset", from)).toEqual([]);
    expect(engine.state.tracks.filter((t) => t.name.endsWith("· Takes"))).toHaveLength(1);
    expect(presetIds(takes)).toEqual(["mosh.tuned-lead", "mosh.tuned-lead", "mosh.tuned-lead"]);
    expect(engine.state.loop).toMatchObject({ engaged: true, leadTrackId: song().lead.id, takesTrackId: takes.id });
    expect(vi.mocked(useStore.getState().startRemotePairing)).toHaveBeenCalledTimes(1);
    expect(must("v3-check-qr")).toBeTruthy();
    // No Booth, before or after the phone arrives.
    await phoneArrives();
    expect(useV3.getState().posture).toBe("studio");
    expect(must("v3-check-phone-target").textContent).toContain("Lead vocal");
    expect(must("v3-check-phone-live").textContent).toContain("ready");
    expect(stateOf("phone")).toBe("done");
  });

  it("Phone: with the remote already on the Lead, Show the code does not set it up twice", async () => {
    await boot();
    await click("v3-check-item-phone");
    await click("v3-check-show-code");
    const from = engine.calls.length;
    await click("v3-check-new-code");
    expect(commands(from)).not.toContain("loop_setup");
    expect(commands(from)).not.toContain("apply_track_preset");
  });

  it("a phone that is already paired when a new song opens finds the remote on the new Lead vocal, with nothing added", async () => {
    await boot();
    engine.state.phoneConnected = true;
    const from = engine.calls.length;
    await act(async () => { await engine.refresh(); });
    await settle();
    expect(argsOf("loop_setup", from)).toEqual([]);
    expect(engine.state.tracks.map((t) => t.name)).toEqual(["Beat", "Lead vocal", "Lead vocal · Takes", "Ad-libs"]);
    expect(engine.state.loop).toMatchObject({ engaged: true, leadTrackId: song().lead.id, takesTrackId: engine.byName("Lead vocal · Takes")!.id });
    expect(presetIds(engine.byName("Lead vocal · Takes"))).toEqual(["mosh.tuned-lead", "mosh.tuned-lead", "mosh.tuned-lead"]);
  });

  // ── remembering ─────────────────────────────────────────────────────────────────────
  it("the × dismisses it for good, and reopening brings it back with what was done", async () => {
    await boot();
    await click("v3-check-skip-beat");
    await click("v3-check-dismiss");
    expect(el("v3-checklist")).toBeNull();
    expect(JSON.parse(window.localStorage.getItem(PROGRESS_KEY)!)).toMatchObject({ beat: "skipped", dismissed: true });
    // A relaunch: the stored record keeps it closed.
    await act(async () => { __resetStartMemoryForTests(); });
    expect(useStartMemory.getState().open).toBe(false);
    await act(async () => { useStartMemory.getState().reopen(); });
    await settle();
    expect(stateOf("beat")).toBe("skipped");
    expect(JSON.parse(window.localStorage.getItem(PROGRESS_KEY)!)).toMatchObject({ dismissed: false });
  });

  it("uses plain words: nothing on the checklist says posture, lane, Booth or Moshi", async () => {
    await boot();
    for (const key of ["beat", "voice", "phone"]) {
      await click(`v3-check-item-${key}`);
      if (currentItem() !== key) await click(`v3-check-item-${key}`);
      expect(must("v3-checklist").textContent).not.toMatch(/posture|\blane\b|booth|moshi/i);
    }
  });
});
