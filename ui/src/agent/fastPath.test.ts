import { describe, it, expect } from "vitest";
import { matchFastPath } from "./fastPath";

const ctx = (mode: "idle" | "recording" | "reviewing" = "idle") => ({ mode, tempo: 120, timeSigNum: 4 });
const cmds = (a: ReturnType<typeof matchFastPath>) => (a as { commands: { command: string; args?: Record<string, unknown> }[] }).commands;

describe("matchFastPath — global commands (any mode)", () => {
  it("maps 'play it' to a transport toggle", () => {
    const a = matchFastPath("play it", ctx());
    expect(a).toMatchObject({ kind: "commands" });
    expect(cmds(a)[0]).toMatchObject({ command: "set_transport", args: { action: "toggle" } });
  });
  it("maps 'from the top' to to_start", () => {
    expect(cmds(matchFastPath("take it from the top", ctx()))[0].args!.action).toBe("to_start");
  });
  it("maps 'undo' / 'save'", () => {
    expect(cmds(matchFastPath("undo that", ctx()))[0].command).toBe("undo");
    expect(cmds(matchFastPath("save it", ctx()))[0].command).toBe("save");
  });
});

describe("matchFastPath — record loop + state gating", () => {
  it("'put me in' enters record from idle", () => {
    expect(matchFastPath("put me in", ctx("idle"))).toMatchObject({ kind: "enterRecord" });
  });
  it("'keep that take' is keepTake only when reviewing", () => {
    expect(matchFastPath("keep that take", ctx("reviewing"))).toMatchObject({ kind: "keepTake" });
    expect(matchFastPath("keep that take", ctx("idle"))).toBeNull();
  });
  it("short 'yeah'/'nah' only resolve when reviewing", () => {
    expect(matchFastPath("yeah", ctx("reviewing"))).toMatchObject({ kind: "keepTake" });
    expect(matchFastPath("nah", ctx("reviewing"))).toMatchObject({ kind: "enterRecord" });
    expect(matchFastPath("yeah", ctx("idle"))).toBeNull();
  });
  it("'next take' / 'previous take' navigate in reviewing", () => {
    expect(matchFastPath("next take", ctx("reviewing"))).toMatchObject({ kind: "navTake", delta: 1 });
    expect(matchFastPath("go back a take", ctx("reviewing"))).toMatchObject({ kind: "navTake", delta: -1 });
  });
});

describe("matchFastPath — parametrized + safety", () => {
  it("extracts a bar number (digit or word)", () => {
    expect(matchFastPath("put me in at bar 8", ctx("idle"))).toMatchObject({ kind: "enterRecord", bar: 8 });
    expect(matchFastPath("put me in at eight", ctx("idle"))).toMatchObject({ kind: "enterRecord", bar: 8 });
  });
  it("falls through (null) on ambiguous / unknown utterances", () => {
    expect(matchFastPath("play the drums and add some reverb", ctx())).toBeNull();
    expect(matchFastPath("make the bass warmer", ctx())).toBeNull();
  });
});

