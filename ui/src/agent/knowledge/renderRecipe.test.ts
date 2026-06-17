import { describe, it, expect } from "vitest";
import { renderRecipeExample } from "./renderRecipe";
import { VALIDATED_CARDS } from "./cards.data";
import { BASE_TOKENS } from "./distillPrompt";
import { AGENT_COMMAND_MAP } from "../commands";
import type { TechniqueCard } from "./card";

// Inline one-per-family fixtures (the real card shapes), so these logic tests don't couple to
// which specific card id survives bake-time dedup. The guard/spot-check tests below DO iterate
// the real shipped VALIDATED_CARDS for bundle coverage.
const card = (commands: { command: string; args: Record<string, unknown> }[], over: Partial<TechniqueCard> = {}): TechniqueCard => ({
  id: "t", source: "distill", skill_name: "t", task_type: "drum_programming",
  genre_context: ["boom-bap"], producer_intent: "p", when: "w",
  recipe: { kind: "recipe", commands }, evidence: [], confidence: 0.75, status: "conformant", ...over,
});
const BOOMBAP = card([
  { command: "add_note", args: { clipId: "$drumClipId", pitch: 36, start: 0, length: 0.25, velocity: 110 } },
  { command: "add_note", args: { clipId: "$drumClipId", pitch: 36, start: 2.5, length: 0.25, velocity: 110 } },
  { command: "add_note", args: { clipId: "$drumClipId", pitch: 38, start: 1, length: 0.25, velocity: 100 } },
  { command: "add_note", args: { clipId: "$drumClipId", pitch: 38, start: 3, length: 0.25, velocity: 100 } },
  { command: "add_note", args: { clipId: "$drumClipId", pitch: 42, start: 0, length: 0.25, velocity: 80 } },
]);
const SWING = card([{ command: "quantize_notes", args: { clipId: "$hatsClipId", division: 0.5, strength: 1, swing: 0.58 } }]);
const HUMANIZE = card([{ command: "humanize_notes", args: { clipId: "$keysClipId", timing: 0.2, velocity: 0.3, seed: 42 } }]);
const AUTOMATION = card([
  { command: "add_automation_point", args: { trackId: "$keysTrackId", pluginIndex: "$keysFilterPluginIndex", paramIndex: "$keysFilterParamIndex", time: 0, value: 0.2 } },
  { command: "add_automation_point", args: { trackId: "$keysTrackId", pluginIndex: "$keysFilterPluginIndex", paramIndex: "$keysFilterParamIndex", time: 4, value: 0.9 } },
]);
const SEND = card([
  { command: "create_bus", args: { name: "Reverb" } },
  { command: "add_send", args: { trackId: "$keysTrackId", bus: "$busNumber", db: -12 } },
]);
const PROMPT_CARD = card([], { recipe: { kind: "prompt", guidance: "dusty boom-bap drums" } });

