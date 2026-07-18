import { describe, it, expect } from "vitest";
import {
  PRODUCER_KNOWLEDGE,
  retrieveCards,
  knowledgePromptSection,
  type KnowledgeCard,
} from "./knowledge";
import { buildSystemPrompt, systemPrompt, DEFAULT_RULES } from "./brainCore";
import { AGENT_COMMAND_MAP } from "./commands";
import type { Snapshot } from "../types";

const snap: Snapshot = {
  schemaVersion: 1,
  session: { sampleRate: 48000, tempo: 120, timeSigNumerator: 4, timeSigDenominator: 4, metronome: false, key: { tonic: "C", mode: "major" }, length: 16, editFile: "" },
  tracks: [
    { id: "17", index: 0, name: "Drums", type: "audio", volumeDb: 0, mute: false, solo: false,
      clips: [{ id: "101", name: "beat", type: "midi", start: 0, length: 4, offset: 0, hasRenderLayer: false }] },
  ],
  transport: { playing: false, recording: false, position: 0, looping: false, loopStart: 0, loopEnd: 0 },
  master: { volumeDb: 0, pan: 0 },
};

describe("PRODUCER_KNOWLEDGE store", () => {
  it("parses the committed JSONL store into well-formed cards", () => {
    // AG-KB1: expanded past the original 2-card seed to cover warp, drums,
    // lyrics, generative, mixer/sends, VST3, and recording/takes.
    // AG-KB-R2: deepened the same categories (mixer routing, plugin params/chain/
    // editor, recording arm/takes, multiplayer, undo/save, transport/loop, drum
    // kit/assign_sample ordering, warp confidence) plus common producer mistakes.
    // AG-KB3: added set_clip_gain/set_clip_mute — real main-existing commands
    // (commands.ts, since 2026-06-15) that AG-KB-R2 wrongly skipped believing
    // they were unmerged; see the note on the AG-KB-R2 describe block below.
    expect(PRODUCER_KNOWLEDGE.length).toBeGreaterThanOrEqual(48);
    for (const c of PRODUCER_KNOWLEDGE) {
      expect(typeof c.id).toBe("string");
      expect(c.id.length).toBeGreaterThan(0);
      expect(typeof c.topic).toBe("string");
      expect(typeof c.maps_to).toBe("string");
      expect(typeof c.plain).toBe("string");
      expect(typeof c.when).toBe("string");
      expect(Array.isArray(c.tags)).toBe(true);
    }
    // ids are unique — a card is one fact
    const ids = PRODUCER_KNOWLEDGE.map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("carries the two seed cards (onset/steering + re-imagine noise)", () => {
    const onset = PRODUCER_KNOWLEDGE.find((c) => /steer|color/i.test(c.maps_to));
    const noise = PRODUCER_KNOWLEDGE.find((c) => /\bnl\b|init_noise|noise/i.test(c.maps_to));
    expect(onset).toBeTruthy();
    expect(noise).toBeTruthy();
    expect(onset!.plain.toLowerCase()).toContain("first");
    expect(noise!.plain.toLowerCase()).toContain("original");
  });
});

describe("retrieveCards (deterministic tag/keyword match)", () => {
  it("surfaces the onset/steering card for 'starts strong then thins out'", () => {
    const got = retrieveCards("the beat starts strong then thins out and fades");
    expect(got.length).toBeGreaterThan(0);
    expect(/steer|color/i.test(got[0].maps_to)).toBe(true);
  });

  it("surfaces the re-imagine noise card for a re-imagine amount question", () => {
    const got = retrieveCards("should I turn the re-imagine noise up, the long re-imagine pulses");
    expect(got.length).toBeGreaterThan(0);
    expect(/noise|init_noise|\bnl\b/i.test(got[0].maps_to)).toBe(true);
  });

  it("returns nothing for a request no card is about (irrelevant card is worse than none)", () => {
    // Not a production request at all (no track/clip/mixer/drum/lyric/render/warp
    // vocabulary anywhere) — stays a true zero-overlap probe as the store grows.
    expect(retrieveCards("what's a good movie to watch this weekend")).toEqual([]);
  });

  it("returns nothing for an empty query", () => {
    expect(retrieveCards("")).toEqual([]);
  });

  it("is deterministic and honours the limit", () => {
    const q = "keep the re-imagine noise low so the groove and energy stay full";
    const a = retrieveCards(q, { limit: 1 });
    const b = retrieveCards(q, { limit: 1 });
    expect(a).toEqual(b);
    expect(a.length).toBe(1);
  });

  it("only scores against the supplied cards (swappable pool)", () => {
    const custom: KnowledgeCard[] = [
      { id: "x", topic: "t", maps_to: "quantize_notes", plain: "snap notes to the grid", when: "the timing feels loose", tags: ["quantize", "timing"] },
    ];
    const got = retrieveCards("my hats feel loose, quantize them", { cards: custom });
    expect(got.map((c) => c.id)).toEqual(["x"]);
  });
});

describe("knowledgePromptSection", () => {
  it("is empty when there are no cards (so the prompt is unchanged)", () => {
    expect(knowledgePromptSection([])).toBe("");
  });

  it("renders each card's control, plain sentence and when-to-reach", () => {
    const cards = retrieveCards("starts strong then thins out");
    const section = knowledgePromptSection(cards);
    expect(section).toContain(cards[0].maps_to);
    expect(section).toContain(cards[0].plain);
    expect(section.toLowerCase()).toContain("when");
  });
});

describe("buildSystemPrompt knowledge injection", () => {
  it("is byte-identical to the pre-knowledge prompt when no knowledge is passed", () => {
    // regression guard: GEPA / SFT / harvest callers pass no knowledge and must be unchanged
    const before = [
      // the exact shape buildSystemPrompt produced before this seam existed
      buildSystemPrompt(DEFAULT_RULES, snap),
    ][0];
    expect(before).not.toContain("Producer knowledge");
    expect(buildSystemPrompt(DEFAULT_RULES, snap, undefined, "")).toBe(before);
  });

  it("injects the knowledge block after the command catalog and before the rules", () => {
    const knowledge = knowledgePromptSection(retrieveCards("starts strong then thins out"));
    const p = buildSystemPrompt(DEFAULT_RULES, snap, undefined, knowledge);
    const catalogIdx = p.indexOf("create_track");
    const knowIdx = p.indexOf("Producer knowledge");
    const rulesIdx = p.indexOf("Rules:");
    expect(catalogIdx).toBeGreaterThan(-1);
    expect(knowIdx).toBeGreaterThan(catalogIdx);
    expect(rulesIdx).toBeGreaterThan(knowIdx);
  });
});

describe("systemPrompt query-aware knowledge", () => {
  it("stays byte-identical when called with no query", () => {
    expect(systemPrompt(snap)).toBe(buildSystemPrompt(DEFAULT_RULES, snap));
  });

  it("injects relevant producer knowledge when given the user's request", () => {
    const p = systemPrompt(snap, "why does the beat start strong then thin out?");
    expect(p).toContain("Producer knowledge");
    expect(p.toLowerCase()).toContain("first ~1 second");
  });

  it("adds no knowledge block for a request no card is about", () => {
    expect(systemPrompt(snap, "what's a good movie to watch this weekend")).not.toContain("Producer knowledge");
  });
});

describe("AG-KB1 expanded categories (warp/drums/lyrics/generative/mixer/vst3/recording)", () => {
  // Each query is phrased the way a producer would actually ask; it should surface
  // the card for the matching command as the top (highest-scoring) result. These
  // pin retrieval for the new cards the same way the seed-card tests above pin the
  // original two — a swap/typo in a command name or a dropped card would fail one
  // of these deterministically.
  const top = (q: string) => retrieveCards(q)[0]?.id;

  it("warp: fitting an imported loop to bars -> stretch_clip", () => {
    expect(top("how do I get this imported loop to fit exactly 4 bars")).toBe("warp-stretch-clip-bars");
  });

  it("warp: BPM-detect confidence -> detect_clip_bpm", () => {
    expect(top("the bpm detector doesn't seem sure about this sample's tempo")).toBe(
      "warp-detect-clip-bpm-confidence",
    );
  });

  it("drums: lane-string pattern syntax -> add_drum_pattern", () => {
    expect(top("how do I write a whole kick and snare pattern in one go with hits and rests")).toBe(
      "drum-pattern-lane-syntax",
    );
  });

  it("drums: beatboxed take -> sketch_beatbox", () => {
    expect(top("I beatboxed a drum idea into the mic, can it become an editable clip")).toBe(
      "drum-sketch-beatbox",
    );
  });

  it("lyrics: mumbled take -> build_skeleton_from_clip", () => {
    expect(top("turn my mumbled take into a syllable flow skeleton")).toBe(
      "lyrics-build-skeleton-from-clip",
    );
  });

  it("lyrics: fill every gap -> complete_lyrics", () => {
    expect(top("fill every gap in my lyric sheet at once")).toBe("lyrics-complete-lyrics");
  });

  it("lyrics: rhyme lookup -> get_rhymes", () => {
    expect(top("I need rhymes for a specific word")).toBe("lyrics-get-rhymes");
  });

  it("generative: re-imagine vs transform -> create_render_layer modes", () => {
    expect(top("should I re-imagine this or transform it into a violin")).toBe(
      "generative-create-render-layer-modes",
    );
  });

  it("generative: loose instruction -> compile_render", () => {
    expect(top("just tell it to make this lo-fi in plain language")).toBe("generative-compile-render");
  });

  it("mixer: shared reverb across tracks -> sends/returns", () => {
    expect(top("how do I add a shared reverb send across multiple tracks")).toBe("mixer-sends-returns");
  });

  it("vst3: hosting a synth -> load_plugin", () => {
    expect(top("how do I add a hosted synth plugin to a track")).toBe("vst3-load-plugin");
  });

  it("recording: comparing stacked takes -> take lanes", () => {
    expect(top("I recorded three takes of this line, how do I compare them")).toBe("recording-take-lanes");
  });

  it("every new card's maps_to names a real AGENT_COMMANDS entry or an accurate UI-only control", () => {
    // Guards against inventing a command: every card that names a bare command
    // token in maps_to (snake_case, no spaces) must resolve to AGENT_COMMANDS.
    const bare = PRODUCER_KNOWLEDGE.filter((c) => /^[a-z][a-z0-9_]*$/.test(c.maps_to)).map((c) => c.maps_to);
    for (const name of bare) {
      expect(AGENT_COMMAND_MAP.has(name)).toBe(true);
    }
    expect(bare.length).toBeGreaterThan(0);
  });
});

describe("AG-KB-R2 expanded categories (mixer/plugins/recording/multiplayer/history/transport/drums/warp/mistakes)", () => {
  // Round 2: deepens coverage of MAIN-EXISTING commands only (no export-range args,
  // no export_stems — those aren't agent-callable commands on main). set_clip_gain/
  // set_clip_mute cards were originally skipped here on the mistaken belief they
  // lived in unmerged owner-review PRs; they're real main-existing commands
  // (commands.ts, since 2026-06-15) — see the AG-KB3 block below. Same pin-the-
  // retrieval pattern as the AG-KB1 block above: each query is how a producer
  // would actually ask, and should surface the matching new card as the top result.
  const top = (q: string) => retrieveCards(q)[0]?.id;

  it("mixer: hearing one track alone -> solo vs mute", () => {
    expect(top("how do I hear just this one track without changing the mix")).toBe("mixer-solo-mute");
  });

  it("mixer: send landed on the wrong return -> bus is a number, not a name", () => {
    expect(top("my send keeps landing on the wrong bus, I typed the name not a number")).toBe(
      "mixer-bus-send-numbering",
    );
  });

  it("plugins: raw Hz/dB value did nothing -> set_plugin_param is normalized 0-1", () => {
    expect(top("I tried setting a plugin's cutoff to 500 and nothing sensible happened")).toBe(
      "plugin-param-normalized-range",
    );
  });

  it("plugins: quick A/B without deleting -> bypass_plugin vs remove_plugin", () => {
    expect(top("I want to quickly compare a plugin on and off without deleting it")).toBe(
      "plugin-bypass-vs-remove",
    );
  });

  it("plugins: Mosh's own effect vs a specific owned plugin -> load_builtin vs load_plugin", () => {
    expect(top("should I use one of Mosh's own built-in effects or a specific plugin I already own")).toBe(
      "plugin-builtin-vs-hosted",
    );
  });

  it("recording: armed but can't hear input -> arm_track vs set_input_monitor", () => {
    expect(top("the track is armed but I can't hear myself while recording")).toBe(
      "recording-arm-vs-monitor",
    );
  });

  it("recording: throw out a bad take immediately -> stop_recording discard vs keep_take", () => {
    expect(top("that last take was bad the second I stopped, just throw it away")).toBe(
      "recording-discard-vs-keep",
    );
  });

  it("multiplayer: a friend joining live -> session basics", () => {
    expect(top("can my friend join and work on this project with me live")).toBe(
      "multiplayer-session-basics",
    );
  });

  it("history: does undo catch a plugin load, not just notes -> undo/redo scope", () => {
    expect(top("will undo actually catch a plugin I just loaded, not just note edits")).toBe(
      "history-undo-scope",
    );
  });

  it("session: save before a risky plugin load -> save habit", () => {
    expect(top("should I save before loading this risky plugin")).toBe("session-save-habit");
  });

  it("transport: repeat a spot instead of reseeking -> loop region", () => {
    expect(top("I keep manually seeking back to the same spot, can playback just repeat it")).toBe(
      "transport-loop-region",
    );
  });

  it("transport: jump to the very end -> to_start/to_end vs position", () => {
    expect(top("how do I jump straight to the very end of the session")).toBe("transport-seek-actions");
  });

  it("drums: a drum track lost its kit -> load_drum_kit vs set_track_type", () => {
    expect(top("my drum track has no kit loaded, how do I get sounds back on the pads")).toBe(
      "drum-kit-track-type-overlap",
    );
  });

  it("drums: worried a pattern will overwrite a melodic sampler -> assign_sample ordering", () => {
    expect(top("will laying a drum pattern replace the 808 sampler I already assigned")).toBe(
      "assign-sample-melodic-order",
    );
  });

  it("warp: bar count or a seconds length for stretch_clip's target", () => {
    expect(top("should I give stretch_clip a bar count or an exact seconds length")).toBe(
      "warp-length-vs-bars-arg",
    );
  });

  it("warp: checking a tempo guess before committing to a stretch", () => {
    expect(top("I don't know this loop's original tempo, can I check before stretching it")).toBe(
      "warp-detect-before-stretch",
    );
  });

  it("mistake: audio clip went silent after an instrument was added to its track", () => {
    expect(top("my audio clip went completely silent right after I added a synth to its track")).toBe(
      "mistake-instrument-silences-track-audio",
    );
  });

  it("mistake: a follow-up plugin tweak hit the wrong plugin after a reorder", () => {
    expect(top("what happens to my next plugin edit's index if I reorder a plugin first")).toBe(
      "mistake-reorder-changes-indices",
    );
  });
});

describe("AG-KB3: set_clip_gain / set_clip_mute (real main-existing commands, wrongly skipped by AG-KB-R2)", () => {
  // set_clip_gain and set_clip_mute are real agent-callable commands on main
  // (commands.ts, since 2026-06-15) — AG-KB-R2 wrongly skipped cards for them
  // believing they lived in unmerged owner-review PRs. Same pin-the-retrieval
  // pattern as the AG-KB1/AG-KB-R2 blocks above.
  const top = (q: string) => retrieveCards(q)[0]?.id;

  it("clips: trimming one clip's own level, not the whole track fader -> set_clip_gain", () => {
    expect(top("this one clip is quieter than the others on the track, can I trim just that clip's level")).toBe(
      "clip-gain-trim-one-clip",
    );
  });

  it("clips: silencing a single clip without muting the whole track -> set_clip_mute", () => {
    expect(top("I want to silence just this one clip without muting the whole track")).toBe(
      "clip-mute-one-clip",
    );
  });
});

describe("AG-KB4: tempo / bus / track-routing / stem-export (CONF-CATALOG newly agent-callable commands)", () => {
  // These commands became agent-callable via CONF-CATALOG: set_tempo/set_time_signature
  // were already agent-callable but had no card; remove_bus/rename_bus, set_track_output/
  // list_track_outputs, and export_stems/export_audio are newly in AGENT_COMMANDS. Same
  // pin-the-retrieval pattern as the AG-KB1/AG-KB-R2/AG-KB3 blocks above.
  const top = (q: string) => retrieveCards(q)[0]?.id;

  it("transport: changing the whole song's tempo/meter -> set_tempo / set_time_signature", () => {
    expect(top("how do I change the whole song tempo and time signature, not just one loop's speed")).toBe(
      "transport-tempo-time-signature-range",
    );
  });

  it("mixer: an empty bus needs deleting or relabeling -> remove_bus / rename_bus", () => {
    expect(top("a bus I created is empty, how do I get rid of it or rename it")).toBe(
      "mixer-remove-rename-bus",
    );
  });

  it("mixer: routing a track's output into another track or a device -> set_track_output / list_track_outputs", () => {
    expect(top("I want a track to output into another track as a submix instead of the master")).toBe(
      "mixer-track-output-routing",
    );
  });

  it("export: stems for a mastering engineer vs the final mixdown -> export_stems / export_audio", () => {
    expect(top("I need every track as its own file for the mastering engineer, not just the final mix")).toBe(
      "export-stems-vs-mixdown",
    );
  });
});