describe("matchFastPath — beat-shaped asks route to generate_beat_recipe (FINDINGS.md #4)", () => {
  // "build me a lofi sketch" (live, packaged app) planned add_drum_pattern onto the EXISTING
  // Drums track, dropped its volume unasked, and left an empty "Keys" audio track — see
  // taskExec.test.ts's "guards from the 2026-09-23 real-app walkthrough" for that repro.
  // Routing the ask here instead means the free-form loop never gets a turn for it.
  it("'make me a beat' calls generate_beat_recipe with no mood", () => {
    const a = matchFastPath("make me a beat", ctx());
    expect(a).toMatchObject({ kind: "commands" });
    expect(cmds(a)[0]).toMatchObject({ command: "generate_beat_recipe", args: {} });
  });

  it("'build me a lofi sketch' calls generate_beat_recipe with mood 'lofi' — the exact ask that broke", () => {
    const a = matchFastPath("build me a lofi sketch", ctx());
    expect(cmds(a)[0]).toMatchObject({ command: "generate_beat_recipe", args: { mood: "lofi" } });
  });

  it("'make me a lofi drum loop at this tempo' passes the current tempo through", () => {
    const a = matchFastPath("make me a lofi drum loop at this tempo", ctx());
    expect(cmds(a)[0]).toMatchObject({ command: "generate_beat_recipe", args: { mood: "lofi", tempo: 120 } });
  });

  it("does not steal a tempo/mix ask about an EXISTING beat", () => {
    expect(matchFastPath("make the beat faster", ctx())).toBeNull();
    expect(matchFastPath("make the beat louder", ctx())).toBeNull();
  });

  it("never fires mid-take", () => {
    expect(matchFastPath("make me a beat", ctx("recording"))).toBeNull();
  });

  // Review of PR #740: the first cut captured ANY text between the verb and the noun, so
  // these asks about the EXISTING beat (or the transport) laid a whole new beat instead
  // of reaching the model. Each one is pinned null here.
  it.each([
    "write drums for the beat",
    "make a bassline for this beat",
    "write a melody over this beat",
    "produce vocals for my beat",
    "write lyrics for this beat",
    "make it sound like a lofi beat",
    "start the beat",
    "start beat",
    "make the beat",
    "make my beat",
    "make this a lofi beat",
    "make a drum fill for the groove",
    "write a hook to the beat",
    "make me a piano sketch",
    "make me a vocal sketch",
    "write me a love song sketch",
    "make me a beat for this song",
  ])("does not treat %j as a request for a NEW beat", (ask) => {
    expect(matchFastPath(ask, ctx())).toBeNull();
  });

  it.each([
    ["build me a lofi sketch", "lofi"],
    ["make a trap beat", "trap"],
    ["make me a chill groove", "chill"],
    ["make me a lo-fi beat", "lo fi"],
    ["produce a dark boom bap beat", "dark boom bap"],
    ["lay down a dusty jazzy groove", "dusty jazzy"],
    ["start a new r&b beat", "r b"],
  ])("routes %j to generate_beat_recipe with mood %j", (ask, mood) => {
    const a = matchFastPath(ask, ctx());
    expect(a).toMatchObject({ kind: "commands" });
    expect(cmds(a)[0]).toEqual({ command: "generate_beat_recipe", args: { mood } });
  });

  it("drops neutral words from the mood and still routes ('make me a new beat')", () => {
    expect(cmds(matchFastPath("make me a new beat", ctx()))[0]).toEqual({ command: "generate_beat_recipe", args: {} });
    expect(cmds(matchFastPath("make another beat", ctx()))[0]).toEqual({ command: "generate_beat_recipe", args: {} });
  });
});

describe("matchFastPath — a beat ask never retempos or rekeys a song that has material (PR #740 review)", () => {
  // The native program generate_beat_recipe compiles sets tempo, key AND time signature
  // (service/teardown/render/compile.py emits set_tempo/set_key/set_time_signature from
  // the recipe meta, and recipes/generate.py takes the requested tempo/key as that meta).
  const key = { tonic: "D", mode: "minor" };
  const withClips = (clipCount: number, timeSigNum = 4) => ({
    mode: "idle" as const, tempo: 87, timeSigNum, key,
    tracks: [{ id: "1", name: "Drums", clipCount }, { id: "2", name: "Keys", clipCount: 0 }],
  });

  it("an empty session lets the recipe choose its own tempo and key", () => {
    const a = matchFastPath("build me a lofi sketch", withClips(0));
    expect(cmds(a)[0]).toEqual({ command: "generate_beat_recipe", args: { mood: "lofi" } });
  });

  it("a session with any clip pins the recipe to the session's tempo and key", () => {
    const a = matchFastPath("build me a lofi sketch", withClips(1));
    expect(cmds(a)[0]).toEqual({
      command: "generate_beat_recipe", args: { mood: "lofi", tempo: 87, key: "D minor" },
    });
  });

  it("a caller that does not report clip counts is treated as having material", () => {
    const a = matchFastPath("make me a beat", {
      mode: "idle", tempo: 101, timeSigNum: 4, key, tracks: [{ id: "1", name: "Drums" }],
    });
    expect(cmds(a)[0]).toEqual({ command: "generate_beat_recipe", args: { tempo: 101, key: "D minor" } });
  });

  it("a non-4/4 song with material falls through to the model (the recipe always writes 4/4)", () => {
    expect(matchFastPath("build me a lofi sketch", withClips(2, 3))).toBeNull();
    // ...but an EMPTY 3/4 session is a fresh start, and the recipe may set its meter
    expect(matchFastPath("build me a lofi sketch", withClips(0, 3))).not.toBeNull();
  });
});

