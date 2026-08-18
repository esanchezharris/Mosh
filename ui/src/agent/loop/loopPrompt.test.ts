import { describe, it, expect } from "vitest";
import { buildLoopSystemPrompt, renderTaskContext, LOOP_RULES } from "./loopPrompt";
import { renderSession } from "../sessionRender";
import { systemPrompt } from "../brainCore";
import type { Snapshot } from "../../types";

const SNAP: Snapshot = {
  schemaVersion: 1,
  session: {
    sampleRate: 48000, tempo: 120, timeSigNumerator: 4, timeSigDenominator: 4,
    metronome: false, key: { tonic: "A", mode: "minor" }, length: 16, editFile: "",
    tempoMap: [{ time: 0, bpm: 120, curve: 1 }, { time: 4, bpm: 200, curve: 0 }],
  },
  tracks: [
    { id: "17", index: 0, name: "Drums", type: "audio", volumeDb: -2, pan: 0.2, mute: false, solo: false,
      sends: [{ bus: 1, db: -12 }],
      clips: [{ id: "101", name: "beat", type: "midi", start: 0, length: 4, offset: 0, hasRenderLayer: false }] },
  ],
  transport: { playing: false, recording: false, position: 0, looping: false, loopStart: 0, loopEnd: 0 },
  // a real snapshot's master plugins always carry `type` + `builtin` (MoshOps
  // pluginToVar) — the chain renders the TYPE for builtins, since that is the
  // string load_master_builtin takes. See sessionRender.test.ts.
  master: { volumeDb: -3, pan: 0, plugins: [{ index: 0, name: "Compressor", type: "compressor", builtin: true, enabled: true }] },
  buses: [{ bus: 1, name: "Reverb", trackId: "9" }],
} as unknown as Snapshot;

describe("renderSession — the Phase-A visibility fix", () => {
  const block = renderSession(SNAP);

  it("shows the master fader (the −3dB default nobody could see), pan and chain", () => {
    expect(block).toContain("master: -3dB pan 0 chain:[compressor]");
  });

  it("shows the tempo map WITH the indices remove_tempo_change takes", () => {
    expect(block).toContain("tempo map (by index): [0] 120bpm@0s, [1] 200bpm@4s ramp");
  });

  it("shows the key, buses, per-track pan and sends", () => {
    expect(block).toContain("key: A minor");
    expect(block).toContain('buses: 1 "Reverb"');
    expect(block).toContain("pan 0.2");
    expect(block).toContain("sends:[bus1@-12dB]");
  });

  it("keeps the compact style's quoted ids (the string-id contract)", () => {
    expect(block).toContain('"17" "Drums"');
    expect(block).toContain('"101":midi@0s');
  });
});

describe("buildLoopSystemPrompt", () => {
  it("carries the multi-step contract, the catalog, the loop rules and the rich session", () => {
    const p = buildLoopSystemPrompt(SNAP);
    expect(p).toContain('"status": "continue" | "done" | "need_user"');
    expect(p).toContain("- set_tempo(bpm) — ");           // the catalog rendering
    expect(p).toContain(LOOP_RULES.split("\n")[1]!);       // act-vs-defer rule
    expect(p).toContain("master: -3dB");
  });

  it("injects producer knowledge for the ask, like the single-shot path", () => {
    expect(buildLoopSystemPrompt(SNAP, "put a compressor on the master bus")).toContain("Producer knowledge");
    expect(buildLoopSystemPrompt(SNAP)).not.toContain("Producer knowledge");
  });
});

