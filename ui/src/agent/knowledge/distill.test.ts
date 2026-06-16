import { describe, it, expect } from "vitest";
import { parseDistilledCards } from "./distill";

// The vocabulary the loop's base arrangement provides + the in-the-box command subset.
const TOKENS = ["drumClipId", "hatsClipId", "keysClipId", "keysTrackId", "keysFilterPluginIndex", "keysFilterParamIndex", "busNumber"];
const COMMANDS = ["add_note", "quantize_notes", "humanize_notes", "add_automation_point", "create_bus", "add_send"];
const opts = { commands: COMMANDS, tokens: TOKENS };

const goodCard = {
  skill_name: "Trap hat roll",
  task_type: "drum_programming",
  genre_context: ["trap"],
  producer_intent: "fast 16th hat rolls",
  when: "trap hats need a rolling figure",
  commands: [{ command: "add_note", args: { clipId: "$hatsClipId", pitch: 42, start: 0, length: 0.25, velocity: 80 } }],
  check: { kind: "pattern", clip: "$hatsClipId", pattern: { hits: [{ pitch: 42, beats: [0] }] } },
};
const wrap = (...cards: unknown[]) => JSON.stringify({ cards });

// parseDistilledCards is the FIRST gate on a candidate from a non-TS source (LLM/YouTube):
// shape + known commands + known $tokens + known check kind. The loop (validateCommand +
// exec + runCheck) is the second, deeper gate. Hallucinations get rejected here, logged.
describe("parseDistilledCards — shape + known commands + known tokens + known check", () => {
  it("keeps a well-formed candidate", () => {
    const r = parseDistilledCards(wrap(goodCard), opts);
    expect(r.cards).toHaveLength(1);
    expect(r.rejects).toHaveLength(0);
    expect(r.cards[0].commands[0].command).toBe("add_note");
    expect(r.cards[0].check.kind).toBe("pattern");
    expect(r.cards[0].meta.skill_name).toBe("Trap hat roll");
  });
  it("rejects an unknown command (can't be exec'd)", () => {
    const bad = { ...goodCard, commands: [{ command: "summon_demon", args: {} }] };
    const r = parseDistilledCards(wrap(bad), opts);
    expect(r.cards).toHaveLength(0);
    expect(r.rejects[0].reason).toMatch(/summon_demon|unknown command/i);
  });
  it("rejects an unknown $token in a command arg", () => {
    const bad = { ...goodCard, commands: [{ command: "add_note", args: { clipId: "$ghostClip", pitch: 42, start: 0 } }] };
    const r = parseDistilledCards(wrap(bad), opts);
    expect(r.cards).toHaveLength(0);
    expect(r.rejects[0].reason).toMatch(/ghostClip|unknown token/i);
  });
  it("rejects an unknown $token in the check", () => {
    const bad = { ...goodCard, check: { kind: "pattern", clip: "$ghostClip", pattern: { hits: [{ pitch: 42, beats: [0] }] } } };
    const r = parseDistilledCards(wrap(bad), opts);
    expect(r.cards).toHaveLength(0);
    expect(r.rejects[0].reason).toMatch(/ghostClip|unknown token/i);
  });
  it("rejects an unknown check kind", () => {
    const bad = { ...goodCard, check: { kind: "vibe", clip: "$hatsClipId" } };
    const r = parseDistilledCards(wrap(bad), opts);
    expect(r.cards).toHaveLength(0);
    expect(r.rejects[0].reason).toMatch(/vibe|check kind/i);
  });
  it("rejects a candidate with no check", () => {
    const noCheck: any = { ...goodCard }; delete noCheck.check;
    expect(parseDistilledCards(wrap(noCheck), opts).cards).toHaveLength(0);
  });
  it("rejects a candidate with no commands", () => {
    const bad = { ...goodCard, commands: [] };
    expect(parseDistilledCards(wrap(bad), opts).cards).toHaveLength(0);
  });
  it("rejects a candidate missing skill_name", () => {
    const bad: any = { ...goodCard }; delete bad.skill_name;
    expect(parseDistilledCards(wrap(bad), opts).cards).toHaveLength(0);
  });
  it("keeps the good and rejects the bad in a mixed batch", () => {
    const bad = { ...goodCard, commands: [{ command: "nope", args: {} }] };
    const r = parseDistilledCards(wrap(goodCard, bad), opts);
    expect(r.cards).toHaveLength(1);
    expect(r.rejects).toHaveLength(1);
  });
  it("coerces an unknown task_type to 'other'", () => {
    const odd = { ...goodCard, task_type: "wizardry" };
    expect(parseDistilledCards(wrap(odd), opts).cards[0].meta.task_type).toBe("other");
  });
  it("tolerates code fences + prose around the JSON", () => {
    const fenced = "Sure! Here you go:\n```json\n" + wrap(goodCard) + "\n```\n";
    expect(parseDistilledCards(fenced, opts).cards).toHaveLength(1);
  });
  it("returns empty (no throw) on totally malformed input", () => {
    expect(parseDistilledCards("not json at all", opts).cards).toHaveLength(0);
  });
  it("salvages the complete cards when the array is TRUNCATED mid-card (flash cutoff)", () => {
    // a complete card1 + a half-written card2 with no closing brackets — exactly the
    // shape a token-limited model emits. The earlier complete card must survive.
    const c1 = JSON.stringify(goodCard);
    const truncated = `{"cards":[${c1},{"skill_name":"Half a card","task_type":"drum_programming","commands":[{"command":"add_note","args":{"clipId":"$drumClipId"`;
    const r = parseDistilledCards(truncated, opts);
    expect(r.cards).toHaveLength(1);
    expect(r.cards[0].meta.skill_name).toBe("Trap hat roll");
  });
});
