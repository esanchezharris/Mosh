import { describe, it, expect } from "vitest";
import { AGENT_COMMAND_MAP, commandCatalogPrompt } from "./commands";
import { WORKED_EXAMPLES } from "./fewshot";
import {
  SMALL_MODEL_KEEP,
  SMALL_MODEL_COMMANDS,
  SMALL_MODEL_RULES,
  SMALL_MODEL_RULES_WITH_EXAMPLES,
  smallModelCatalogPrompt,
} from "./smallModel";

// The 41 commands that appear as goldCommandNames in the frozen measurement
// surfaces (evalA.eval.jsonl 210-row core + frozen300, durable copies at
// ~/Library/Mosh/work/gate/rerun-evals/). Dropping ANY of these from the pruned
// catalog would make its eval rows unpassable — the A/B would be broken by
// construction, not by the model. Frozen surfaces; update only with a new
// registered eval set.
const EVAL_GOLD_COMMANDS = [
  "add_midi_clip",
  "add_note",
  "arm_track",
  "assign_sample",
  "build_skeleton_from_clip",
  "bypass_plugin",
  "create_annotation",
  "create_render_layer",
  "create_section",
  "create_track",
  "load_drum_kit",
  "move_section",
  "redo",
  "reject_render",
  "remove_note",
  "remove_plugin",
  "remove_section",
  "remove_track",
  "rename_section",
  "rename_track",
  "render_layer",
  "save",
  "set_input_monitor",
  "set_key",
  "set_master_pan",
  "set_master_volume",
  "set_metronome",
  "set_note",
  "set_render_param",
  "set_tempo",
  "set_time_signature",
  "set_track_mute",
  "set_track_pan",
  "set_track_solo",
  "set_track_type",
  "set_track_volume",
  "set_transport",
  "sketch_beatbox",
  "stop_recording",
  "suggest_next_line",
  "undo",
];

describe("small-model-mode pruned catalog", () => {
  it("keep-list names are real catalog commands, with no duplicates", () => {
    for (const name of SMALL_MODEL_KEEP) expect(AGENT_COMMAND_MAP.has(name), `unknown command in keep-list: ${name}`).toBe(true);
    expect(new Set(SMALL_MODEL_KEEP).size).toBe(SMALL_MODEL_KEEP.length);
    expect(SMALL_MODEL_COMMANDS.length).toBe(SMALL_MODEL_KEEP.length);
  });

  it("keeps every eval-gold command (the A/B-not-broken-by-construction invariant)", () => {
    expect(EVAL_GOLD_COMMANDS.length).toBe(41);
    const keep = new Set(SMALL_MODEL_KEEP);
    for (const name of EVAL_GOLD_COMMANDS) expect(keep.has(name), `eval-gold command missing from keep-list: ${name}`).toBe(true);
  });

  it("reuses each kept command's arg specs by reference — specs can never drift from validateCommand", () => {
    for (const c of SMALL_MODEL_COMMANDS) expect(c.args).toBe(AGENT_COMMAND_MAP.get(c.command)!.args);
  });

  it("renders each command in the full catalog's exact line format (names, order, ? markers)", () => {
    const lines = smallModelCatalogPrompt().split("\n");
    expect(lines.length).toBe(SMALL_MODEL_COMMANDS.length);
    for (let i = 0; i < lines.length; i++) {
      const c = SMALL_MODEL_COMMANDS[i];
      const a = c.args.map((x) => `${x.name}${x.required ? "" : "?"}`).join(", ");
      expect(lines[i].startsWith(`- ${c.command}(${a}) — `), `bad render for ${c.command}: ${lines[i]}`).toBe(true);
    }
  });

  it("is materially shorter than the full catalog", () => {
    expect(smallModelCatalogPrompt().length).toBeLessThan(0.75 * commandCatalogPrompt().length);
  });
});

describe("small-model-mode rules", () => {
  it("sharpens the defer criteria to ACT-by-default (the §P9 intent-level lever)", () => {
    expect(SMALL_MODEL_RULES).toMatch(/ACT by default/);
    expect(SMALL_MODEL_RULES).toMatch(/ONLY when a required value is missing/);
  });

  it("keeps the string-id rule and is shorter than the default rules", async () => {
    const { DEFAULT_RULES } = await import("./brainCore");
    expect(SMALL_MODEL_RULES).toMatch(/JSON string/);
    expect(SMALL_MODEL_RULES.length).toBeLessThan(DEFAULT_RULES.length);
  });

  it("the examples variant appends WORKED_EXAMPLES verbatim", () => {
    expect(SMALL_MODEL_RULES_WITH_EXAMPLES).toBe(`${SMALL_MODEL_RULES}\n${WORKED_EXAMPLES}`);
  });

  it("every command emitted in WORKED_EXAMPLES stays in the keep-list (pruned-examples arm validity)", () => {
    const keep = new Set(SMALL_MODEL_KEEP);
    const referenced = [...WORKED_EXAMPLES.matchAll(/"command":"(\w+)"/g)].map((m) => m[1]);
    expect(referenced.length).toBeGreaterThan(0);
    for (const name of referenced) expect(keep.has(name), `WORKED_EXAMPLES uses ${name}, which the pruned catalog drops`).toBe(true);
  });
});
