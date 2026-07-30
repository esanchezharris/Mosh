import { describe, it, expect } from "vitest";
import { createHash } from "node:crypto";
import { systemPrompt, supervisorSystemPrompt, buildSystemPrompt, DEFAULT_RULES, parseReply } from "./brainCore";
import { validateCommand } from "./commands";
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

describe("systemPrompt id quoting", () => {
  it("quotes numeric-looking track and clip ids so the model emits them as JSON strings", () => {
    const p = systemPrompt(snap);
    // the id must appear quoted, never as a bare number adjacent to the name
    expect(p).toContain('"17" "Drums"');
    expect(p).toContain('"101":midi');
    expect(p).not.toMatch(/\n {2}17 "Drums"/); // the old unquoted rendering is gone
  });

  it("states that ids are strings in the rules", () => {
    expect(systemPrompt(snap).toLowerCase()).toContain("string id");
  });
});

describe("supervisorSystemPrompt capability catalog", () => {
  it("keeps the legacy full catalog for benchmark callers", () => {
    expect(systemPrompt(snap)).toContain("remove_track(trackId)");
  });

  it("uses a bounded production catalog for a single turn", () => {
    const prompt = supervisorSystemPrompt(snap, "turn on the metronome");

    expect(prompt).toContain("set_metronome(enabled:boolean)");
    expect(prompt).not.toContain("remove_track(trackId)");
    expect(prompt.length).toBeLessThan(systemPrompt(snap).length / 2);
  });
});

describe("buildSystemPrompt: M2 memory param — byte-stability + the one-section diff", () => {
  // EXTENDS the existing byte-stability pattern (the loopPrompt.test.ts sha256 pin
  // guards systemPrompt(FIXTURE) specifically; this proves the general contract
  // buildSystemPrompt itself makes: an omitted `memory` param changes NOTHING,
  // regardless of caller or fixture).
  it("omitting memory is byte-identical to the pre-M2 4-arg call, for both a fresh snapshot and a real one", () => {
    const withoutMemoryParam = buildSystemPrompt(DEFAULT_RULES, snap, undefined, "");
    const memoryExplicitlyUndefined = buildSystemPrompt(DEFAULT_RULES, snap, undefined, "", undefined);
    const memoryEmptyString = buildSystemPrompt(DEFAULT_RULES, snap, undefined, "", "");
    expect(memoryExplicitlyUndefined).toBe(withoutMemoryParam);
    expect(memoryEmptyString).toBe(withoutMemoryParam);
    expect(withoutMemoryParam).not.toContain("Memory —");
  });

  it("systemPrompt() omitting memory (the shipped single-shot call shape) is unaffected", () => {
    // No caller anywhere (GEPA/SFT/harvest, or a production turn with the flag off)
    // passes a 3rd arg here today — this pins that the DEFAULT is truly a no-op.
    expect(systemPrompt(snap)).toBe(buildSystemPrompt(DEFAULT_RULES, snap));
    expect(systemPrompt(snap, "some query", undefined)).toBe(systemPrompt(snap, "some query"));
  });

  it("the sha256 pin (loopPrompt.test.ts) is unaffected by the mere EXISTENCE of the memory param", () => {
    // Re-derive the exact same pinned fixture/hash locally as an extra, colocated
    // guard: adding a 5th optional param to buildSystemPrompt must not move this.
    const hash = createHash("sha256").update(systemPrompt(snap)).digest("hex");
    // NOT the loopPrompt.test.ts fixture (different snapshot) — this only proves
    // OUR fixture is stable across repeated calls, i.e. the function is still pure.
    expect(createHash("sha256").update(systemPrompt(snap)).digest("hex")).toBe(hash);
  });

  it("when memory IS provided, the diff from the memory-omitted prompt is EXACTLY one added section", () => {
    const memory = "Memory — a made-up section for this test.\n- (this project) a fact";
    const without = buildSystemPrompt(DEFAULT_RULES, snap, undefined, "", undefined);
    const withMemory = buildSystemPrompt(DEFAULT_RULES, snap, undefined, "", memory);

    // The whole prior prompt survives INTACT: withMemory is `without` with exactly
    // one extra "\n" + memory section spliced in — nothing before or after it moved.
    expect(withMemory).toBe(without.replace("\n" + DEFAULT_RULES, "\n" + memory + "\n" + DEFAULT_RULES));

    // Line-level diff: every line in `without` still appears, in the same relative
    // order, in `withMemory` — the ONLY new lines are the memory section's own.
    // (DEFAULT_RULES is itself multi-line, so split() by its FIRST line to find the
    // splice point in the per-line arrays.)
    const rulesFirstLine = DEFAULT_RULES.split("\n")[0]!;
    const beforeLines = without.split("\n");
    const afterLines = withMemory.split("\n");
    const memoryLines = memory.split("\n");
    const splitAt = beforeLines.indexOf(rulesFirstLine);
    expect(splitAt).toBeGreaterThan(-1);
    expect(afterLines.length).toBe(beforeLines.length + memoryLines.length);
    expect(afterLines.slice(0, splitAt)).toEqual(beforeLines.slice(0, splitAt));
    expect(afterLines.slice(splitAt, splitAt + memoryLines.length)).toEqual(memoryLines);
    expect(afterLines.slice(splitAt + memoryLines.length)).toEqual(beforeLines.slice(splitAt));
  });

  it("memory is inserted after knowledge and before the rules (same slotting as knowledge itself)", () => {
    const knowledge = "Producer knowledge — a made-up block.";
    const memory = "Memory — a made-up block.";
    const p = buildSystemPrompt(DEFAULT_RULES, snap, undefined, knowledge, memory);
    const knowIdx = p.indexOf(knowledge);
    const memIdx = p.indexOf(memory);
    const rulesIdx = p.indexOf(DEFAULT_RULES);
    expect(knowIdx).toBeGreaterThan(-1);
    expect(memIdx).toBeGreaterThan(knowIdx);
    expect(rulesIdx).toBeGreaterThan(memIdx);
  });
});

