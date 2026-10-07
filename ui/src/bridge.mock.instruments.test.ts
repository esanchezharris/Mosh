// The dev mock's instruments speak the frozen instrument-panels contract (§1): the 4OSC
// surface and settings, the low/high-pass slope, the sampler's sounds and pad commands,
// and the instrument frames on the plugin_meters rail. Panels are built against this mock
// while the engine is built to the same contract, so every shape here is the engine's.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { __resetMockForTests, mockExecute, mockOnEvent, mockSnapshot } from "./bridge.mock";
import type {
  CommandResult, FourOscMeter, Plugin, PluginMeterReading, SamplerMeter, SamplerSound, Snapshot, Track,
} from "./types";

const run = (command: string, args: Record<string, unknown> = {}) => mockExecute<CommandResult>({ command, args });
const snapshot = () => mockSnapshot<Snapshot>();
const trackById = async (id: string): Promise<Track> => (await snapshot()).tracks.find((t) => t.id === id)!;
const pluginOf = async (trackId: string, type: string): Promise<Plugin> => (await trackById(trackId)).plugins!.find((p) => p.type === type)!;

async function newTrack(type: "audio" | "drum" = "audio"): Promise<string> {
  const r = await run("create_track", { name: type === "drum" ? "Beat" : "Synth", type });
  return (r.data as { trackId: string }).trackId;
}

beforeEach(() => __resetMockForTests());

describe("4OSC as the engine sends it", () => {
  it("auto-loads as \"4OSC\" with an item id, category Instrument, 68 parameters and its settings", async () => {
    const id = await newTrack();
    expect((await run("add_midi_clip", { trackId: id, start: 0, length: 2 })).ok).toBe(true);
    const synth = await pluginOf(id, "4osc");
    expect(synth).toMatchObject({ index: 0, name: "4OSC", type: "4osc", builtin: true, external: false, isInstrument: true, category: "Instrument" });
    expect(synth.itemId).toMatch(/^m\d+$/);
    expect(synth.params).toHaveLength(68);
    expect(synth.params[40]).toMatchObject({ id: "ampAttack", name: "Amp Attack", display: "100ms", skew: Math.fround(0.2) });
    expect(Object.keys(synth.state ?? {})).toHaveLength(17);
    expect(synth.state?.filterType).toEqual({ value: "off", choices: ["off", "lowpass", "highpass", "bandpass", "notch"] });
    expect(synth.modRoutes).toBeUndefined();     // Mosh never creates mod routes
  });

  it("set_plugin_param clamps, maps through the skew in floats, and reads back the engine's string", async () => {
    const id = await newTrack();
    await run("load_builtin", { trackId: id, type: "4osc" });
    expect((await run("set_plugin_param", { trackId: id, index: 0, paramIndex: 40, value: 0.5 })).ok).toBe(true);
    expect((await pluginOf(id, "4osc")).params[40]).toMatchObject({ value: 0.5, display: "1.88s" });
    await run("set_plugin_param", { trackId: id, index: 0, paramIndex: 2, value: 3 });
    expect((await pluginOf(id, "4osc")).params[2]).toMatchObject({ value: 1, display: "0.000dB" });
    await run("set_plugin_param", { trackId: id, index: 0, paramIndex: 67, value: 0.5 });
    expect((await pluginOf(id, "4osc")).params[67]!.display).toBe("-15.9");      // master Level: dB without the unit
  });

  it("set_plugin_state takes the contract's keys: choices validated, integers snapped to their step", async () => {
    const id = await newTrack();
    await run("load_builtin", { trackId: id, type: "4osc" });
    const set = (key: string, value: unknown) => run("set_plugin_state", { trackId: id, index: 0, key, value });
    const state = async (key: string) => (await pluginOf(id, "4osc")).state![key]!.value;

    expect((await set("waveShape2", "saw")).data).toEqual({ key: "waveShape2", value: "saw" });
    expect(await state("waveShape2")).toBe("saw");
    expect((await set("waveShape2", "sawtooth")).ok).toBe(false);          // not one of the choices
    expect((await set("waveShape2", 3)).ok).toBe(false);                   // an engine int is not a choice
    expect((await set("filterType", "bandpass")).ok).toBe(true);
    expect((await set("filterSlope", 18)).data).toEqual({ key: "filterSlope", value: 24 });   // 12 + 12·floor(0.5 + 0.5)
    expect((await set("filterSlope", 17.9)).data).toEqual({ key: "filterSlope", value: 12 });
    expect((await set("filterSlope", 99)).data).toEqual({ key: "filterSlope", value: 24 });
    expect((await set("voices1", 4.4)).data).toEqual({ key: "voices1", value: 4 });
    expect((await set("voices1", 0)).data).toEqual({ key: "voices1", value: 1 });
    expect((await set("voices1", 40)).data).toEqual({ key: "voices1", value: 8 });
    expect((await set("delayBeats", 0.01)).data).toEqual({ key: "delayBeats", value: 0.0625 });
    expect((await set("delayBeats", 1.5)).data).toEqual({ key: "delayBeats", value: 1.5 });   // a number: not snapped
    expect((await set("voiceMode", "mono")).ok).toBe(true);
    expect((await set("lfoSync1", "on")).ok).toBe(false);                  // excluded from the contract
    expect((await set("polyphony", 8)).ok).toBe(false);
    // each is one undo step
    expect((await run("undo")).ok).toBe(true);
    expect(await state("voiceMode")).toBe("poly");
  });
});