describe("matchFastPath — state-aware track ops (mute/solo by name)", () => {
  const T = [
    { id: "1", name: "Drums" },
    { id: "2", name: "Bass" },
    { id: "3", name: "Melody" },
    { id: "4", name: "Vocal" },
  ];
  const tctx = (mode: "idle" | "recording" | "reviewing" = "idle") => ({ mode, tempo: 120, timeSigNum: 4, tracks: T });
  const muted = (a: ReturnType<typeof matchFastPath>) =>
    cmds(a).filter((c) => c.command === "set_track_mute" && c.args!.mute === true).map((c) => c.args!.trackId).sort();

  it("'mute everything but the drums and bass' mutes only the complement", () => {
    expect(muted(matchFastPath("mute everything but the drums and bass", tctx()))).toEqual(["3", "4"]);
  });

  it("handles 'except' and a single keep-track", () => {
    expect(muted(matchFastPath("mute everything except the drums", tctx()))).toEqual(["2", "3", "4"]);
  });

  it("'solo the drums and bass' solos exactly those tracks", () => {
    const a = matchFastPath("solo the drums and bass", tctx());
    expect(cmds(a).map((c) => [c.command, c.args!.trackId])).toEqual([["set_track_solo", "1"], ["set_track_solo", "2"]]);
  });

  it("falls through when fuzzy track matching ties across multiple candidates", () => {
    const ambiguousCtx = () => ({
      mode: "idle" as const,
      tempo: 120,
      timeSigNum: 4,
      tracks: [
        { id: "1", name: "Vocal Lead" },
        { id: "2", name: "Vocal Bus" },
        { id: "3", name: "Drums" },
      ],
    });
    expect(matchFastPath("solo the vocal", ambiguousCtx())).toBeNull();
  });

  it("clears stale solos on non-target tracks before soloing the targets", () => {
    const soloCtx = () => ({
      mode: "idle" as const,
      tempo: 120,
      timeSigNum: 4,
      tracks: [
        { id: "1", name: "Drums", solo: false },
        { id: "2", name: "Bass", solo: false },
        { id: "3", name: "Melody", solo: true },
      ],
    });
    const a = matchFastPath("solo the drums and bass", soloCtx());
    expect(cmds(a).map((c) => [c.command, c.args!.trackId, c.args!.solo])).toEqual([
      ["set_track_solo", "3", false],
      ["set_track_solo", "1", true],
      ["set_track_solo", "2", true],
    ]);
  });

  it("'mute the vocals' mutes the fuzzy-matched track", () => {
    expect(muted(matchFastPath("mute the vocals", tctx()))).toEqual(["4"]);
  });

  it("falls through when a named track does not exist", () => {
    expect(matchFastPath("mute everything but the piano", tctx())).toBeNull();
    expect(matchFastPath("solo the strings", tctx())).toBeNull();
  });

  it("does not fire without a track list or while recording", () => {
    expect(matchFastPath("mute everything but the drums and bass", ctx())).toBeNull();
    expect(matchFastPath("solo the drums", tctx("recording"))).toBeNull();
  });
});