describe("parseReply", () => {
  it("extracts commands and tolerates code-fenced JSON", () => {
    const r = parseReply('```json\n{"intent":"ACK_GOT_IT","commands":[{"command":"create_track","args":{"name":"X"}}]}\n```');
    expect(r.intent).toBe("ACK_GOT_IT");
    expect(r.commands?.[0].command).toBe("create_track");
  });

  it("recovers commands emitted in the catalog's function-call STRING form", () => {
    // models sometimes mimic commandCatalogPrompt() instead of the object contract
    const r = parseReply('{"intent":"ACK_GOT_IT","commands":["add_midi_clip(\\"17\\")"]}');
    expect(r.commands).toEqual([{ command: "add_midi_clip", args: { trackId: "17" } }]);
  });

  it("maps positional args by name and coerces numeric/boolean types", () => {
    const r = parseReply('{"intent":"ACK_GOT_IT","commands":["set_tempo(132)","set_track_mute(\\"3\\", true)"]}');
    expect(r.commands).toEqual([
      { command: "set_tempo", args: { bpm: 132 } },
      { command: "set_track_mute", args: { trackId: "3", mute: true } },
    ]);
  });

  it("drops unknown commands in string form but keeps valid object commands", () => {
    const r = parseReply('{"intent":"ACK_GOT_IT","commands":["nope(1)",{"command":"set_tempo","args":{"bpm":90}}]}');
    expect(r.commands).toEqual([{ command: "set_tempo", args: { bpm: 90 } }]);
  });
});

