import { describe, it, expect } from "vitest";
import { systemPrompt } from "./prompt";
import type { Snapshot } from "../types";
import type { TechniqueCard } from "./knowledge/card";

// A minimal-but-valid snapshot with a track that hosts a plugin with NAMED params + a
// bus — the data the agent needs to target set_plugin_param / automation by intent.
const snap: Snapshot = {
  schemaVersion: 1,
  session: { sampleRate: 44100, tempo: 90, timeSigNumerator: 4, timeSigDenominator: 4, key: { tonic: "A", mode: "minor" }, editFile: "/x.edit" },
  tracks: [
    {
      id: "t1", index: 0, name: "Drums", type: "audio", volumeDb: -4,
      clips: [{ id: "c1", name: "loop", type: "wave", start: 0, length: 4, offset: 0, hasRenderLayer: false }],
      plugins: [
        { index: 0, name: "Pro-Q 3", type: "vst3", enabled: true, external: true, isInstrument: false,
          params: [{ index: 0, name: "Gain", value: 0.5 }, { index: 1, name: "Frequency", value: 0.25 }] },
      ],
    },
  ],
  transport: { playing: false, recording: false, position: 0, looping: false, loopStart: 0, loopEnd: 0 },
  buses: [{ bus: 0, name: "Reverb", trackId: "rt1" }],
};

describe("systemPrompt — surfaces what the agent needs to target params + buses", () => {
  const out = systemPrompt(snap);

  it("renders the plugin chain index + name", () => {
    expect(out).toContain("fx:[0:Pro-Q 3");
  });
  it("renders each param's index + name + value (so set_plugin_param is addressable by intent)", () => {
    expect(out).toContain("1:Frequency=0.25");
    expect(out).toContain("0:Gain=0.5");
  });
  it("surfaces buses so add_send can target an existing one across turns", () => {
    expect(out).toContain('buses: 0:"Reverb"');
  });
  it("still shows the basics (track id/name/clips/tempo)", () => {
    expect(out).toContain('t1 "Drums"');
    expect(out).toContain("c1:wave@0s");
    expect(out).toContain("tempo 90 BPM");
  });
  it("caps params per plugin so a big plugin can't blow the token budget", () => {
    const many = { ...snap, tracks: [{ ...snap.tracks[0], plugins: [{ index: 0, name: "Serum", type: "vst3", enabled: true, external: true, isInstrument: true,
      params: Array.from({ length: 40 }, (_, i) => ({ index: i, name: `p${i}`, value: 0 })) }] }] };
    const rendered = systemPrompt(many as Snapshot);
    expect(rendered).toContain("7:p7=0");
    expect(rendered).not.toContain("8:p8=0"); // capped at 8
  });
  it("renders (empty session) and no rendered fx/bus lines when snapshot is null", () => {
    const bare = systemPrompt(null);
    expect(bare).toContain("(empty session)");
    expect(bare).not.toContain("fx:[0:Pro-Q"); // no RENDERED plugin chain
    expect(bare).not.toContain('buses: 0:"');  // no RENDERED bus line
  });

  // Teaching guard: the agent must be told WHEN to reach for the fuller (batch-1+2)
  // reach, not just that the commands exist in the catalog. If this block is dropped
  // the agent regresses to static single-value edits — so pin the key cues.
  it("teaches the new reach (automation / sends / by-name / feel / bounce), even with no snapshot", () => {
    const out = systemPrompt(null); // unconditional — present regardless of session state
    expect(out).toContain("Production moves");
    for (const cue of [
      "add_automation_point",      // movement, not a static set
      "create_bus",                // shared depth / parallel comp
      "set_plugin_param_by_name",  // EQ/comp by intent
      "swing",                     // MPC feel
      "humanize_notes",            // breathe
      "create_group_track",        // submix
      "set_clip_warp",             // tempo-match a loop
      "bounce_track",              // commit / print FX
    ]) {
      expect(out).toContain(cue);
    }
  });
});

describe("knowHowBlock — an injected RECIPE card teaches the technique, not a command dump", () => {
  const recipeCard: TechniqueCard = {
    id: "c1", source: "distill", skill_name: "Boom-bap drum pattern", task_type: "drum_programming",
    genre_context: ["boom-bap"], producer_intent: "the classic boom-bap kick/snare/hat skeleton",
    when: "programming a boom-bap pattern",
    recipe: { kind: "recipe", commands: [{ command: "add_note", args: {} }, { command: "add_note", args: {} }] },
    evidence: [], confidence: 0.7, status: "conformant",
  };
  const out = systemPrompt(null, [], [recipeCard]);
  it("renders the producer intent + when (the teaching)", () => {
    expect(out).toContain("the classic boom-bap kick/snare/hat skeleton");
    expect(out).toContain("programming a boom-bap pattern");
  });
  it("does NOT dump the raw command chain (noise the agent can't use)", () => {
    expect(out).not.toContain("add_note → add_note"); // the old command-name join
  });
});