describe("LOOP_RULES — calibration-v2 (act-vs-defer + dosage)", () => {
  // The 2026-08-17 novice-jam ladder found three failure modes: grok wrong-defers
  // on a clear ask with an unspecified amount, opus over-acts (dup commands,
  // reflexive saves, 23-command spree on a genuinely ambiguous ask), r5 mixes one
  // wrong-defer with one ambiguity violation (a command on a pure-taste ask). These
  // pin the rewritten prose so a later edit can't silently drop the fix.

  it("tells the model to act on a clear ask with a missing amount, using a sensible default", () => {
    expect(LOOP_RULES).toContain("A missing AMOUNT is NOT a reason to ask");
    expect(LOOP_RULES).toContain("pick one modest, musically sensible default");
    // no longer requires BOTH a target and an explicit outcome before acting —
    // that was the grok-4.3 over-defer trigger ("make it faster" etc).
    expect(LOOP_RULES).not.toContain("AND what outcome is wanted");
  });

  it("still requires deferring when the ask names no concrete action at all (pure taste)", () => {
    expect(LOOP_RULES).toContain("no concrete action at all");
    expect(LOOP_RULES).toContain("mix this properly");
  });

  it("caps dosage: no repeats, no extra tracks/buses/sections, no reflexive save", () => {
    expect(LOOP_RULES).toContain("DOSAGE");
    expect(LOOP_RULES).toContain("Never repeat an identical command.");
    expect(LOOP_RULES).toContain("Never create a second track/bus/section when one already covers it.");
    expect(LOOP_RULES).toContain("Never `save` unless the producer asked to save.");
  });

  it("a mid-task defer carries NO commands — no partial nudge toward the guess", () => {
    expect(LOOP_RULES).toContain("with NO commands on that reply");
    expect(LOOP_RULES).toContain('not a chance to sneak in a "helpful" partial action');
  });

  it("the per-step plan gate matches the same act-vs-defer calibration (mockLoopChat keys off it)", () => {
    const planInstruction = renderTaskContext({
      ask: "make it faster", plan: [], planIdx: 0, history: [], stepsLeft: 5, repliesLeft: 5, mode: "plan",
    });
    expect(planInstruction).toContain("A missing AMOUNT is not a reason to ask");
    // loopBrainMock.ts's modeOf() keys off this exact substring to detect "plan" mode.
    expect(planInstruction).toContain("make a plan");
  });
});

