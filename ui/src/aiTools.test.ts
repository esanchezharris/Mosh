// Optional AI tools (docs/AI-TOOLS-OPTIONAL-BRIEF-2026-11-02.md): what the UI offers, what
// the brain is told it can do, and what the agent path refuses, from snapshot.aiTools.

import { beforeEach, describe, expect, it } from "vitest";
import { AI_TOOLS_NEEDED, SA3_NEEDED, aiToolsOf, aiToolsRefusal, unavailableAgentCommands } from "./aiTools";
import { commandCatalogPrompt } from "./agent/commands";
import { systemPrompt } from "./agent/brainCore";
import { buildLoopSystemPrompt } from "./agent/loop/loopPrompt";
import { runAgentBatch } from "./agent/executor";
import { useStore } from "./store";
import { __resetMockForTests } from "./bridge.mock";
import type { AiToolsSnapshot, CommandResult, Snapshot } from "./types";

const OFF: AiToolsSnapshot = { state: "off", pack: { python: "missing", sketch: "missing", transcribe: "missing" }, sa3: false };
const PACK_ONLY: AiToolsSnapshot = { state: "on", pack: { python: "ok", sketch: "ok", transcribe: "missing" }, sa3: false };
const ALL: AiToolsSnapshot = { state: "on", pack: { python: "ok", sketch: "ok", transcribe: "ok" }, sa3: true };

const base = { schemaVersion: 1, tracks: [] } as unknown as Snapshot;
const withTools = (aiTools?: AiToolsSnapshot): Snapshot => ({ ...base, ...(aiTools ? { aiTools } : {}) });

describe("aiToolsOf", () => {
  it("treats a snapshot without the field as everything available (older native, fixtures)", () => {
    expect(aiToolsOf(withTools())).toEqual({ on: true, transcribe: true, sa3: true });
    expect(aiToolsOf(null)).toEqual({ on: true, transcribe: true, sa3: true });
  });
  it("reads the native probe", () => {
    expect(aiToolsOf(withTools(OFF))).toEqual({ on: false, transcribe: false, sa3: false });
    expect(aiToolsOf(withTools(PACK_ONLY))).toEqual({ on: true, transcribe: false, sa3: false });
  });
});

describe("unavailableAgentCommands / aiToolsRefusal", () => {
  it("is empty when every tool is present or the field is absent", () => {
    expect(unavailableAgentCommands(withTools()).size).toBe(0);
    expect(unavailableAgentCommands(withTools(ALL)).size).toBe(0);
  });
  it("a fresh Mac loses the pack, transcription and Re-Imagine commands", () => {
    const missing = unavailableAgentCommands(withTools(OFF));
    for (const c of ["sketch_beatbox", "generate_beat_recipe", "complete_lyrics", "transcribe_clip", "render_layer", "create_render_layer"])
      expect(missing.has(c)).toBe(true);
    // Ordinary editing is never touched.
    for (const c of ["add_note", "set_tempo", "create_track", "loop_record"]) expect(missing.has(c)).toBe(false);
    expect(aiToolsRefusal(withTools(OFF), "generate_beat_recipe")).toBe(AI_TOOLS_NEEDED);
    expect(aiToolsRefusal(withTools(OFF), "render_layer")).toBe(SA3_NEEDED);
    expect(aiToolsRefusal(withTools(OFF), "set_tempo")).toBeNull();
  });
  it("the pack without SA3 keeps beats and lyrics, drops Re-Imagine; transcription follows its own tool", () => {
    const missing = unavailableAgentCommands(withTools(PACK_ONLY));
    expect(missing.has("generate_beat_recipe")).toBe(false);
    expect(missing.has("sketch_beatbox")).toBe(false);
    expect(missing.has("transcribe_clip")).toBe(true);
    expect(missing.has("render_layer")).toBe(true);
  });
});

describe("the brain's catalog", () => {
  it("is byte-identical without the field (datasets, benches, older native)", () => {
    expect(commandCatalogPrompt(new Set())).toBe(commandCatalogPrompt());
    expect(systemPrompt(withTools())).toContain("- render_layer(");
    expect(systemPrompt(withTools(ALL))).toBe(systemPrompt(withTools()));
  });
  it("never lists a command this Mac can't run, in either prompt", () => {
    for (const prompt of [systemPrompt(withTools(OFF)), buildLoopSystemPrompt(withTools(OFF))]) {
      expect(prompt).not.toContain("- render_layer(");
      expect(prompt).not.toContain("- sketch_beatbox(");
      expect(prompt).not.toContain("- generate_beat_recipe(");
      expect(prompt).toContain("- set_tempo(");
    }
  });
});

describe("runAgentBatch refuses a plan that needs a missing tool, whole and before anything runs", () => {
  beforeEach(async () => {
    __resetMockForTests();
    await useStore.getState().refresh();
  });

  it("a re-imagine plan on a Mac without SA3: no layer is created, every entry says why", async () => {
    const realExec = useStore.getState().exec;
    const calls: string[] = [];
    useStore.setState({
      snapshot: { ...useStore.getState().snapshot!, aiTools: OFF },
      exec: async (command: string, args?: Record<string, unknown>): Promise<CommandResult> => {
        calls.push(command);
        return realExec(command, args);
      },
    });
    const clipId = useStore.getState().snapshot!.tracks.flatMap((t) => t.clips)[0]?.id ?? "c1";
    const cs = await runAgentBatch("rework", [
      { command: "create_render_layer", args: { clipId } },
      { command: "render_layer", args: { clipId } },
    ]);
    expect(cs.applied).toBe(0);
    expect(cs.entries.map((e) => e.error)).toEqual([SA3_NEEDED, SA3_NEEDED]);
    // Only logAgentTurn's empty batch (it records the unserved ask) reaches the seam.
    expect(calls).toEqual(["batch_begin", "batch_end"]);
  });

  it("control: the same batch runs when the tools are present", async () => {
    useStore.setState({ snapshot: { ...useStore.getState().snapshot!, aiTools: ALL } });
    const cs = await runAgentBatch("tempo", [{ command: "set_tempo", args: { bpm: 97 } }]);
    expect(cs.applied).toBe(1);
  });

  it("a mixed plan with one ordinary command is still refused whole", async () => {
    useStore.setState({ snapshot: { ...useStore.getState().snapshot!, aiTools: OFF } });
    const before = useStore.getState().snapshot!.session.tempo;
    const cs = await runAgentBatch("beat", [
      { command: "set_tempo", args: { bpm: 97 } },
      { command: "generate_beat_recipe", args: {} },
    ]);
    expect(cs.applied).toBe(0);
    expect(cs.entries[1].error).toBe(AI_TOOLS_NEEDED);
    expect(cs.entries[0].error).toBe(AI_TOOLS_NEEDED);
    await useStore.getState().refresh();
    expect(useStore.getState().snapshot!.session.tempo).toBe(before);
  });
});
