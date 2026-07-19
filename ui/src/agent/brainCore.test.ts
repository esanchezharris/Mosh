import { describe, it, expect } from "vitest";
import { systemPrompt, parseReply } from "./brainCore";
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
