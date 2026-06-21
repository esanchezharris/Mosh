import { describe, it, expect } from "vitest";
import { TUPLE_SCHEMA_VERSION, isAgentCallable } from "./tupleSchema";

describe("tupleSchema", () => {
  it("pins the tuple schema version at 1", () => {
    expect(TUPLE_SCHEMA_VERSION).toBe(1);
  });

  it("isAgentCallable is true only for catalog (agent-callable) commands", () => {
    expect(isAgentCallable("create_track")).toBe(true);
    expect(isAgentCallable("split_clip")).toBe(true);
    // structural delimiters are not agent-callable edits
    expect(isAgentCallable("batch_begin")).toBe(false);
    expect(isAgentCallable("batch_end")).toBe(false);
    // backend-only / unknown
    expect(isAgentCallable("get_snapshot")).toBe(false);
    expect(isAgentCallable("definitely_not_a_command")).toBe(false);
  });
});
