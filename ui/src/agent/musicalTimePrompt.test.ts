import { describe, expect, it } from "vitest";
import { systemPrompt } from "./brainCore";
import { commandCatalogPrompt } from "./commands";
import { buildLoopSystemPrompt } from "./loop/loopPrompt";
import { SMALL_MODEL_RULES, smallModelCatalogPrompt } from "./smallModel";
import type { Snapshot } from "../types";

const SNAP_86: Snapshot = {
  schemaVersion: 1,
  session: {
    sampleRate: 48000,
    tempo: 86,
    timeSigNumerator: 4,
    timeSigDenominator: 4,
    metronome: false,
    key: { tonic: "C", mode: "minor" },
    length: 90,
    editFile: "",
  },
  tracks: [],
  transport: {
    playing: false,
    recording: false,
    position: 0,
    looping: false,
    loopStart: 0,
    loopEnd: 0,
  },
  master: { volumeDb: 0, pan: 0 },
};

const expectBeatContract = (prompt: string) => {
  expect(prompt).toContain("quarter-note beat offsets from project start");
  expect(prompt).toContain("NEVER seconds");
  expect(prompt).toContain("Bar N is one-based");
  expect(prompt).toContain("bar 1 to bar 5 = beats 0 to 16");
  expect(prompt).toContain("regardless of tempo");
};

describe("Moshi musical-time contract", () => {
  it("makes bar-to-beat conversion explicit in every production prompt path", () => {
    expectBeatContract(systemPrompt(SNAP_86));
    expectBeatContract(buildLoopSystemPrompt(SNAP_86));
    expectBeatContract(SMALL_MODEL_RULES);
  });

  it("labels section arguments as beat offsets, never seconds, in both catalogs", () => {
    for (const catalog of [commandCatalogPrompt(), smallModelCatalogPrompt()]) {
      expect(catalog).toContain(
        "create_section(name, startBeat, endBeat, color?) — Add a named song section using quarter-note beat offsets from project start — never seconds (in 4/4, bar 1 to bar 5 is startBeat 0 to endBeat 16)",
      );
      expect(catalog).toContain(
        "move_section(sectionId, startBeat, endBeat) — Move/resize a song section using quarter-note beat offsets from project start — never seconds",
      );
    }
  });
});