describe("renderRecipeExample — turns a recipe card's commands into a worked example", () => {
  it("renders an add_note grid as one line per drum voice with names + beats", () => {
    const out = renderRecipeExample(BOOMBAP);
    // kick(36) on beats 0 and 2.5, snare(38) on 1 and 3, hat(42) at 0
    expect(out).toContain("kick(36)");
    expect(out).toContain("snare(38)");
    expect(out).toContain("hat(42)");
    expect(out).toContain("@0,2.5"); // kick beats
    expect(out).toContain("@1,3"); // snare beats
    // the target is named in prose, and the agent is steered to use the real id
    expect(out).toContain("the drum clip");
    expect(out.toLowerCase()).toContain("real");
  });

  it("renders quantize_notes with the LITERAL numeric division (not a '1/8' string that fails validateCommand)", () => {
    const out = renderRecipeExample(SWING);
    expect(out).toContain("division 0.5"); // the exact number arg the command takes
    expect(out).toContain("swing 0.58");
    expect(out).not.toContain("1/8"); // never show the fraction near a number arg — the model copies it as a string
    expect(out).toContain("the hats clip");
  });

  it("renders humanize_notes with its concrete params", () => {
    const out = renderRecipeExample(HUMANIZE);
    expect(out).toContain("timing 0.2");
    expect(out).toContain("velocity 0.3");
    expect(out).toContain("seed 42");
    expect(out).toContain("the keys clip");
  });

  it("renders add_automation_point as a from→to sweep, index read from the snapshot", () => {
    const out = renderRecipeExample(AUTOMATION);
    expect(out.toLowerCase()).toContain("automate");
    expect(out).toContain("0.2"); // first value
    expect(out).toContain("0.9"); // last value
    expect(out).toContain("the keys filter");
    // never a guessed numeric index — steer to read it from the snapshot fx line
    expect(out).toContain("fx:");
  });

  it("renders create_bus + add_send as a shared-send clause", () => {
    const out = renderRecipeExample(SEND);
    expect(out.toLowerCase()).toContain("send bus");
    expect(out).toContain("the keys track");
    expect(out).toContain("-12"); // db
  });

  it("returns an empty string for a prompt-kind card (only recipe cards render)", () => {
    expect(renderRecipeExample(PROMPT_CARD)).toBe("");
  });

  it("labels a plugin sensibly even if a future card stores a NUMERIC pluginIndex", () => {
    const card: TechniqueCard = {
      id: "x", source: "distill", skill_name: "x", task_type: "mixing",
      genre_context: [], producer_intent: "p", when: "w",
      recipe: { kind: "recipe", commands: [
        { command: "add_automation_point", args: { trackId: "$keysTrackId", pluginIndex: 0, paramIndex: 1, time: 0, value: 0.2 } },
        { command: "add_automation_point", args: { trackId: "$keysTrackId", pluginIndex: 0, paramIndex: 1, time: 4, value: 0.9 } },
      ] },
      evidence: [], confidence: 0.5, status: "conformant",
    };
    const out = renderRecipeExample(card);
    expect(out).not.toContain("the target clip/track"); // not the generic CLIP fallback for a plugin
    expect(out.toLowerCase()).toContain("filter"); // a plugin-appropriate label
    expect(out).not.toContain("$");
  });

  // The load-bearing anti-leak / anti-hallucination guard, over EVERY shipped recipe card.
  describe("guard: no $token / id leak and no array-valued pitch across all shipped recipe cards", () => {
    const recipeCards = VALIDATED_CARDS.filter((c) => c.recipe.kind === "recipe");
    it("has recipe cards to check", () => expect(recipeCards.length).toBeGreaterThan(0));
    for (const card of recipeCards) {
      it(`${card.id} (${card.skill_name}) renders cleanly`, () => {
        const out = renderRecipeExample(card);
        expect(out.length).toBeGreaterThan(0);
        // no literal $token (e.g. "$drumClipId") ever reaches the prompt
        expect(out).not.toContain("$");
        // no raw BASE_TOKEN substring (e.g. "drumClipId") even without the $
        for (const tok of BASE_TOKENS) expect(out).not.toContain(tok);
        // no fabricated/snapshot id leaks (the renderer is snapshot-independent)
        for (const id of ["c-drum", "c-hats", "c-keys", "t-drums", "t-hats", "t-keys"]) expect(out).not.toContain(id);
        // never imply an array-valued pitch/clipId (would fail validateCommand's number check)
        expect(out).not.toContain("[");
        expect(out).not.toContain("pitch=[");
      });
    }
  });

  // Spot-check: every command a recipe card uses is a real catalog command (so a worked
  // example can never teach a non-catalog command the eval would flag as a hallucination).
  it("references only catalog commands across all shipped recipe cards", () => {
    for (const card of VALIDATED_CARDS) {
      if (card.recipe.kind !== "recipe") continue;
      for (const cmd of card.recipe.commands) expect(AGENT_COMMAND_MAP.has(cmd.command)).toBe(true);
    }
  });
});