describe("buildLoopSystemPrompt: M2 memory param — byte-stability + the one-section diff", () => {
  it("omitting memory is byte-identical to the pre-M2 shape (2-arg and explicit-undefined 3rd arg)", () => {
    const twoArg = buildLoopSystemPrompt(SNAP);
    expect(buildLoopSystemPrompt(SNAP, undefined, undefined)).toBe(twoArg);
    expect(buildLoopSystemPrompt(SNAP, undefined, "")).toBe(twoArg);
    expect(twoArg).not.toContain("Memory —");
  });

  it("when memory IS provided, it's the only addition — everything else is untouched", () => {
    const memory = "Memory — a made-up section for this test.\n- (this project) a fact";
    const without = buildLoopSystemPrompt(SNAP);
    const withMemory = buildLoopSystemPrompt(SNAP, undefined, memory);

    const rulesFirstLine = LOOP_RULES.split("\n")[0]!;
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

  it("memory slots after knowledge and before the loop rules, same as the single-shot path", () => {
    const memory = "Memory — a made-up block.";
    // buildLoopSystemPrompt computes its own knowledge internally from `query`; use a
    // real query so a real knowledge block appears, then just check relative order.
    const p = buildLoopSystemPrompt(SNAP, "put a compressor on the master bus", memory);
    const knowIdx = p.indexOf("Producer knowledge");
    const memIdx = p.indexOf(memory);
    const rulesIdx = p.indexOf(LOOP_RULES.split("\n")[0]!);
    expect(knowIdx).toBeGreaterThan(-1);
    expect(memIdx).toBeGreaterThan(knowIdx);
    expect(rulesIdx).toBeGreaterThan(memIdx);
  });
});

describe("renderTaskContext", () => {
  it("renders plan progress, verbatim step errors and the budget line", () => {
    const ctx = renderTaskContext({
      ask: "warp it",
      plan: [{ goal: "warp the clip" }, { goal: "check it" }],
      planIdx: 1,
      history: [{
        commands: [{ command: "set_clip_warp", args: {} }],
        results: [{ command: "set_clip_warp", ok: false, error: "not an audio clip" }],
        invalidCount: 0, ms: 5,
      }],
      stepsLeft: 7, repliesLeft: 9, mode: "repair",
    });
    expect(ctx).toContain("TASK: warp it");
    expect(ctx).toContain("✓ 1. warp the clip");
    expect(ctx).toContain("→ 2. check it");
    expect(ctx).toContain("ERROR: not an audio clip");
    expect(ctx).toContain("Budget: 7 step(s) and 9 replies left.");
    expect(ctx).toContain("never repeat a failed command unchanged");
  });
});

describe("legacy prompt semantic contract", () => {
  // Assert what the single-shot prompt must contain — the master line whose absence made
  // master-trim unsolvable single-shot, and the key it was also dropping.
  it("the shipped single-shot prompt SHOWS master state and the session key", () => {
    const fixture = {
      schemaVersion: 1,
      session: { sampleRate: 48000, tempo: 120, timeSigNumerator: 4, timeSigDenominator: 4, metronome: false, key: { tonic: "C", mode: "major" }, length: 16, editFile: "" },
      tracks: [
        { id: "17", index: 0, name: "Drums", type: "audio", volumeDb: 0, mute: false, solo: false,
          clips: [{ id: "101", name: "beat", type: "midi", start: 0, length: 4, offset: 0, hasRenderLayer: false }] },
      ],
      transport: { playing: false, recording: false, position: 0, looping: false, loopStart: 0, loopEnd: 0 },
      master: { volumeDb: 0, pan: 0 },
    } as unknown as Snapshot;
    const p = systemPrompt(fixture);
    expect(p).toContain("master: 0dB pan 0 chain:[empty]");
    expect(p).toContain("key: C major");
    // and the compact renderer's contract still holds — quoted ids
    expect(p).toContain('"17" "Drums"');
    expect(p).toContain('"101":midi@0s');

    // The full rendered session block is structured data with a stable compact shape;
    // unlike the surrounding prompt prose, an exact assertion is useful here.
    expect(renderSession(fixture)).toBe(
      [
        "tempo 120 BPM, 4/4",
        "key: C major",
        "master: 0dB pan 0 chain:[empty]",
        "sections: (none)",
        "tracks:",
        '  "17" "Drums" 0dB clips:["101":midi@0s]',
      ].join("\n"),
    );
  });

  // The shipped prompt is an evolving capability contract. Assert the commands that
  // must remain reachable instead of pinning every byte of natural-language prose.
  it("the single-shot catalog exposes the complete send-control surface", () => {
    const fixture = {
      schemaVersion: 1,
      session: { sampleRate: 48000, tempo: 120, timeSigNumerator: 4, timeSigDenominator: 4, metronome: false, key: { tonic: "C", mode: "major" }, length: 16, editFile: "" },
      tracks: [
        { id: "17", index: 0, name: "Drums", type: "audio", volumeDb: 0, mute: false, solo: false,
          clips: [{ id: "101", name: "beat", type: "midi", start: 0, length: 4, offset: 0, hasRenderLayer: false }] },
      ],
      transport: { playing: false, recording: false, position: 0, looping: false, loopStart: 0, loopEnd: 0 },
      master: { volumeDb: 0, pan: 0 },
    } as unknown as Snapshot;
    const prompt = systemPrompt(fixture);
    expect(prompt).toContain("- set_send_level(");
    expect(prompt).toContain("- set_send_mute(");
    expect(prompt).toContain("- set_send_pan(");
    expect(prompt).toContain("- set_send_pre_fader(");
  });

  // M2 extension: prove the memory parameter is live without coupling the test to all
  // unrelated prompt prose.
  it("the same fixture with explicit memory produces a different prompt", () => {
    const fixture = {
      schemaVersion: 1,
      session: { sampleRate: 48000, tempo: 120, timeSigNumerator: 4, timeSigDenominator: 4, metronome: false, key: { tonic: "C", mode: "major" }, length: 16, editFile: "" },
      tracks: [
        { id: "17", index: 0, name: "Drums", type: "audio", volumeDb: 0, mute: false, solo: false,
          clips: [{ id: "101", name: "beat", type: "midi", start: 0, length: 4, offset: 0, hasRenderLayer: false }] },
      ],
      transport: { playing: false, recording: false, position: 0, looping: false, loopStart: 0, loopEnd: 0 },
      master: { volumeDb: 0, pan: 0 },
    } as unknown as Snapshot;
    const withoutMemory = systemPrompt(fixture);
    const withMemory = systemPrompt(fixture, undefined, "Memory — a made-up section.");
    expect(withMemory).not.toBe(withoutMemory);
  });
});
