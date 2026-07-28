import { describe, it, expect } from "vitest";
import { createHash } from "node:crypto";
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
  master: { volumeDb: -3, pan: 0, plugins: [{ index: 0, name: "Compressor", enabled: true }] },
  buses: [{ bus: 1, name: "Reverb", trackId: "9" }],
} as unknown as Snapshot;

describe("renderSession — the Phase-A visibility fix", () => {
  const block = renderSession(SNAP);

  it("shows the master fader (the −3dB default nobody could see), pan and chain", () => {
    expect(block).toContain("master: -3dB pan 0 chain:[Compressor]");
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
    expect(p).toContain(LOOP_RULES.split("\n")[1]!);       // plan-first rule
    expect(p).toContain("master: -3dB");
  });

  it("injects producer knowledge for the ask, like the single-shot path", () => {
    expect(buildLoopSystemPrompt(SNAP, "put a compressor on the master bus")).toContain("Producer knowledge");
    expect(buildLoopSystemPrompt(SNAP)).not.toContain("Producer knowledge");
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

describe("legacy prompt byte-stability pin", () => {
  // The SHIPPED single-shot prompt (SFT/gepa/bench surface) must never move as
  // a side effect of loop work. An INTENTIONAL prompt change updates this hash
  // consciously — that is the point of the pin.
  it("systemPrompt(FIXTURE) hash is unchanged", () => {
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
    const hash = createHash("sha256").update(systemPrompt(fixture)).digest("hex");
    // Moved 2026-07-26, consciously: `unfreeze_layer` was added to the agent catalog (the
    // thaw for freeze_layer, which had none), and freeze_layer's own description was
    // corrected — it used to say "commit the rendered audio", which described a label it
    // wrote rather than what it does. The catalog is rendered into this prompt, so both
    // edits move the hash. Nothing about the prompt's SHAPE changed.
    // Previous pin: a5b1847f7e5c7f100cc2365878dd336891d43e4f4631b0a081d65143a114cb8c
    expect(hash).toBe("70f9a562bf8bf352f618c87d3be169c56a10d1c9c527b0bf9d2f84e446a1748e");
  });

  // M2 extension: the pin above already proves the OMITTED-memory call is unmoved
  // (systemPrompt(fixture) never passes a 3rd arg). This makes that explicit and
  // proves the OPPOSITE isn't silently also true — the param genuinely threads
  // through when a caller DOES supply it, so "byte-identical when omitted" is a real
  // guarantee about the argument, not a dead/no-op parameter.
  it("the SAME fixture with an explicit memory arg produces a DIFFERENT hash (the param is live)", () => {
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
    const pinnedHash = createHash("sha256").update(systemPrompt(fixture)).digest("hex");
    const withMemoryHash = createHash("sha256")
      .update(systemPrompt(fixture, undefined, "Memory — a made-up section."))
      .digest("hex");
    expect(withMemoryHash).not.toBe(pinnedHash);
  });
});
