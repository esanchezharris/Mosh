import { describe, expect, it } from "vitest";
import type { LoopState, Plugin, Snapshot, Track } from "../types";
import {
  beatClipOf, beatDone, firstIncomplete, hasOwnChain, loopCoversClip, pickBackingTrack, pickContinueLead,
  pipStates, PRESET_IDS, readyBlocker, setKeyArgs, songReady, voicePresetOf,
  type BeatLocal, type MicState, type StartIds,
} from "./startFlow";

// ── factories ───────────────────────────────────────────────────────────────────────────

const track = (id: string, over: Partial<Track> = {}): Track =>
  ({ id, index: 0, name: id, type: "audio", volumeDb: 0, pan: 0, mute: false, solo: false, clips: [], plugins: [], ...over }) as unknown as Track;

let pluginIndex = 0;
const plugin = (over: Partial<Plugin> = {}): Plugin =>
  ({ index: pluginIndex++, name: "FX", type: "eq", enabled: true, external: false, isInstrument: false, params: [], ...over }) as unknown as Plugin;

const stage = (presetId: string, stageNo: number, type = "eq"): Plugin =>
  plugin({ type, preset: { id: presetId, name: presetId, revision: 1, stage: stageNo } });

/** The bundled Clean Lead: two tagged stages. */
const cleanChain = (): Plugin[] => [stage(PRESET_IDS.clean, 0, "eq"), stage(PRESET_IDS.clean, 1, "compressor")];
/** The bundled Tuned Lead: three tagged stages, one of them Mosh AutoTune. */
const tunedChain = (): Plugin[] => [
  stage(PRESET_IDS.tuned, 0, "moshAutoTune"), stage(PRESET_IDS.tuned, 1, "eq"), stage(PRESET_IDS.tuned, 2, "compressor"),
];

const clip = (id: string, start: number, length: number, type = "audio") => ({ id, name: id, start, length, type });

function loop(over: Partial<LoopState> = {}): LoopState {
  return {
    engaged: true,
    phase: "idle",
    leadTrackId: "L",
    takesTrackId: "T",
    transport: { recording: false, playing: false, positionSec: 0 },
    listening: { qn: 0, bar: 1, entryQn: null, leadQn: 8 },
    currentId: null,
    lastId: null,
    reviewId: null,
    auditionedId: null,
    contributions: [],
    phoneConnected: false,
    phoneSeenMs: 0,
    blockReason: "",
    ...over,
  } as LoopState;
}

function snap(over: {
  tracks?: Track[];
  loop?: LoopState | null;
  transport?: { loopStart: number; loopEnd: number };
  session?: Record<string, unknown>;
} = {}): Snapshot {
  return {
    tracks: over.tracks ?? [],
    loop: over.loop === undefined ? loop() : over.loop ?? undefined,
    transport: { playing: false, recording: false, looping: true, loopStart: 0, loopEnd: 8, ...(over.transport ?? {}) },
    session: { audioReady: true, ...(over.session ?? {}) },
  } as unknown as Snapshot;
}

const IDS: StartIds = { backingTrackId: "B", leadTrackId: "L", takesTrackId: "T" };
const beat = (over: Partial<BeatLocal> = {}): BeatLocal => ({ clipId: null, confirmed: false, skipped: false, ...over });

// ── voicePresetOf / hasOwnChain ─────────────────────────────────────────────────────────

