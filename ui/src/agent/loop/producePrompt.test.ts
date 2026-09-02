// P1 produce lane — trigger discipline, prompt composition, and the loop's
// systemPrompt seam. The genre/taste rules themselves come from real correction
// rounds (docs/produce-corrections/*.meta.json) and are NOT re-derived or asserted
// line-by-line here; what these tests pin is the MACHINERY: explicit triggers
// only, the default lane byte-identical when the dep is omitted, the produce
// prompt strictly wrapping (never forking) the default prompt, the v2 division of
// labor (the template is laid, the model only writes notes), and that every
// `// lesson:` tag in the source resolves to a real correction file.

import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { buildLoopSystemPrompt } from "./loopPrompt";
import {
  buildProduceSystemPrompt, isProduceAsk, PRODUCE_BUDGETS, PRODUCE_FEWSHOT, PRODUCE_RULES, PRODUCE_VERSION,
  renderProduceTemplate,
} from "./producePrompt";
import type { ProduceTemplate } from "./produceTemplate";
import { runAgentLoop, type ChatMessage } from "./loop";
import type { Snapshot } from "../../types";

const SNAP = {
  schemaVersion: 1,
  session: { sampleRate: 48000, tempo: 120, timeSigNumerator: 4, timeSigDenominator: 4, metronome: false, length: 16, editFile: "" },
  tracks: [],
  transport: { playing: false, recording: false, position: 0, looping: false, loopStart: 0, loopEnd: 0 },
} as unknown as Snapshot;

const TEMPLATE: ProduceTemplate = {
  bpm: 148,
  key: { tonic: "D", mode: "minor" },
  drums: {
    trackId: "20",
    pads: [
      { note: 36, name: "Kick", file: "/mock/palette/kick_1.wav" },
      { note: 38, name: "Snare", file: "/mock/palette/snare_1.wav" },
    ],
  },
  bass: { trackId: "21", keyNote: 60, file: "/mock/palette/bass_1.wav" },
  synths: [
    { trackId: "22", role: "lead", preset: "Dark Lead", file: "/presets/vital/lead-dark.vital" },
    { trackId: "23", role: "stab", preset: "", file: "/presets/vital/keys-rhodes.vital", presetError: "instance not available" },
  ],
  constants: { eightBarsSeconds: (32 * 60) / 148 },
};

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

describe("produce prompt composition (v2)", () => {
  it("wraps the default loop prompt verbatim (adds rules, never forks the base)", () => {
    const base = buildLoopSystemPrompt(SNAP, "produce me a beat", undefined);
    const produce = buildProduceSystemPrompt(SNAP, "produce me a beat", undefined);
    expect(produce.startsWith(base)).toBe(true);
    expect(produce).toBe([base, PRODUCE_RULES, PRODUCE_FEWSHOT].join("\n"));
  });

  it("with a template, composition is [base, PRODUCE_RULES, renderProduceTemplate(template), PRODUCE_FEWSHOT]", () => {
    const base = buildLoopSystemPrompt(SNAP, "produce me a beat", undefined);
    const produce = buildProduceSystemPrompt(SNAP, "produce me a beat", undefined, TEMPLATE);
    expect(produce).toBe([base, PRODUCE_RULES, renderProduceTemplate(TEMPLATE), PRODUCE_FEWSHOT].join("\n"));
    expect(produce).toContain("REQUIRED TRACKS");
  });

  it("v2 forbids the v1 build-it-yourself commands — only a PROHIBITION, never an instruction to call them", () => {
    expect(PRODUCE_RULES).toContain("TEMPLATE IS LAID");
    expect(PRODUCE_RULES).toContain("never call create_track, load_plugin, load_preset, assign_sample, set_drum_pad, or generate_beat_recipe");
    // "FOUNDATION FIRST: ... call it ONCE early" (v1's instruction to invoke the
    // recipe generator) must be gone — recipe only appears inside the prohibition.
    expect(PRODUCE_RULES).not.toContain("FOUNDATION FIRST");
    expect(PRODUCE_RULES).not.toMatch(/call (?:generate_beat_recipe|it)\b.*early/i);
  });

  it("v2 never instructs list_presets — the template already loaded every preset", () => {
    expect(PRODUCE_RULES).toContain("Never call list_presets");
    expect(PRODUCE_RULES).not.toMatch(/\blist_presets\b\s*(?:once|first|early)/i);
  });

  it("pins the octave convention (C4=60) and the per-role registers", () => {
    expect(PRODUCE_RULES).toContain("C4 = 60");
    expect(PRODUCE_RULES).toContain("62-70");
    expect(PRODUCE_RULES).toContain("72-84");
    expect(PRODUCE_RULES).toContain("57-72");
    expect(PRODUCE_RULES).toContain("50-57");
    expect(PRODUCE_RULES).toContain("84-96");
  });

  it("pins the 9-step goal-only STEP PLAN order", () => {
    expect(PRODUCE_RULES).toContain("(1) drums, (2) 808, (3) lead, (4) chords, (5) drone + ambient, (6) counter, (7) stab, (8) arp, (9)");
    expect(PRODUCE_RULES).toContain("under 120");
    expect(PRODUCE_RULES).toContain("beat 0 to beat 32"); // Opus run 2026-09-02: drums stopped at bar 4
  });

  it("carries the load-bearing genre disciplines (correction-round lineage)", () => {
    expect(PRODUCE_RULES).toContain("SUSTAIN");
    expect(PRODUCE_RULES).toContain("Layer a SECOND, quieter clap");
    expect(PRODUCE_RULES).toContain("off-beat starts");
    expect(PRODUCE_RULES).toContain("track without a clip");
    expect(PRODUCE_RULES).toContain("808 pitch outside 62-70");
    expect(PRODUCE_BUDGETS.maxSteps).toBeGreaterThan(8); // a full pass cannot fit assistant budgets
    expect(PRODUCE_BUDGETS.maxPlannerCalls).toBe(8);
    expect(PRODUCE_BUDGETS.softWallMs).toBe(900_000);
  });

  it("stays well under the 12kB budget (PRODUCE_RULES + PRODUCE_FEWSHOT)", () => {
    const bytes = Buffer.byteLength(PRODUCE_RULES) + Buffer.byteLength(PRODUCE_FEWSHOT);
    expect(bytes).toBeLessThan(12_000);
  });

  it("PRODUCE_VERSION is a plain bumpable number", () => {
    expect(typeof PRODUCE_VERSION).toBe("number");
    expect(PRODUCE_VERSION).toBeGreaterThanOrEqual(2);
  });
});

