import { describe, it, expect } from "vitest";
import { parseReply } from "./parseReply";

// parseReply is the most fragile link in the agent loop: it must pull a single
// JSON object out of whatever prose an LLM returns. These lock its behaviour.
describe("parseReply", () => {
  it("parses a clean JSON object with commands", () => {
    const r = parseReply('{"intent":"ACK_GOT_IT","say":"ok","commands":[{"command":"create_track","args":{"name":"Drums"}}]}');
    expect(r.intent).toBe("ACK_GOT_IT");
    expect(r.say).toBe("ok");
    expect(r.commands).toHaveLength(1);
    expect(r.commands?.[0].command).toBe("create_track");
  });

  it("strips ```json fences", () => {
    expect(parseReply('```json\n{"intent":"DONE"}\n```').intent).toBe("DONE");
  });

  it("extracts a JSON object embedded in prose", () => {
    const r = parseReply('Sure thing! {"intent":"ACK_GOT_IT","say":"done"} hope that helps');
    expect(r.intent).toBe("ACK_GOT_IT");
    expect(r.say).toBe("done");
  });

  it("drops command entries without a string command name", () => {
    const r = parseReply('{"intent":"ACK_GOT_IT","commands":[{"command":"create_track"},{"args":{}},{"command":123}]}');
    expect(r.commands).toHaveLength(1);
    expect(r.commands?.[0].command).toBe("create_track");
  });

  it("falls back to HUH on unparseable content", () => {
    const r = parseReply("totally not json");
    expect(r.intent).toBe("HUH");
    expect(r.commands).toBeUndefined();
  });

  it("ignores non-string say / intent", () => {
    const r = parseReply('{"intent":5,"say":{"x":1}}');
    expect(r.intent).toBeUndefined();
    expect(r.say).toBeUndefined();
  });
});