describe("voicePresetOf", () => {
  it("is none for a missing track, an empty chain, or only untagged effects", () => {
    expect(voicePresetOf(undefined)).toBe("none");
    expect(voicePresetOf(track("L"))).toBe("none");
    expect(voicePresetOf(track("L", { plugins: [plugin(), plugin({ type: "reverb" })] }))).toBe("none");
  });

  it("reads the bundled Clean Lead (2 stages) as clean, alongside untagged effects too", () => {
    expect(voicePresetOf(track("L", { plugins: cleanChain() }))).toBe("clean");
    expect(voicePresetOf(track("L", { plugins: [...cleanChain(), plugin()] }))).toBe("clean");
  });

  it("reads the bundled Tuned Lead (3 stages incl. moshAutoTune) as tuned", () => {
    expect(voicePresetOf(track("L", { plugins: tunedChain() }))).toBe("tuned");
  });

  it("reads tuned stages whose AutoTune was dropped as lost-tuner", () => {
    const lost = tunedChain().filter((p) => p.type !== "moshAutoTune");
    expect(voicePresetOf(track("L", { plugins: lost }))).toBe("lost-tuner");
    // Same count as a healthy chain, but the AutoTune stage came back as a different type.
    const swapped = [stage(PRESET_IDS.tuned, 0, "pitchShifter"), stage(PRESET_IDS.tuned, 1), stage(PRESET_IDS.tuned, 2)];
    expect(voicePresetOf(track("L", { plugins: swapped }))).toBe("lost-tuner");
  });

  it("reads two tuned groups (6 stages, 2 AutoTunes) as stacked, not healthy", () => {
    expect(voicePresetOf(track("L", { plugins: [...tunedChain(), ...tunedChain()] }))).toBe("stacked");
  });

  it("reads 2 AutoTunes in only 3 tuned stages as stacked", () => {
    const twoTuners = [stage(PRESET_IDS.tuned, 0, "moshAutoTune"), stage(PRESET_IDS.tuned, 0, "moshAutoTune"), stage(PRESET_IDS.tuned, 2)];
    expect(voicePresetOf(track("L", { plugins: twoTuners }))).toBe("stacked");
  });

  it("reads 4 tuned stages with one AutoTune as stacked (more than the 3 a chain inserts)", () => {
    expect(voicePresetOf(track("L", { plugins: [...tunedChain(), stage(PRESET_IDS.tuned, 1)] }))).toBe("stacked");
  });

  it("reads two Clean Lead groups (4 stages) as stacked", () => {
    expect(voicePresetOf(track("L", { plugins: [...cleanChain(), ...cleanChain()] }))).toBe("stacked");
  });

  it("reads clean and tuned stages on one track as mixed", () => {
    expect(voicePresetOf(track("L", { plugins: [...cleanChain(), ...tunedChain()] }))).toBe("mixed");
    expect(voicePresetOf(track("L", { plugins: [stage(PRESET_IDS.clean, 0), stage(PRESET_IDS.tuned, 1)] }))).toBe("mixed");
  });
});

describe("hasOwnChain", () => {
  it("is false for a missing track or an empty chain", () => {
    expect(hasOwnChain(undefined)).toBe(false);
    expect(hasOwnChain(track("L"))).toBe(false);
  });
  it("ignores instruments and Mosh preset stages", () => {
    expect(hasOwnChain(track("L", { plugins: [plugin({ isInstrument: true, type: "4osc" }), ...tunedChain()] }))).toBe(false);
  });
  it("is true when any untagged effect is on the track", () => {
    expect(hasOwnChain(track("L", { plugins: [plugin({ type: "reverb" })] }))).toBe(true);
    expect(hasOwnChain(track("L", { plugins: [...cleanChain(), plugin({ type: "delay" })] }))).toBe(true);
  });
});

// ── track picking ───────────────────────────────────────────────────────────────────────

describe("pickBackingTrack", () => {
  it("matches the name Backing case-insensitively and ignoring surrounding spaces", () => {
    expect(pickBackingTrack([track("L"), track("X", { name: "  BACKING " })], loop())?.id).toBe("X");
    expect(pickBackingTrack([track("X", { name: "backing" })], null)?.id).toBe("X");
  });

  it("does not take a name that merely contains Backing, or the first audio track", () => {
    expect(pickBackingTrack([track("A", { name: "Vocal" }), track("X", { name: "Backing 2" })], loop())).toBeUndefined();
  });

  it("never picks the loop's Lead or Takes, even when named Backing", () => {
    const tracks = [track("L", { name: "Backing" }), track("T", { name: "Backing" }), track("B", { name: "Backing" })];
    expect(pickBackingTrack(tracks, loop())?.id).toBe("B");
    expect(pickBackingTrack(tracks.slice(0, 2), loop())).toBeUndefined();
  });

  it.each([
    ["a drum track", { type: "drum" }],
    ["a MIDI track", { type: "midi" }],
    ["a group", { isGroup: true, type: "group" }],
    ["a return", { isReturn: true }],
  ] as const)("never picks %s", (_label, over) => {
    expect(pickBackingTrack([track("X", { name: "Backing", ...(over as Partial<Track>) })], loop())).toBeUndefined();
  });
});

describe("pickContinueLead", () => {
  it("takes the engaged loop's Lead over the selection", () => {
    const s = snap({ tracks: [track("A"), track("L"), track("T")] });
    expect(pickContinueLead(s, "A")?.id).toBe("L");
  });
  it("falls back to the Booth's choice when the loop is not engaged", () => {
    const s = snap({ tracks: [track("A"), track("L"), track("T")], loop: loop({ engaged: false }) });
    expect(pickContinueLead(s, "A")?.id).toBe("A");
  });
});