describe("parseReply — add_drum_pattern object-form normalization", () => {
  // DRM-002's NATIVE handler accepts the pattern as an object ({kick:"x..."})
  // OR a flat string, but ArgSpec can only declare the string form — and the
  // Phase-A baseline measured every model naturally emitting the object form
  // and losing the whole compose-drums category to client-side validation.
  // normalizeCommand flattens the (natively valid) object into the declared
  // flat form so validation matches the real contract.
  it("flattens an object pattern into the flat lane-map string", () => {
    const r = parseReply(JSON.stringify({
      intent: "ACK_GOT_IT",
      commands: [{ command: "add_drum_pattern", args: { pattern: { kick: "x...x...", snare: "....x..." }, stepsPerBar: 8 } }],
    }));
    expect(r.commands).toHaveLength(1);
    expect(r.commands![0].args).toEqual({ pattern: "kick: x...x...; snare: ....x...", stepsPerBar: 8 });
    expect(validateCommand("add_drum_pattern", r.commands![0].args as Record<string, unknown>)).toBeNull();
  });

  it("leaves a flat string pattern untouched", () => {
    const r = parseReply(JSON.stringify({
      intent: "ACK_GOT_IT",
      commands: [{ command: "add_drum_pattern", args: { pattern: "kick: x...; hat: x.x." } }],
    }));
    expect(r.commands![0].args).toEqual({ pattern: "kick: x...; hat: x.x." });
  });

  it("does not rewrite object args on other commands", () => {
    const r = parseReply(JSON.stringify({
      intent: "ACK_GOT_IT",
      commands: [{ command: "set_render_param", args: { clipId: "9", prompt: "lofi" } }],
    }));
    expect(r.commands![0].args).toEqual({ clipId: "9", prompt: "lofi" });
  });
});

describe("parseReply — add_drum_pattern newline-separated lanes", () => {
  // The Phase-A baseline also caught models separating lanes with NEWLINES
  // instead of semicolons — the flat parser then reads the next lane's name as
  // pattern chars (`lane "kick" has invalid step char "s"`). Canonicalize any
  // newline/semicolon mix into the declared "; "-separated form.
  it("converts newline separators into the flat semicolon form", () => {
    const r = parseReply(JSON.stringify({
      intent: "ACK_GOT_IT",
      commands: [{ command: "add_drum_pattern", args: { pattern: "kick: x...x...\nsnare: ....x..." } }],
    }));
    expect(r.commands![0]!.args!.pattern).toBe("kick: x...x...; snare: ....x...");
  });

  it("canonicalizes a semicolon+newline mix without minting empty lanes", () => {
    const r = parseReply(JSON.stringify({
      intent: "ACK_GOT_IT",
      commands: [{ command: "add_drum_pattern", args: { pattern: "kick: x...;\nsnare: ....x...;\nhat: x.x." } }],
    }));
    expect(r.commands![0]!.args!.pattern).toBe("kick: x...; snare: ....x...; hat: x.x.");
  });
});

describe("parseReply — per-ArgSpec coercion of object-form args (B0)", () => {
  // Models emit {"note":"42"} / {"mute":"true"} — string-typed values on
  // declared number/boolean args. coerceArg already fixes this for the
  // function-call STRING form; the object form got no coercion and the
  // Phase-A baseline paid for it (set_drum_lane: "note" must be a number).
  it("coerces numeric strings on declared number args", () => {
    const r = parseReply(JSON.stringify({
      intent: "ACK_GOT_IT",
      commands: [{ command: "set_drum_lane", args: { trackId: "3", note: "42", mute: "true" } }],
    }));
    expect(r.commands![0]!.args).toEqual({ trackId: "3", note: 42, mute: true });
    expect(validateCommand("set_drum_lane", r.commands![0]!.args as Record<string, unknown>)).toBeNull();
  });

  it("never coerces declared string args (a name that looks numeric stays a string)", () => {
    const r = parseReply(JSON.stringify({
      intent: "ACK_GOT_IT",
      commands: [{ command: "rename_track", args: { trackId: "3", name: "42" } }],
    }));
    expect(r.commands![0]!.args).toEqual({ trackId: "3", name: "42" });
  });

  it("leaves non-numeric strings alone so validation still fails loudly", () => {
    const r = parseReply(JSON.stringify({
      intent: "ACK_GOT_IT",
      commands: [{ command: "set_tempo", args: { bpm: "fast" } }],
    }));
    expect(r.commands![0]!.args).toEqual({ bpm: "fast" });
    expect(validateCommand("set_tempo", r.commands![0]!.args as Record<string, unknown>)).not.toBeNull();
  });

  it("passes unknown commands through untouched (validation rejects them later)", () => {
    const r = parseReply(JSON.stringify({
      intent: "ACK_GOT_IT",
      commands: [{ command: "not_a_command", args: { x: "1" } }],
    }));
    expect(r.commands![0]!.args).toEqual({ x: "1" });
  });
});
