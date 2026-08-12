// M2 — the end-to-end wiring proof for createBrain (brain.ts): the `agentMemory`
// settings flag AND non-empty hydrated pools both gate whether a memory section ever
// reaches the LLM system prompt. Separate from brain.test.ts because it needs its own
// `../bridge` mock that actually answers agent_memory_read (brain.test.ts's mock
// deliberately omits executeCommand — see hydrate.ts's fail-soft-to-[] contract,
// which is what keeps brain.test.ts passing unmodified).

import { describe, it, expect, beforeEach, vi } from "vitest";
import type { Snapshot } from "../types";

const { brainChatMock, executeCommandMock } = vi.hoisted(() => ({
  brainChatMock: vi.fn(),
  executeCommandMock: vi.fn(),
}));
vi.mock("../bridge", () => ({
  brainChat: brainChatMock,
  executeCommand: executeCommandMock,
  // This suite reaches applySettingEffects (via useSettings), which fires a native-only,
  // fire-and-forget telemetry call. A partial vi.mock throws on
  // ACCESS to an undefined export, not on call, so the stub has to exist even though
  // nothing here asserts on telemetry.
  setTelemetryOptIn: vi.fn(async () => {}),
}));

import { createBrain } from "./brain";
import { useSettings } from "../settings/store";
import { __resetMemoryHydrationForTests } from "./memory/hydrate";

const snap: Snapshot = {
  schemaVersion: 1,
  session: { sampleRate: 48000, tempo: 120, timeSigNumerator: 4, timeSigDenominator: 4, metronome: false, key: { tonic: "C", mode: "major" }, length: 16, editFile: "" },
  tracks: [],
  transport: { playing: false, recording: false, position: 0, looping: false, loopStart: 0, loopEnd: 0 },
  master: { volumeDb: 0, pan: 0 },
};

const systemOfLastCall = (): string => {
  const calls = brainChatMock.mock.calls;
  const messages = calls[calls.length - 1][0] as { role: string; content: string }[];
  return messages[0].content;
};

// A believable agent_memory_read response for any {scope,kind} args — only the
// "preference"-kind global read carries an item; everything else is empty, so the
// test proves BOTH "memory shows up when relevant" and "an empty pool contributes
// nothing" in one fixture.
function mockReadResponses() {
  executeCommandMock.mockImplementation(async (cmd: unknown) => {
    const c = cmd as { command: string; args?: Record<string, unknown> };
    if (c.command !== "agent_memory_read") return { ok: false, error: "unexpected command" };
    if (c.args?.scope === "global" && c.args?.kind === "preference") {
      return { ok: true, data: { items: [{ ts: 1, kind: "preference", explicit: true, item: "always keep the low end wide" }] } };
    }
    return { ok: true, data: { items: [] } };
  });
}

describe("createBrain — M2 memory wiring (flag + non-empty pools gate)", () => {
  beforeEach(() => {
    brainChatMock.mockReset();
    executeCommandMock.mockReset();
    brainChatMock.mockResolvedValue({ content: '{"intent":"ACK_GOT_IT"}' });
    __resetMemoryHydrationForTests();
    useSettings.getState().set("agentMemory", true);
  });

  it("flag ON + a non-empty pool -> the memory section reaches the system prompt", async () => {
    mockReadResponses();
    const brain = createBrain(() => snap);
    await brain.send("what should I do with the low end");
    const sys = systemOfLastCall();
    expect(sys).toContain("Memory —");
    expect(sys).toContain("always keep the low end wide");
  });

  it("flag OFF -> no memory section AT ALL (not even the tool doc), and agent_memory_read is never called", async () => {
    mockReadResponses();
    useSettings.getState().set("agentMemory", false);
    const brain = createBrain(() => snap);
    await brain.send("what should I do with the low end");
    const sys = systemOfLastCall();
    expect(sys).not.toContain("Memory —");
    expect(sys).not.toContain("remember_preference");
    expect(executeCommandMock).not.toHaveBeenCalled();
  });

  it("flag ON but every pool empty -> STILL carries the remember_preference tool doc (M3), just no retrieved content", async () => {
    // M2's original contract here was "no memory section at all when pools are
    // empty" (byte-identical to pre-M2). M3 intentionally changes this: the
    // remember_preference doc must reach the model even on a fresh install with
    // nothing to retrieve yet (see brain.ts's memorySectionFor comment) — so the
    // section is now non-empty whenever the flag is on, period.
    executeCommandMock.mockResolvedValue({ ok: true, data: { items: [] } });
    const brain = createBrain(() => snap);
    await brain.send("what should I do with the low end");
    const sys = systemOfLastCall();
    expect(sys).toContain("remember_preference");
    expect(sys).not.toContain("Memory —");   // the retrieveContext header only appears with actual retrieved content
  });

  it("hydration is memoized across turns in the same session — one round of reads only", async () => {
    mockReadResponses();
    const brain = createBrain(() => snap);
    await brain.send("first turn");
    const callsAfterFirst = executeCommandMock.mock.calls.length;
    await brain.send("second turn");
    expect(executeCommandMock.mock.calls.length).toBe(callsAfterFirst); // no NEW reads
  });

  it("a hydration failure degrades gracefully (no retrieved content, no crash) — the tool doc is unaffected", async () => {
    // rememberPreferenceToolDoc() is pure/synchronous and never depends on
    // hydration succeeding — it's still there even when every read rejects.
    executeCommandMock.mockRejectedValue(new Error("native bridge unavailable"));
    const brain = createBrain(() => snap);
    const reply = await brain.send("what should I do with the low end");
    expect(reply.intent).toBe("ACK_GOT_IT");
    const sys = systemOfLastCall();
    expect(sys).toContain("remember_preference");
    expect(sys).not.toContain("Memory —");
  });
});