describe("low/high-pass slope", () => {
  it("both filter types carry state.slope and snap writes onto 6 dB/oct steps", async () => {
    const id = await newTrack();
    await run("load_builtin", { trackId: id, type: "lowpass" });
    await run("load_builtin", { trackId: id, type: "highpass" });
    const t = await trackById(id);
    for (const p of t.plugins!) expect(p.state?.slope).toEqual({ value: 12, min: 6, max: 48, step: 6, unit: "dB/oct" });
    const set = async (value: unknown) => (await run("set_plugin_state", { trackId: id, index: 1, key: "slope", value }));
    for (const [asked, applied] of [[25, 24], [27, 30], [0, 6], [100, 48], [9, 12], [6, 6], [48, 48]] as const)
      expect((await set(asked)).data).toEqual({ key: "slope", value: applied });
    expect((await set("24")).ok).toBe(false);
    expect((await set(Number.NaN)).ok).toBe(false);
    // the mode flip keeps the slope
    await set(36);
    await run("set_plugin_state", { trackId: id, index: 1, key: "mode", value: "lowpass" });
    expect((await trackById(id)).plugins![1]).toMatchObject({ type: "lowpass", state: { slope: { value: 36 } } });
    // the delay length still rounds to whole milliseconds and reports step 1
    await run("load_builtin", { trackId: id, type: "delay" });
    expect((await run("set_plugin_state", { trackId: id, index: 2, key: "lengthMs", value: 150.4 })).data).toEqual({ key: "lengthMs", value: 150 });
    expect((await trackById(id)).plugins![2]!.state?.lengthMs?.step).toBe(1);
  });

  it("re-applying a track preset restores its high-pass to 12 dB/oct (a changed slope is not the preset)", async () => {
    const id = await newTrack();
    const FILE = "/presets/track-chain/mosh-clean-lead-v0.json";
    expect((await run("apply_track_preset", { trackId: id, file: FILE })).data).toMatchObject({ changed: true });
    expect((await trackById(id)).plugins![0]!.state?.slope?.value).toBe(12);
    expect((await run("apply_track_preset", { trackId: id, file: FILE })).data).toMatchObject({ changed: false });   // unchanged: a no-op
    await run("set_plugin_state", { trackId: id, index: 0, key: "slope", value: 48 });
    expect((await run("apply_track_preset", { trackId: id, file: FILE })).data).toMatchObject({ changed: true, replaced: true });
    expect((await trackById(id)).plugins![0]!.state?.slope?.value).toBe(12);
  });
});