// ── songReady ───────────────────────────────────────────────────────────────────────────

describe("songReady", () => {
  const tracks = [track("L"), track("T")];
  it("is true when the engaged loop names exactly this flow's Lead and Takes and both exist", () => {
    expect(songReady(snap({ tracks }), IDS)).toBe(true);
  });
  it("needs the loop engaged", () => {
    expect(songReady(snap({ tracks, loop: loop({ engaged: false }) }), IDS)).toBe(false);
    expect(songReady(snap({ tracks, loop: null }), IDS)).toBe(false);
    expect(songReady(null, IDS)).toBe(false);
  });
  it("needs the loop's ids to match the flow's", () => {
    expect(songReady(snap({ tracks, loop: loop({ leadTrackId: "X" }) }), IDS)).toBe(false);
    expect(songReady(snap({ tracks, loop: loop({ takesTrackId: "X" }) }), IDS)).toBe(false);
    expect(songReady(snap({ tracks }), { ...IDS, leadTrackId: null })).toBe(false);
    expect(songReady(snap({ tracks }), { ...IDS, takesTrackId: null })).toBe(false);
  });
  it("needs both tracks present in the snapshot", () => {
    expect(songReady(snap({ tracks: [track("L")] }), IDS)).toBe(false);
    expect(songReady(snap({ tracks: [track("T")] }), IDS)).toBe(false);
  });
});

// ── beat ────────────────────────────────────────────────────────────────────────────────

describe("beatClipOf / loopCoversClip", () => {
  it("prefers the clip this flow imported, else the first audio clip on Backing", () => {
    const backing = track("B", { clips: [clip("m", 0, 4, "midi"), clip("c1", 0, 4), clip("c2", 4, 4)] as Track["clips"] });
    const s = snap({ tracks: [backing] });
    expect(beatClipOf(s, IDS, beat({ clipId: "c2" }))?.id).toBe("c2");
    expect(beatClipOf(s, IDS, beat({ clipId: "gone" }))?.id).toBe("c1");
    expect(beatClipOf(s, { ...IDS, backingTrackId: null }, beat())).toBeUndefined();
  });

  it("covers a clip within 1e-3 on both edges and not beyond", () => {
    const c = { start: 2, length: 6 };
    expect(loopCoversClip(snap({ transport: { loopStart: 2.0009, loopEnd: 7.9991 } }), c)).toBe(true);
    expect(loopCoversClip(snap({ transport: { loopStart: 2.002, loopEnd: 8 } }), c)).toBe(false);
    expect(loopCoversClip(snap({ transport: { loopStart: 2, loopEnd: 7.998 } }), c)).toBe(false);
    expect(loopCoversClip(snap(), undefined)).toBe(false);
    expect(loopCoversClip(null, c)).toBe(false);
  });
});

describe("beatDone", () => {
  const backingWith = (...clips: ReturnType<typeof clip>[]) => track("B", { clips: clips as Track["clips"] });

  it("is true once skipped, whatever the snapshot says", () => {
    expect(beatDone(null, IDS, beat({ skipped: true }))).toBe(true);
  });

  it("is true when a drum track has clips, and not for an empty drum track", () => {
    expect(beatDone(snap({ tracks: [track("D", { type: "drum", clips: [clip("d", 0, 4)] as Track["clips"] })] }), IDS, beat()))
      .toBe(true);
    expect(beatDone(snap({ tracks: [track("D", { type: "drum" })] }), IDS, beat())).toBe(false);
  });

  it("is true for an imported clip that is confirmed and covered by the loop", () => {
    const s = snap({ tracks: [backingWith(clip("c", 0, 8))], transport: { loopStart: 0, loopEnd: 8 } });
    expect(beatDone(s, IDS, beat({ clipId: "c", confirmed: true }))).toBe(true);
  });

  it("tolerates loop edges within 1e-3 of the clip", () => {
    const s = snap({ tracks: [backingWith(clip("c", 1, 8))], transport: { loopStart: 1.0005, loopEnd: 8.9995 } });
    expect(beatDone(s, IDS, beat({ clipId: "c", confirmed: true }))).toBe(true);
  });

  it("is false until the tempo is confirmed", () => {
    const s = snap({ tracks: [backingWith(clip("c", 0, 8))], transport: { loopStart: 0, loopEnd: 8 } });
    expect(beatDone(s, IDS, beat({ clipId: "c", confirmed: false }))).toBe(false);
  });

  it("is false when the loop does not cover the clip", () => {
    const s = snap({ tracks: [backingWith(clip("c", 0, 8))], transport: { loopStart: 0, loopEnd: 4 } });
    expect(beatDone(s, IDS, beat({ clipId: "c", confirmed: true }))).toBe(false);
  });

  it("is false with no audio clip on Backing (a MIDI clip does not count)", () => {
    const s = snap({ tracks: [backingWith(clip("m", 0, 8, "midi"))], transport: { loopStart: 0, loopEnd: 8 } });
    expect(beatDone(s, IDS, beat({ confirmed: true }))).toBe(false);
  });
});

