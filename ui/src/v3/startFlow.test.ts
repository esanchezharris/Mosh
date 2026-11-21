import { describe, expect, it } from "vitest";
import type { LoopState, Plugin, Snapshot, Track } from "../types";
import {
  EMPTY_PROGRESS, beatClipOf, beatDone, checklistOpensAtLaunch, checklistSettled, firstOpenItem, hasOwnChain, isBeatTrackName,
  itemStates, loopCoversClip, micLaneOf, pickBackingTrack, pickContinueLead, PRESET_IDS, repairTarget, resolveIds, setKeyArgs,
  songReady, tempoStillConfirmed, voiceBlocker, voicePresetOf,
  type BeatLocal, type ChecklistProgress, type MicState, type StartIds,
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
  it("matches the template's Beat track as well as the older Backing name", () => {
    expect(pickBackingTrack([track("L"), track("X", { name: "Beat" })], loop())?.id).toBe("X");
  });

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

  // Review finding (high): Continue made the BEAT the Lead — a Takes lane on the beat,
  // Clean Lead on the beat, and every Keep landing on the beat track.
  const idle = loop({ engaged: false, leadTrackId: undefined, takesTrackId: undefined });
  const beatClip = [clip("beat", 0, 21.8)] as unknown as Track["clips"];
  it("never picks the Backing track, even when it is selected and first", () => {
    const s = snap({ tracks: [track("B", { name: "Backing", clips: beatClip }), track("V", { name: "Vocal" })], loop: idle });
    expect(pickContinueLead(s, "B")?.id).toBe("V");
  });
  it("prefers a vocal-named track over the selection", () => {
    const s = snap({ tracks: [track("K", { name: "Keys" }), track("V", { name: "Lead vox" })], loop: idle });
    expect(pickContinueLead(s, "K")?.id).toBe("V");
  });
  it("never picks a selected track that only holds a dropped beat: asks for a new Vocal instead", () => {
    const s = snap({ tracks: [track("D", { name: "beat.wav", clips: beatClip })], loop: idle });
    expect(pickContinueLead(s, "D")).toBeUndefined();
  });
  it("still takes an armed or empty plain track", () => {
    const armed = snap({ tracks: [track("D", { name: "beat.wav", clips: beatClip }), track("M", { name: "Mic 1", armed: true, clips: beatClip })], loop: idle });
    expect(pickContinueLead(armed, "D")?.id).toBe("M");
    const empty = snap({ tracks: [track("D", { name: "beat.wav", clips: beatClip }), track("E", { name: "Audio 2" })], loop: idle });
    expect(pickContinueLead(empty, "D")?.id).toBe("E");
  });
});

describe("repairTarget", () => {
  it("repairs a doubled Clean chain to Clean, never upgrading it to Tuned", () => {
    expect(repairTarget(track("L", { plugins: [...cleanChain(), ...cleanChain()] }))).toBe("clean");
  });
  it("repairs to Tuned only when a Tuned stage is there", () => {
    expect(repairTarget(track("L", { plugins: [stage(PRESET_IDS.tuned, 1, "eq")] }))).toBe("tuned");
    expect(repairTarget(track("L", { plugins: [...cleanChain(), ...tunedChain()] }))).toBe("tuned");
    expect(repairTarget(undefined)).toBe("clean");
  });
});

