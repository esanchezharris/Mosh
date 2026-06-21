import { describe, it, expect } from "vitest";
import { systemPrompt, parseReply } from "./brainCore";
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
});