describe("matchFastPath — 'remember (that/my/I…) X' (AGT-MEM, M3)", () => {
  it("captures the remainder verbatim (case/punctuation preserved), defaulting to global scope", () => {
    const a = matchFastPath("remember that I like heavy 808s", ctx());
    expect(a).toMatchObject({ kind: "remember", text: "I like heavy 808s", scope: "global" });
  });

  it("accepts the 'my'/'I' and bare forms", () => {
    expect(matchFastPath("remember my favorite reverb is the plate", ctx())).toMatchObject({
      kind: "remember", text: "favorite reverb is the plate", scope: "global",
    });
    expect(matchFastPath("remember I always quantize to 16ths", ctx())).toMatchObject({
      kind: "remember", text: "always quantize to 16ths", scope: "global",
    });
    expect(matchFastPath("remember the hook needs a bigger lift", ctx())).toMatchObject({
      kind: "remember", text: "the hook needs a bigger lift", scope: "global",
    });
  });

  it("routes to project scope when the phrasing names this song/track/project", () => {
    expect(matchFastPath("remember that the bridge is too long for this song", ctx())).toMatchObject({
      kind: "remember", text: "the bridge is too long", scope: "project",
    });
    expect(matchFastPath("remember to double the vocal for this track", ctx())).toMatchObject({
      kind: "remember", text: "to double the vocal", scope: "project",
    });
    expect(matchFastPath("remember the intro should be shorter for this project", ctx())).toMatchObject({
      kind: "remember", text: "the intro should be shorter", scope: "project",
    });
  });

  it("strips a leading voice-prefix (\"hey moshi,\" / \"okay,\") before matching", () => {
    expect(matchFastPath("hey moshi, remember that I like the bass boosted", ctx())).toMatchObject({
      kind: "remember", text: "I like the bass boosted",
    });
    expect(matchFastPath("okay, remember I hate autotune", ctx())).toMatchObject({
      kind: "remember", text: "hate autotune",
    });
  });

  it("trims trailing punctuation", () => {
    expect(matchFastPath("remember that I like it loud!", ctx())).toMatchObject({ text: "I like it loud" });
  });

  it("never fires while recording (a stray word mid-take shouldn't write memory)", () => {
    expect(matchFastPath("remember that I like heavy 808s", ctx("recording"))).toBeNull();
  });

  it("does not fire on a bare 'remember' with nothing to remember", () => {
    expect(matchFastPath("remember", ctx())).toBeNull();
    expect(matchFastPath("remember that", ctx())).toBeNull();
  });

  it("takes precedence over the track-mute rules (a track named e.g. 'reverb' shouldn't steal it)", () => {
    const a = matchFastPath("remember the reverb should be shorter", ctx("idle"));
    expect(a).toMatchObject({ kind: "remember" });
  });
});

// The fast path owns ABSOLUTE tempo only — an utterance that names its own BPM needs
// no model to resolve. Relative tempo ("make it faster") deliberately stays with the
// agent loop, which owns the dosage rule (+8-12%) and says out loud what it chose;
// duplicating that constant here would give the same ask two different answers
// depending on which lane caught it.
describe("matchFastPath — absolute tempo", () => {
  const bpm = (text: string, mode: "idle" | "recording" | "reviewing" = "idle") => {
    const a = matchFastPath(text, ctx(mode));
    return a === null ? null : cmds(a)[0];
  };

  it("sets the tempo from every common numeric phrasing", () => {
    for (const [ask, want] of [
      ["set the tempo to 128", 128],
      ["set tempo 128", 128],
      ["change the tempo to 140", 140],
      ["bump the tempo to 140", 140],
      ["set the bpm to 96", 96],
      ["tempo 90", 90],
      ["128 bpm", 128],
      ["make it 128 bpm", 128],
      ["set it to 128 bpm", 128],
      ["put it at 90 bpm", 90],
      ["bump it to 140 bpm", 140],
    ] as const)
      expect(bpm(ask), ask).toMatchObject({ command: "set_tempo", args: { bpm: want } });
  });

  it("never invents a tempo from a number that is not one", () => {
    // The real hazard of a bare-number rule: these all carry digits and none is a tempo.
    // "808" as a set_tempo would be a silent, musical-sounding corruption of the session.
    expect(bpm("split the 808 clip at bar 3")).toBeNull();
    expect(bpm("drop the drums 3 db")).toBeNull();
    expect(matchFastPath("put me in at bar 8", ctx("idle"))).toMatchObject({ kind: "enterRecord", bar: 8 });
  });

  it("declines anything without an explicit number — that is the loop's dosage call", () => {
    for (const ask of ["make it faster", "make it slower", "speed it up", "slow it down",
                       "bring the tempo up", "set the tempo to something faster"])
      expect(bpm(ask), ask).toBeNull();
  });

  it("declines questions and out-of-range values rather than acting on them", () => {
    expect(bpm("whats the tempo")).toBeNull();
    expect(bpm("what is the tempo")).toBeNull();
    expect(bpm("is the tempo 128")).toBeNull();
    expect(bpm("set the tempo to 5")).toBeNull();
    expect(bpm("set the tempo to 5000")).toBeNull();
  });

  it("never changes tempo mid-take", () => {
    expect(bpm("set the tempo to 128", "recording")).toBeNull();
    expect(bpm("set the tempo to 128", "reviewing")).toMatchObject({ command: "set_tempo" });
  });
});