describe("Sampler as the engine sends it", () => {
  const pads = (s: SamplerSound[]) => s.map((x) => [x.pitch, x.name]);
  const KIT = [[36, "Kick"], [38, "Snare"], [39, "Clap"], [42, "Closed Hat"], [46, "Open Hat"], [45, "Low Tom"], [47, "Mid Tom"], [49, "Crash"]];

  it("a new drum track holds the bundled kit (no kit name on the track), in the engine's order and shape", async () => {
    const id = await newTrack("drum");
    const t = await trackById(id);
    const sampler = t.plugins![0]!;
    expect(sampler).toMatchObject({ type: "sampler", name: "Sampler", isInstrument: true, category: "Instrument", params: [] });
    expect(sampler.sampler).toMatchObject({ primary: true, limits: { maxVoices: 32, maxSounds: 64, minGainDb: -48, maxGainDb: 48 } });
    expect(sampler.sampler!.kit).toBeUndefined();
    expect(t.drumKit).toBeUndefined();
    expect(pads(sampler.sampler!.sounds)).toEqual(KIT);
    expect(sampler.sampler!.sounds[0]).toEqual({
      index: 0, name: "Kick", file: "/kits/mosh-kit/kick.wav", path: "/kits/mosh-kit/kick.wav", missing: false,
      pitch: 36, minNote: 36, maxNote: 36, gainDb: 0, userGainDb: 0, silenced: false, pan: 0, openEnded: true,
      mode: "drum", addressNote: 36, durationSec: 0.36, sampleRate: 44100, channels: 1,
    });
    // the per-track view stays the older shape, from the same sounds
    expect(t.drumPads?.[3]).toEqual({ index: 3, pitch: 42, minNote: 42, maxNote: 42, name: "Closed Hat", file: "/kits/mosh-kit/hat_closed.wav", gainDb: 0, pan: 0, openEnded: true });
  });

  it("load_drum_kit validates the kit, replaces every sound, names the kit; one undo", async () => {
    const id = await newTrack("drum");
    expect((await run("load_drum_kit", { trackId: id, kit: "nope" })).error).toMatch(/no kit: nope/);
    const r = await run("load_drum_kit", { trackId: id, kit: "mosh-808" });
    expect(r.data).toEqual({ trackId: id, index: 0, pads: 8, kit: "mosh-808" });
    const t = await trackById(id);
    expect(t.drumKit).toBe("mosh-808");
    expect(t.plugins![0]!.sampler).toMatchObject({ kit: "mosh-808" });
    expect(t.plugins![0]!.sampler!.sounds[0]).toMatchObject({ path: "/kits/mosh-808/kick.wav", durationSec: 0.9 });
    await run("undo");
    expect((await trackById(id)).drumKit).toBeUndefined();
  });

  it("assign_sample replaces every sound covering the note, resets level/pan/choke, imports the file", async () => {
    const id = await newTrack("drum");
    await run("set_drum_pad", { trackId: id, note: 38, gainDb: -6, pan: 0.5, chokeGroup: 2 });
    const r = await run("assign_sample", { trackId: id, note: 38, file: "/Users/me/Samples/Snare Tight.wav" });
    expect(r.data).toEqual({ trackId: id, index: 0, note: 38, name: "Snare Tight", mode: "drum", file: "/mock/imports/Snare Tight.wav", sounds: 8 });
    const sounds = (await pluginOf(id, "sampler")).sampler!.sounds;
    const snare = sounds.find((s) => s.pitch === 38)!;
    expect(snare).toMatchObject({ index: 7, name: "Snare Tight", gainDb: 0, pan: 0, openEnded: true, mode: "drum", addressNote: 38 });
    expect(snare.chokeGroup).toBeUndefined();

    // melodic: one sound across the keyboard, rooted at the note, gated; it removes the pad
    // it covers at that note and is reachable only where no narrower pad is
    await run("assign_sample", { trackId: id, note: 36, file: "/Users/me/808.wav", mode: "melodic", gainDb: -3 });
    const after = (await pluginOf(id, "sampler")).sampler!.sounds;
    const bass = after.find((s) => s.mode === "melodic")!;
    expect(bass).toMatchObject({ pitch: 36, minNote: 0, maxNote: 127, gainDb: -3, openEnded: false, addressNote: 0 });
    expect(after.filter((s) => s.pitch === 36)).toHaveLength(1);    // the kick it covered is gone
    expect(after).toHaveLength(8);
  });

  it("set_drum_pad reaches the NARROWEST sound, clamps, and returns its index", async () => {
    const id = await newTrack("drum");
    await run("assign_sample", { trackId: id, note: 30, file: "/x/sub.wav", mode: "melodic" });
    // note 38: the snare pad, not the 808 that also spans it
    expect((await run("set_drum_pad", { trackId: id, note: 38, gainDb: 99, pan: -7 })).data).toEqual({ trackId: id, note: 38, padIndex: 1 });
    let sounds = (await pluginOf(id, "sampler")).sampler!.sounds;
    expect(sounds[1]).toMatchObject({ pitch: 38, gainDb: 48, pan: -1 });
    expect(sounds.find((s) => s.mode === "melodic")!.gainDb).toBe(0);
    // note 60: only the 808 covers it
    expect((await run("set_drum_pad", { trackId: id, note: 60, gainDb: -60, chokeGroup: 40 })).ok).toBe(true);
    sounds = (await pluginOf(id, "sampler")).sampler!.sounds;
    expect(sounds.find((s) => s.mode === "melodic")).toMatchObject({ gainDb: -48, chokeGroup: 16, openEnded: false });
    await run("set_drum_pad", { trackId: id, note: 60, chokeGroup: 0 });
    expect((await pluginOf(id, "sampler")).sampler!.sounds.find((s) => s.mode === "melodic")!.openEnded).toBe(true);
    expect((await run("set_drum_pad", { trackId: id, note: 38, name: "Rim" })).ok).toBe(true);
    expect((await trackById(id)).drumPads!.find((p) => p.pitch === 38)!.name).toBe("Rim");
    // no track sampler / no pad: the engine's errors
    expect((await run("set_drum_pad", { trackId: (await snapshot()).tracks[2]!.id, note: 36, gainDb: 0 })).error).toMatch(/no sampler/);
    await run("clear_drum_pad", { trackId: id, note: 60 });
    expect((await run("set_drum_pad", { trackId: id, note: 61, gainDb: 0 })).error).toBe("no pad at note 61");
  });

  it("clear_drum_pad removes only the narrowest sound at the note", async () => {
    const id = await newTrack("drum");
    await run("assign_sample", { trackId: id, note: 30, file: "/x/sub.wav", mode: "melodic" });
    expect((await run("clear_drum_pad", { trackId: id, note: 42 })).data).toEqual({ trackId: id, note: 42, removed: 1 });
    const sounds = (await pluginOf(id, "sampler")).sampler!.sounds;
    expect(sounds.some((s) => s.pitch === 42)).toBe(false);
    expect(sounds.some((s) => s.mode === "melodic")).toBe(true);
    // 42 now reaches the 808
    expect((await run("set_drum_pad", { trackId: id, note: 42, pan: 0.2 })).ok).toBe(true);
  });

  it("set_drum_lane parks a silenced pad at -48 dB and keeps the producer's level through edits", async () => {
    const id = await newTrack("drum");
    await run("set_drum_pad", { trackId: id, note: 36, gainDb: -6 });
    await run("set_drum_lane", { trackId: id, note: 36, mute: true });
    let kick = (await pluginOf(id, "sampler")).sampler!.sounds[0]!;
    expect(kick).toMatchObject({ gainDb: -48, silenced: true, userGainDb: -6 });
    expect((await trackById(id)).drumPads![0]!.gainDb).toBe(-48);       // drumPads keeps the raw live gain
    // a pan-only edit keeps the parked level (the engine fix), a level edit moves it
    await run("set_drum_pad", { trackId: id, note: 36, pan: 0.3 });
    kick = (await pluginOf(id, "sampler")).sampler!.sounds[0]!;
    expect(kick).toMatchObject({ gainDb: -48, userGainDb: -6, pan: 0.3 });
    await run("set_drum_pad", { trackId: id, note: 36, gainDb: 70 });
    expect((await pluginOf(id, "sampler")).sampler!.sounds[0]).toMatchObject({ gainDb: -48, userGainDb: 48 });
    // unmute restores it
    await run("set_drum_lane", { trackId: id, note: 36, mute: false });
    expect((await pluginOf(id, "sampler")).sampler!.sounds[0]).toMatchObject({ gainDb: 48, userGainDb: 48, silenced: false });
    // solo silences every other lane
    await run("set_drum_lane", { trackId: id, note: 38, solo: true });
    const sounds = (await pluginOf(id, "sampler")).sampler!.sounds;
    expect(sounds.filter((s) => s.silenced).map((s) => s.pitch)).toEqual([36, 39, 42, 46, 45, 47, 49]);
    expect(sounds.find((s) => s.pitch === 38)!.silenced).toBe(false);
  });

  it("a second sampler is not primary; pad commands address the first; load_builtin appends an empty one", async () => {
    const id = await newTrack("drum");
    await run("load_builtin", { trackId: id, type: "sampler" });
    const t = await trackById(id);
    const [first, second] = t.plugins!.filter((p) => p.type === "sampler");
    expect(first!.sampler!.primary).toBe(true);
    expect(second!.sampler).toMatchObject({ primary: false, sounds: [] });
    expect(second!.index).toBe(1);
  });

  it("file_peaks: deterministic per path, the bucket count the engine produces, relative paths refused", async () => {
    const a = await run("file_peaks", { path: "/kits/mosh-kit/kick.wav", buckets: 64 });
    const b = await run("file_peaks", { path: "/kits/mosh-kit/kick.wav", buckets: 64 });
    expect(a.data).toEqual(b.data);
    const data = a.data as { path: string; buckets: number; peaks: [number, number][] };
    expect(data.buckets).toBe(64);
    expect(data.peaks).toHaveLength(64);
    expect(data.peaks.every(([lo, hi]) => lo <= 0 && hi >= 0 && hi <= 1 && lo >= -1)).toBe(true);
    expect((await run("file_peaks", { path: "/kits/mosh-kit/snare.wav", buckets: 64 })).data).not.toEqual(a.data);
    // a closed hat is 2646 frames: asking for 4000 buckets gets one per frame
    expect((await run("file_peaks", { path: "/kits/mosh-kit/hat_closed.wav", buckets: 4000 })).data).toMatchObject({ buckets: 2646 });
    expect((await run("file_peaks", { path: "audio/kick.wav" })).error).toMatch(/file not found/);
  });
});