describe("tempoStillConfirmed / beatDone after ⌘Z of the tempo", () => {
  const backing = (tracks: Track[]) => tracks;
  const withBeat = (tempo: number, loopEnd = 21.8) => {
    const s = snap({ tracks: backing([track("B", { clips: [clip("c", 0, 21.8)] as unknown as Track["clips"] }), track("L"), track("T")]) });
    (s.session as { tempo: number }).tempo = tempo;
    (s.transport as { loopStart: number; loopEnd: number }).loopStart = 0;
    (s.transport as { loopStart: number; loopEnd: number }).loopEnd = loopEnd;
    return s;
  };
  it("is done while the session is still at the confirmed tempo", () => {
    const b = beat({ clipId: "c", confirmed: true, confirmedBpm: 88 });
    expect(tempoStillConfirmed(withBeat(88), b)).toBe(true);
    expect(beatDone(withBeat(88), IDS, b)).toBe(true);
  });
  it("is NOT done once the tempo was undone back to 120 (review finding)", () => {
    const b = beat({ clipId: "c", confirmed: true, confirmedBpm: 88 });
    expect(tempoStillConfirmed(withBeat(120), b)).toBe(false);
    expect(beatDone(withBeat(120), IDS, b)).toBe(false);
  });
  it("an adopted beat (continue mode) is done as found, without this page's loop range", () => {
    const b = beat({ clipId: "c", confirmed: true, adopted: true, confirmedBpm: 120 });
    expect(beatDone(withBeat(120, 8), IDS, b)).toBe(true);
    expect(beatDone(withBeat(120, 8), IDS, { ...b, adopted: false })).toBe(false);
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

// ── voiceBlocker ────────────────────────────────────────────────────────────────────────

describe("voiceBlocker", () => {
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
    expect(voiceBlocker(input())).toBeNull();
    expect(voiceBlocker(input({ lead: { plugins: tunedChain() }, takes: { plugins: tunedChain() } }))).toBeNull();
  });

  it("asks for a song before anything else when there is no vocal track", () => {
    expect(voiceBlocker({ ...input({ loop: { blockReason: "no input" }, mic: "denied" }), ids: { ...IDS, leadTrackId: null } })).toBe("Set up a song first");
    expect(voiceBlocker({ ...input(), snapshot: null })).toBe("Set up a song first");
  });

  it("before the phone remote exists the Lead itself takes the mic: armed and tuned is ready, un-armed is not", () => {
    const noTakes = { ...IDS, takesTrackId: null };
    expect(voiceBlocker(input({ lead: { armed: true, plugins: tunedChain() }, ids: noTakes }))).toBeNull();
    expect(voiceBlocker(input({ lead: { armed: false, plugins: tunedChain() }, ids: noTakes }))).toBe("Fix the microphone first");
    expect(voiceBlocker(input({ lead: { armed: true, plugins: [] }, ids: noTakes }))).toBe("Finish your voice");
  });

  it("says recording is unavailable for a loop blockReason, audioReady false, or a device error", () => {
    const msg = "Recording is unavailable on this Mac";
    expect(voiceBlocker(input({ loop: { blockReason: "no input" } }))).toBe(msg);
    expect(voiceBlocker(input({ session: { audioReady: false } }))).toBe(msg);
    expect(voiceBlocker(input({ session: { audioDeviceError: "Device lost" } }))).toBe(msg);
  });

  it("puts recording-unavailable ahead of the microphone and the voice", () => {
    expect(voiceBlocker(input({ loop: { blockReason: "x" }, mic: "denied", takes: { armed: false, plugins: [] } })))
      .toBe("Recording is unavailable on this Mac");
  });

  it.each(["denied", "restricted", "timed-out"] as const)("asks to fix the microphone when it is %s", (mic) => {
    expect(voiceBlocker(input({ mic }))).toBe("Fix the microphone first");
  });

  it("does not block on a microphone that is granted, undecided or unknown", () => {
    expect(voiceBlocker(input({ mic: "not-determined" }))).toBeNull();
    expect(voiceBlocker(input({ mic: "unknown" }))).toBeNull();
  });

  it("asks to fix the microphone when the Takes lane is not armed", () => {
    expect(voiceBlocker(input({ takes: { armed: false } }))).toBe("Fix the microphone first");
  });

  it("puts the microphone ahead of the voice", () => {
    expect(voiceBlocker(input({ mic: "denied", lead: { plugins: [] } }))).toBe("Fix the microphone first");
  });

  it("asks to finish the voice when Lead and Takes carry different presets", () => {
    expect(voiceBlocker(input({ takes: { plugins: tunedChain() } }))).toBe("Finish your voice");
    expect(voiceBlocker(input({ lead: { plugins: [] } }))).toBe("Finish your voice");
  });

  it.each([
    ["none", () => []],
    ["stacked", () => [...cleanChain(), ...cleanChain()]],
    ["lost-tuner", () => tunedChain().slice(1)],
    ["mixed", () => [...cleanChain(), ...tunedChain()]],
  ] as const)("asks to finish the voice when both carry %s", (_label, chain) => {
    expect(voiceBlocker(input({ lead: { plugins: chain() }, takes: { plugins: chain() } }))).toBe("Finish your voice");
  });

  it("skips the voice check when no chain is required", () => {
    expect(voiceBlocker(input({ lead: { plugins: [] }, takes: { plugins: tunedChain() }, chainNotRequired: true }))).toBeNull();
    // ...but never the microphone check.
    expect(voiceBlocker(input({ takes: { armed: false }, chainNotRequired: true }))).toBe("Fix the microphone first");
  });
});

// ── the checklist ───────────────────────────────────────────────────────────────────────

describe("checklist progress", () => {
  const p = (over: Partial<ChecklistProgress> = {}): ChecklistProgress => ({ ...EMPTY_PROGRESS, ...over });

  it("opens at launch until every item is done or skipped, or it is dismissed", () => {
    expect(checklistOpensAtLaunch(p())).toBe(true);
    expect(checklistOpensAtLaunch(p({ beat: "done", voice: "skipped" }))).toBe(true);
    expect(checklistOpensAtLaunch(p({ beat: "done", voice: "skipped", phone: "skipped" }))).toBe(false);
    expect(checklistOpensAtLaunch(p({ dismissed: true }))).toBe(false);
  });

  it("is settled only when nothing is left to do", () => {
    expect(checklistSettled(p({ beat: "done", voice: "done" }))).toBe(false);
    expect(checklistSettled(p({ beat: "done", voice: "done", phone: "skipped" }))).toBe(true);
  });

  it("opens the earliest item still to do", () => {
    expect(firstOpenItem(p())).toBe("beat");
    expect(firstOpenItem(p({ beat: "skipped" }))).toBe("voice");
    expect(firstOpenItem(p({ beat: "done", voice: "done" }))).toBe("phone");
    expect(firstOpenItem(p({ beat: "done", voice: "done", phone: "done" }))).toBeNull();
  });
});

describe("itemStates", () => {
  const base = {
    snapshot: snap({ tracks: [track("B"), track("L"), track("T")] }),
    ids: IDS,
    beat: beat(),
    progress: EMPTY_PROGRESS,
    voiceReady: false,
    phoneConnected: false,
  };

  it("starts with everything to do", () => {
    expect(itemStates(base)).toEqual({ beat: "todo", voice: "todo", phone: "todo" });
  });

  it("the beat is a fact about the open song: a remembered 'done' does not light it without a beat", () => {
    expect(itemStates({ ...base, progress: { ...EMPTY_PROGRESS, beat: "done" } }).beat).toBe("todo");
    const withBeat = snap({ tracks: [track("B", { clips: [clip("c", 0, 8)] as Track["clips"] }), track("L"), track("T")] });
    expect(itemStates({ ...base, snapshot: withBeat, beat: beat({ clipId: "c", confirmed: true }) }).beat).toBe("done");
  });

  it("a skipped beat shows skipped until a beat is actually in place", () => {
    const skipped = { ...EMPTY_PROGRESS, beat: "skipped" as const };
    expect(itemStates({ ...base, progress: skipped, beat: beat({ skipped: true }) }).beat).toBe("skipped");
    const drums = snap({ tracks: [track("D", { type: "drum", clips: [clip("d", 0, 4, "midi")] as Track["clips"] }), track("L")] });
    expect(itemStates({ ...base, snapshot: drums, progress: skipped }).beat).toBe("done");
  });

  it("the voice is done only while it was confirmed AND still checks out", () => {
    const confirmed = { ...EMPTY_PROGRESS, voice: "done" as const };
    expect(itemStates({ ...base, progress: confirmed, voiceReady: true }).voice).toBe("done");
    expect(itemStates({ ...base, progress: confirmed, voiceReady: false }).voice).toBe("todo");
    expect(itemStates({ ...base, voiceReady: true }).voice).toBe("todo");
  });

  it("the phone is done while connected, or once it has been paired before", () => {
    expect(itemStates({ ...base, phoneConnected: true }).phone).toBe("done");
    expect(itemStates({ ...base, progress: { ...EMPTY_PROGRESS, phone: "done" } }).phone).toBe("done");
    expect(itemStates({ ...base, progress: { ...EMPTY_PROGRESS, phone: "skipped" } }).phone).toBe("skipped");
  });
});

describe("resolveIds / micLaneOf", () => {
  const template = [track("B", { name: "Beat" }), track("L", { name: "Lead vocal", armed: true }), track("A", { name: "Ad-libs" })];
  const none: StartIds = { backingTrackId: null, leadTrackId: null, takesTrackId: null };

  it("finds the template's tracks by what they are when nothing is remembered: Lead vocal, never Ad-libs or Beat", () => {
    const s = snap({ tracks: template, loop: loop({ engaged: false, leadTrackId: "", takesTrackId: "" }) });
    expect(resolveIds(s, none)).toEqual({ backingTrackId: "B", leadTrackId: "L", takesTrackId: null });
    expect(micLaneOf(s, resolveIds(s, none))?.id).toBe("L");
  });

  it("still finds a song made before the rename (Backing + Vocal)", () => {
    const s = snap({ tracks: [track("B", { name: "Backing" }), track("V", { name: "Vocal" })], loop: null });
    expect(resolveIds(s, none)).toEqual({ backingTrackId: "B", leadTrackId: "V", takesTrackId: null });
    expect(isBeatTrackName(" BEAT ")).toBe(true);
    expect(isBeatTrackName("Backing")).toBe(true);
    expect(isBeatTrackName("Beat 2")).toBe(false);
  });

  it("counts the Takes lane only while the phone remote is set up on this Lead, and then it takes the mic", () => {
    const tracks = [...template, track("T", { name: "Lead vocal · Takes", armed: true })];
    const engaged = snap({ tracks, loop: loop({ leadTrackId: "L", takesTrackId: "T" }) });
    expect(resolveIds(engaged, { backingTrackId: "B", leadTrackId: "L", takesTrackId: null }).takesTrackId).toBe("T");
    expect(micLaneOf(engaged, resolveIds(engaged, none))?.id).toBe("T");
    const elsewhere = snap({ tracks, loop: loop({ leadTrackId: "A", takesTrackId: "T" }) });
    expect(resolveIds(elsewhere, { backingTrackId: "B", leadTrackId: "L", takesTrackId: null }).takesTrackId).toBeNull();
  });

  it("drops remembered tracks that no longer exist, and answers nothing for no snapshot", () => {
    const s = snap({ tracks: [track("X", { name: "Guitar", clips: [clip("g", 0, 4)] as Track["clips"] })], loop: null });
    expect(resolveIds(s, { backingTrackId: "gone", leadTrackId: "gone", takesTrackId: "gone" })).toEqual(none);
    expect(resolveIds(null, IDS)).toEqual(none);
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
