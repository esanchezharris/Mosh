// Offline unit test for the brain scorer — no API keys, no network. Guards the
// deterministic grading the live matrix relies on (scripts/brainBench.mts).

import { describe, it, expect } from "vitest";
import { scoreReply } from "./brainScore";
import { CASES } from "./brainCases";

const byId = (id: string) => {
  const c = CASES.find((x) => x.id === id);
  if (!c) throw new Error(`no such case ${id}`);
  return c;
};

describe("brainScore", () => {
  it("passes a correct, grounded action", () => {
    const r = scoreReply(
      '{"intent":"ACK_GOT_IT","commands":[{"command":"set_track_mute","args":{"trackId":"t-drums","mute":true}}]}',
      byId("mute-drums"),
    );
    expect(r.pass).toBe(true);
  });

  it("tolerates code-fenced JSON (the parser strips fences)", () => {
    const r = scoreReply(
      '```json\n{"intent":"DONE","commands":[{"command":"create_track","args":{}}]}\n```',
      byId("create-track"),
    );
    expect(r.parsed).toBe(true);
    expect(r.pass).toBe(true);
  });

  it("rejects an invented id (ungrounded target)", () => {
    const r = scoreReply(
      '{"intent":"ACK_GOT_IT","commands":[{"command":"set_track_mute","args":{"trackId":"t-nope","mute":true}}]}',
      byId("mute-drums"),
    );
    expect(r.commandsValid).toBe(false);
    expect(r.pass).toBe(false);
  });

  it("rejects targeting the wrong track", () => {
    const r = scoreReply(
      '{"intent":"ACK_GOT_IT","commands":[{"command":"set_track_mute","args":{"trackId":"t-bass","mute":true}}]}',
      byId("mute-drums"),
    );
    expect(r.expectationOk).toBe(false);
  });

  it("flags an unknown command via the catalog", () => {
    const r = scoreReply(
      '{"intent":"ACK_GOT_IT","commands":[{"command":"frobnicate","args":{}}]}',
      byId("create-track"),
    );
    expect(r.commandsValid).toBe(false);
  });

  it("requires an action request to emit at least one command", () => {
    const r = scoreReply('{"intent":"ACK_GOT_IT"}', byId("mute-drums"));
    expect(r.expectationOk).toBe(false);
  });

  it("fails a non-JSON reply", () => {
    const r = scoreReply("uhh, I'm not sure what you mean", byId("mute-drums"));
    expect(r.parsed).toBe(false);
    expect(r.pass).toBe(false);
  });

  it("accepts a deferral on an ambiguous request", () => {
    const r = scoreReply('{"intent":"HUH","say":"which part?"}', byId("too-vague"));
    expect(r.pass).toBe(true);
  });

  it("fails a deferral that still emits commands", () => {
    const r = scoreReply(
      '{"intent":"HUH","commands":[{"command":"save","args":{}}]}',
      byId("too-vague"),
    );
    expect(r.pass).toBe(false);
  });

  it("scores every golden case without throwing", () => {
    for (const c of CASES) {
      const r = scoreReply('{"intent":"HUH"}', c);
      expect(r.id).toBe(c.id);
      expect(typeof r.pass).toBe("boolean");
    }
  });
});