describe("renderProduceTemplate", () => {
  it("omitted ⇒ empty string (dropped from the composition by .filter(Boolean))", () => {
    expect(renderProduceTemplate(undefined)).toBe("");
  });

  it("renders every REQUIRED track — drum pad map, 808 keyNote, and per-synth preset (or its absence)", () => {
    const rendered = renderProduceTemplate(TEMPLATE);
    expect(rendered).toContain('Drums "20" pads:[36:Kick 38:Snare]');
    expect(rendered).toContain('808 "21" keyNote 60');
    expect(rendered).toContain('Lead "22" preset "Dark Lead"');
    expect(rendered).toContain('Stabs "23"');
    expect(rendered).toContain("NO PRESET LOADED (instance not available)");
    expect(rendered).toContain("still write notes");
    expect(rendered).toContain("beats 0-32");
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

  it("the loop's own 3-arg call site renders correctly with no template (a runTask.ts closure supplies it separately)", async () => {
    const systems: string[] = [];
    await runAgentLoop({ ask: "produce me a beat" }, {
      chat: async (m) => { systems.push(m[0].content); return doneChat(m); },
      env, systemPrompt: buildProduceSystemPrompt,
    });
    expect(systems[0]).not.toContain("REQUIRED TRACKS (already built");
    // a closure binding a template is what runTask.ts passes in production instead:
    const bound = (snap: Snapshot | null, query?: string, memory?: string) =>
      buildProduceSystemPrompt(snap, query, memory, TEMPLATE);
    const boundSystems: string[] = [];
    await runAgentLoop({ ask: "produce me a beat" }, {
      chat: async (m) => { boundSystems.push(m[0].content); return doneChat(m); },
      env, systemPrompt: bound,
    });
    expect(boundSystems[0]).toContain("REQUIRED TRACKS");
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

describe("lesson-tag provenance (docs/produce-corrections/README.md's workflow)", () => {
  // Read the SOURCE file text (not the runtime string) — lesson tags are TS
  // comments, deliberately never part of the prompt bytes sent to the model.
  const here = dirname(fileURLToPath(import.meta.url));
  const source = readFileSync(join(here, "producePrompt.ts"), "utf8");
  const correctionsDir = join(here, "../../../../docs/produce-corrections");
  const tagRe = /\/\/ lesson: produce-corrections\/([\w.-]+) note (\d+)/g;

  it("finds at least one lesson tag (the taste rules really do trace to a correction)", () => {
    expect([...source.matchAll(tagRe)].length).toBeGreaterThan(0);
  });

  it("every tagged correction id resolves to a real docs/produce-corrections/<id>.meta.json with that note", () => {
    for (const [, id, noteStr] of source.matchAll(tagRe)) {
      const path = join(correctionsDir, `${id}.meta.json`);
      expect(existsSync(path), `missing correction file for lesson tag: ${path}`).toBe(true);
      const meta = JSON.parse(readFileSync(path, "utf8")) as { notes?: unknown[] };
      const noteIndex = Number(noteStr) - 1; // tags are 1-based
      expect(Array.isArray(meta.notes), `${id}.meta.json has no notes[]`).toBe(true);
      expect(noteIndex, `lesson tag note ${noteStr} out of range for ${id}`).toBeGreaterThanOrEqual(0);
      expect(noteIndex).toBeLessThan((meta.notes as unknown[]).length);
    }
  });
});