describe("instrument frames on the plugin_meters rail", () => {
  let frames: PluginMeterReading[][];
  let off: () => void;
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(5_000_000);
    frames = [];
    off = mockOnEvent("mosh_event", (e) => {
      const ev = e as { type: string; payload?: { plugins?: PluginMeterReading[] } };
      if (ev.type === "plugin_meters") frames.push(ev.payload?.plugins ?? []);
    });
  });
  afterEach(() => { off(); __resetMockForTests(); vi.useRealTimers(); });
  const of = <T extends PluginMeterReading>(type: string) => frames.map((f) => f.find((m) => m.type === type) as T | undefined);

  it("a 4OSC reports the keys held and struck by its clip, frame by frame, with a rising seq", async () => {
    const bass = (await snapshot()).tracks[1]!.id;     // the seed's MIDI bass line: E1 (28) at beat 0 for 1.5 beats
    await run("load_builtin", { trackId: bass, type: "4osc" });
    await run("set_transport", { action: "play" });
    await vi.advanceTimersByTimeAsync(34);
    const first = of<FourOscMeter>("4osc")[0]!;
    expect(first).toMatchObject({ trackId: bass, index: 0, type: "4osc", seq: 1, held: [28], struck: [28] });
    expect(first.itemId).toMatch(/^m\d+$/);
    expect(first.outDb).toBeGreaterThan(-100);
    await vi.advanceTimersByTimeAsync(34);
    expect(of<FourOscMeter>("4osc")[1]).toMatchObject({ seq: 2, held: [28], struck: [] });   // held, not struck again
    // beat 2 (1 s at 120 BPM) strikes E1 again
    await vi.advanceTimersByTimeAsync(1000);
    const struckAgain = of<FourOscMeter>("4osc").filter((m) => m?.struck.includes(28));
    expect(struckAgain.length).toBe(2);
    const seqs = of<FourOscMeter>("4osc").filter(Boolean).map((m) => m!.seq!);
    expect(seqs).toEqual(seqs.map((_, i) => i + 1));
    // stopping empties the rail with one empty frame
    await run("set_transport", { action: "stop" });
    expect(frames[frames.length - 1]).toEqual([]);
  });

  it("a bypassed instrument is not on the rail", async () => {
    const bass = (await snapshot()).tracks[1]!.id;
    await run("load_builtin", { trackId: bass, type: "4osc" });
    await run("bypass_plugin", { trackId: bass, index: 0, bypassed: true });
    await run("set_transport", { action: "play" });
    await vi.advanceTimersByTimeAsync(200);
    expect(of("4osc").some(Boolean)).toBe(false);
  });

  it("a sampler reports each drum hit once (largest velocity), what it adds, and rings out", async () => {
    const drums = (await snapshot()).tracks[0]!.id;    // kick 36 + hat 42 at beat 0
    await run("load_drum_kit", { trackId: drums });
    await run("set_transport", { action: "play" });
    await vi.advanceTimersByTimeAsync(34);
    const first = of<SamplerMeter>("sampler")[0]!;
    expect(first).toMatchObject({ type: "sampler", seq: 1, held: [36, 42] });
    expect(first.hits).toEqual([{ note: 36, vel: 112 / 127 }, { note: 42, vel: 64 / 127 }]);
    expect(first.outDb).toBeGreaterThan(-60);
    await vi.advanceTimersByTimeAsync(34);
    expect(of<SamplerMeter>("sampler")[1]!.hits).toEqual([]);     // the same hits never come twice
  });

  it("an audition reaches the rail while stopped (the panel's own taps), then the rail empties", async () => {
    const id = await newTrack("drum");          // no clips: the engine's clipless "sampler" path, velocity 0.75
    const r = await run("audition_note", { trackId: id, pitch: 38, velocity: 127, action: "blip" });
    expect(r.data).toMatchObject({ audible: true, path: "sampler", pitch: 38 });
    await vi.advanceTimersByTimeAsync(34);
    expect(of<SamplerMeter>("sampler")[0]).toMatchObject({ trackId: id, seq: 1, hits: [{ note: 38, vel: 0.75 }], held: [] });
    await vi.advanceTimersByTimeAsync(2000);    // the snare (0.22 s) has rung out
    expect(frames[frames.length - 1]).toEqual([]);
    const count = frames.length;
    await vi.advanceTimersByTimeAsync(500);
    expect(frames.length).toBe(count);          // and the stopped rail has gone quiet
    // a track without a sampler still answers the graceful headless shape
    const keys = (await snapshot()).tracks[2]!.id;
    expect((await run("audition_note", { trackId: keys, pitch: 60 })).data).toMatchObject({ audible: false, path: "none" });
  });
});
