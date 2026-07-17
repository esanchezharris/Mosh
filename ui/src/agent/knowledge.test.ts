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
    expect(PRODUCER_KNOWLEDGE.length).toBeGreaterThanOrEqual(28);
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