// ── readyBlocker ────────────────────────────────────────────────────────────────────────

describe("readyBlocker", () => {
  function input(over: {
    lead?: Partial<Track>;
    takes?: Partial<Track>;
    loop?: Partial<LoopState>;
    session?: Record<string, unknown>;
    mic?: MicState;
    chainNotRequired?: boolean;
    ids?: StartIds;
  } = {}) {
    const tracks = [
      track("L", { plugins: cleanChain(), ...over.lead }),
      track("T", { armed: true, plugins: cleanChain(), ...over.takes }),
    ];
    return {
      snapshot: snap({ tracks, loop: loop(over.loop), session: over.session }),
      ids: over.ids ?? IDS,
      mic: over.mic ?? ("granted" as MicState),
      chainNotRequired: over.chainNotRequired ?? false,
    };
  }

  it("is null when everything is in place (clean on both, or tuned on both)", () => {
    expect(readyBlocker(input())).toBeNull();
    expect(readyBlocker(input({ lead: { plugins: tunedChain() }, takes: { plugins: tunedChain() } }))).toBeNull();
  });

  it("says Setting up… before the song is ready, ahead of every other problem", () => {
    expect(readyBlocker(input({ loop: { engaged: false, blockReason: "no input" }, mic: "denied" }))).toBe("Setting up…");
    expect(readyBlocker({ ...input(), snapshot: null })).toBe("Setting up…");
  });

  it("says recording is unavailable for a loop blockReason, audioReady false, or a device error", () => {
    const msg = "Recording is unavailable on this Mac";
    expect(readyBlocker(input({ loop: { blockReason: "no input" } }))).toBe(msg);
    expect(readyBlocker(input({ session: { audioReady: false } }))).toBe(msg);
    expect(readyBlocker(input({ session: { audioDeviceError: "Device lost" } }))).toBe(msg);
  });

  it("puts recording-unavailable ahead of the microphone and the voice", () => {
    expect(readyBlocker(input({ loop: { blockReason: "x" }, mic: "denied", takes: { armed: false, plugins: [] } })))
      .toBe("Recording is unavailable on this Mac");
  });

  it.each(["denied", "restricted", "timed-out"] as const)("asks to fix the microphone when it is %s", (mic) => {
    expect(readyBlocker(input({ mic }))).toBe("Fix the microphone first");
  });

  it("does not block on a microphone that is granted, undecided or unknown", () => {
    expect(readyBlocker(input({ mic: "not-determined" }))).toBeNull();
    expect(readyBlocker(input({ mic: "unknown" }))).toBeNull();
  });

  it("asks to fix the microphone when the Takes lane is not armed", () => {
    expect(readyBlocker(input({ takes: { armed: false } }))).toBe("Fix the microphone first");
  });

  it("puts the microphone ahead of the voice", () => {
    expect(readyBlocker(input({ mic: "denied", lead: { plugins: [] } }))).toBe("Fix the microphone first");
  });

  it("asks to finish the voice when Lead and Takes carry different presets", () => {
    expect(readyBlocker(input({ takes: { plugins: tunedChain() } }))).toBe("Finish your voice");
    expect(readyBlocker(input({ lead: { plugins: [] } }))).toBe("Finish your voice");
  });

  it.each([
    ["none", () => []],
    ["stacked", () => [...cleanChain(), ...cleanChain()]],
    ["lost-tuner", () => tunedChain().slice(1)],
    ["mixed", () => [...cleanChain(), ...tunedChain()]],
  ] as const)("asks to finish the voice when both carry %s", (_label, chain) => {
    expect(readyBlocker(input({ lead: { plugins: chain() }, takes: { plugins: chain() } }))).toBe("Finish your voice");
  });

  it("skips the voice check when no chain is required", () => {
    expect(readyBlocker(input({ lead: { plugins: [] }, takes: { plugins: tunedChain() }, chainNotRequired: true }))).toBeNull();
    // ...but never the microphone check.
    expect(readyBlocker(input({ takes: { armed: false }, chainNotRequired: true }))).toBe("Fix the microphone first");
  });
});

