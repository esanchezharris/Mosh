// P1 produce lane — trigger discipline, prompt composition, and the loop's
// systemPrompt seam. The genre rules themselves come from the flywheel lab's
// PROMPT-trap-v4 lineage (correction-round provenance) and are NOT re-derived or
// asserted line-by-line here; what these tests pin is the MACHINERY: explicit
// triggers only, the default lane byte-identical when the dep is omitted, and the
// produce prompt strictly wrapping (never forking) the default prompt.

import { describe, expect, it } from "vitest";
import { buildLoopSystemPrompt } from "./loopPrompt";
import { buildProduceSystemPrompt, isProduceAsk, PRODUCE_BUDGETS, PRODUCE_RULES } from "./producePrompt";
import { runAgentLoop, type ChatMessage } from "./loop";
import type { Snapshot } from "../../types";

const SNAP = {
  schemaVersion: 1,
  session: { sampleRate: 48000, tempo: 120, timeSigNumerator: 4, timeSigDenominator: 4, metronome: false, length: 16, editFile: "" },
  tracks: [],
  transport: { playing: false, recording: false, position: 0, looping: false, loopStart: 0, loopEnd: 0 },
} as unknown as Snapshot;

describe("produce-lane trigger (explicit by design)", () => {
  it("matches explicit produce asks", () => {
    for (const ask of [
      "produce me a beat", "produce a dark jerk beat at 148", "run a production pass on this",
      "make me a full beat", "I want a complete beat", "build the whole beat",
    ]) expect(isProduceAsk(ask), ask).toBe(true);
  });
  it("does NOT match ordinary bounded asks — they stay on the DOSAGE lane", () => {
    for (const ask of [
      "make me a beat", "add hats", "make a melody on Keys", "lay a groove",
      "make the drums louder", "start a lofi sketch",
    ]) expect(isProduceAsk(ask), ask).toBe(false);
  });
});

describe("produce prompt composition", () => {
  it("wraps the default loop prompt verbatim (adds rules, never forks the base)", () => {
    const base = buildLoopSystemPrompt(SNAP, "produce me a beat", undefined);
    const produce = buildProduceSystemPrompt(SNAP, "produce me a beat", undefined);
    expect(produce.startsWith(base)).toBe(true);
    expect(produce).toBe([base, PRODUCE_RULES].join("\n"));
  });
  it("carries the load-bearing genre disciplines (v4 lineage)", () => {
    expect(PRODUCE_RULES).toContain("PRODUCE MODE");
    expect(PRODUCE_RULES).toContain("62-70");            // 808 register discipline (correction 1)
    expect(PRODUCE_RULES).toContain("add_drum_pattern"); // MoshOps idiom, not raw per-note drums
    expect(PRODUCE_RULES).toContain("load_preset");      // sounds before judging
    expect(PRODUCE_RULES).toContain("SUSTAIN");          // correction r1 lesson (stabs)
    expect(PRODUCE_RULES).toContain("LAYER clap");       // correction r1 lesson (clap variation)
    expect(PRODUCE_BUDGETS.maxSteps).toBeGreaterThan(8); // a full pass cannot fit assistant budgets
  });
});

describe("loop systemPrompt seam", () => {
  const doneChat = async (_m: ChatMessage[]) => ({ content: '{"status":"done","say":"ok"}' });
  const env = {
    async getSnapshot() { return SNAP; },
    async runBatch() { return { results: [], snapshot: SNAP }; },
  };

  it("uses the injected builder for every model call", async () => {
    const systems: string[] = [];
    await runAgentLoop({ ask: "produce me a beat" }, {
      chat: async (m) => { systems.push(m[0].content); return doneChat(m); },
      env, systemPrompt: buildProduceSystemPrompt,
    });
    expect(systems.length).toBeGreaterThan(0);
    for (const s of systems) expect(s).toContain("PRODUCE MODE");
  });

  it("omitted ⇒ byte-identical to the default lane prompt", async () => {
    const systems: string[] = [];
    await runAgentLoop({ ask: "produce me a beat" }, {
      chat: async (m) => { systems.push(m[0].content); return doneChat(m); },
      env,
    });
    expect(systems[0]).toBe(buildLoopSystemPrompt(SNAP, "produce me a beat", undefined));
    expect(systems[0]).not.toContain("PRODUCE MODE");
  });
});