// ── pips / re-entry ─────────────────────────────────────────────────────────────────────

describe("pipStates", () => {
  const base = {
    snapshot: snap({ tracks: [track("L"), track("T")] }),
    ids: IDS,
    beat: beat(),
    phone: { everConnected: false, skipped: false },
    voiceReady: false,
  };

  it("marks the step's pip current and the rest todo when nothing is done", () => {
    expect(pipStates({ ...base, step: "beat" })).toEqual({ beat: "current", voice: "todo", phone: "todo", record: "todo" });
    expect(pipStates({ ...base, step: "voice" })).toEqual({ beat: "todo", voice: "current", phone: "todo", record: "todo" });
    expect(pipStates({ ...base, step: "phone" })).toEqual({ beat: "todo", voice: "todo", phone: "current", record: "todo" });
  });

  it("lights Record as current on the ready card", () => {
    expect(pipStates({ ...base, step: "ready" }).record).toBe("current");
  });

  it("has no current pip on welcome or song", () => {
    for (const step of ["welcome", "song"] as const) {
      expect(Object.values(pipStates({ ...base, step }))).not.toContain("current");
    }
  });

  it("marks a pip done only once the singer has moved past it, and current wins over done", () => {
    const all = { ...base, beat: beat({ skipped: true }), voiceReady: true, phone: { everConnected: true, skipped: false } };
    // On Welcome nothing is behind the singer yet, whatever the facts say.
    expect(pipStates({ ...all, step: "welcome" })).toEqual({ beat: "todo", voice: "todo", phone: "todo", record: "todo" });
    // On the Beat step a ready voice is NOT shown as done: they haven't got there.
    expect(pipStates({ ...all, step: "beat" })).toEqual({ beat: "current", voice: "todo", phone: "todo", record: "todo" });
    // On the ready card everything passed is done.
    expect(pipStates({ ...all, step: "ready" })).toEqual({ beat: "done", voice: "done", phone: "done", record: "current" });
    // Passed but not done stays todo (a beat neither imported nor skipped).
    expect(pipStates({ ...all, beat: beat(), step: "voice" }).beat).toBe("todo");
  });
});

describe("firstIncomplete", () => {
  const tracks = [track("L"), track("T")];
  it("lands on welcome for no snapshot, an empty session, or a song that is not set up", () => {
    expect(firstIncomplete(null, IDS, beat(), true)).toBe("welcome");
    expect(firstIncomplete(snap({ tracks: [] }), IDS, beat(), true)).toBe("welcome");
    expect(firstIncomplete(snap({ tracks, loop: loop({ engaged: false }) }), IDS, beat(), true)).toBe("welcome");
  });
  it("lands on the first step whose facts are missing", () => {
    expect(firstIncomplete(snap({ tracks }), IDS, beat(), true)).toBe("beat");
    expect(firstIncomplete(snap({ tracks }), IDS, beat({ skipped: true }), false)).toBe("voice");
    expect(firstIncomplete(snap({ tracks }), IDS, beat({ skipped: true }), true)).toBe("ready");
  });
});

// ── setKeyArgs ──────────────────────────────────────────────────────────────────────────

describe("setKeyArgs", () => {
  it("takes the sharp name of a two-name label and lowercases the mode", () => {
    expect(setKeyArgs("C#/Db", "Major")).toEqual({ tonic: "C#", mode: "major" });
    expect(setKeyArgs("A#/Bb", "Minor")).toEqual({ tonic: "A#", mode: "minor" });
  });
  it("passes a single-name label through", () => {
    expect(setKeyArgs("A", "Minor")).toEqual({ tonic: "A", mode: "minor" });
    expect(setKeyArgs("C", "Major")).toEqual({ tonic: "C", mode: "major" });
  });
  it("writes nothing for Chromatic", () => {
    expect(setKeyArgs("C#/Db", "Chromatic")).toBeNull();
  });
  it.each(["H", "", "C#", "Db", "c"])("writes nothing for the unknown label %j", (label) => {
    expect(setKeyArgs(label, "Major")).toBeNull();
  });
});
