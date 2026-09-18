import { beforeEach, describe, expect, it, vi } from "vitest";
import { __resetMockForTests, mockSnapshot } from "../../bridge.mock";
import type { Snapshot } from "../../types";
import type { AgentCommandCall } from "../destructiveScreen";
import type { AgentExecution } from "../loopSeam";
import type { LoopDeps } from "./loop";
import { runBoundedProposal } from "./boundedProposal";

const level = { command: "set_track_volume", args: { trackId: "lead", db: 3 } };
const room = { command: "set_track_volume", args: { trackId: "room", db: -6 } };

async function fixture(replies: readonly unknown[]) {
  const snapshot = await mockSnapshot<Snapshot>();
  let cursor = 0;
  const chat = vi.fn(async () => ({ content: JSON.stringify(replies[cursor++]) }));
  const runBatch = vi.fn(async (_label: string, calls: readonly AgentCommandCall[]) => ({
    results: calls.map((call) => ({ command: call.command, ok: true })), snapshot,
    execution: { requestId: "request-1", projectId: "project-1", status: "committed", appliedCount: calls.length } satisfies AgentExecution,
  }));
  const deps: LoopDeps & { bounded: { validate: (calls: readonly AgentCommandCall[]) => string | null } } = {
    chat, env: { getSnapshot: async () => snapshot, runBatch }, bounded: { validate: () => null },
  };
  return { deps, chat, runBatch, snapshot };
}

describe("bounded proposal preparation", () => {
  beforeEach(() => __resetMockForTests());

  it("collects every inline plan command before exactly one application", async () => {
    const { deps, runBatch } = await fixture([{ status: "continue", plan: [
      { goal: "lead level", commands: [level] }, { goal: "printed room", commands: [room] },
    ] }]);

    const run = await runBoundedProposal({ ask: "raise the vocal and lower the room" }, deps);

    expect(runBatch).toHaveBeenCalledTimes(1);
    expect(runBatch.mock.calls[0]?.[1]).toEqual([level, room]);
    expect(run.outcome).toBe("done");
    expect(run.transcript).toHaveLength(1);
  });

  it("keeps all goal compilation waits before application against one original snapshot", async () => {
    const { deps, runBatch, snapshot } = await fixture([]);
    const messages: string[] = [];
    let release = () => {};
    const pause = new Promise<void>((resolve) => { release = resolve; });
    let reachedPause = () => {};
    const paused = new Promise<void>((resolve) => { reachedPause = resolve; });
    let calls = 0;
    deps.chat = async (request) => {
      messages.push(request[0]?.content ?? "");
      expect(runBatch).not.toHaveBeenCalled();
      calls++;
      if (calls === 1) return { content: JSON.stringify({ status: "continue", plan: [{ goal: "level" }, { goal: "room" }] }) };
      if (calls === 3) { reachedPause(); await pause; }
      return { content: JSON.stringify({ status: "done", commands: [calls === 2 ? level : room] }) };
    };
    const getSnapshot = vi.fn(async () => snapshot);
    deps.env.getSnapshot = getSnapshot;

    const running = runBoundedProposal({ ask: "level then room" }, deps);
    await paused;

    expect(runBatch).not.toHaveBeenCalled();
    release();
    const run = await running;
    expect(getSnapshot).toHaveBeenCalledTimes(1);
    expect(new Set(messages).size).toBe(1);
    expect(runBatch.mock.calls[0]?.[1]).toEqual([level, room]);
    expect(run.stepCount).toBe(1);
  });

  it("collects incremental commands without pretending pending changes have applied", async () => {
    const { deps, runBatch, chat } = await fixture([
      { status: "continue", commands: [level] }, { status: "done", commands: [room] },
    ]);

    const run = await runBoundedProposal({ ask: "level and room" }, deps);

    expect(chat).toHaveBeenCalledTimes(2);
    expect(runBatch).toHaveBeenCalledTimes(1);
    expect(runBatch.mock.calls[0]?.[1]).toEqual([level, room]);
    expect(run.say).toBe("Committed 2 change(s).");
  });

  it.each([
    { command: "set_track_volume", args: [] },
    { args: { trackId: "room", db: -6 } },
    { ...room, unexpected: true },
    null,
  ])("rejects the entire proposal when one command member is malformed: %j", async (malformed) => {
    const { deps, runBatch } = await fixture([{ status: "done", commands: [level, malformed] }]);

    const run = await runBoundedProposal({ ask: "level and room" }, deps);

    expect(runBatch).not.toHaveBeenCalled();
    expect(run.outcome).toBe("need_user");
    expect(run.say).toContain("no changes were applied");
  });

  it("rejects unknown reply fields and never trusts optimistic prose", async () => {
    const { deps, runBatch } = await fixture([{ status: "done", commands: [level], say: "I applied everything", surprise: true }]);

    const run = await runBoundedProposal({ ask: "level" }, deps);

    expect(runBatch).not.toHaveBeenCalled();
    expect(run.say).not.toContain("I applied everything");
  });

  it("discards already collected commands when a later provider asks for clarification", async () => {
    const { deps, runBatch } = await fixture([
      { status: "continue", commands: [level] }, { status: "need_user", say: "I applied the level" },
    ]);

    const run = await runBoundedProposal({ ask: "level then room" }, deps);

    expect(runBatch).not.toHaveBeenCalled();
    expect(run.outcome).toBe("need_user");
    expect(run.say).toContain("no changes were applied");
  });

  it("cancels before apply even when the provider claims success", async () => {
    const { deps, runBatch } = await fixture([]);
    const signal = { aborted: false };
    deps.signal = signal;
    deps.chat = async () => {
      signal.aborted = true;
      return { content: JSON.stringify({ status: "done", commands: [level], say: "The vocal is louder now" }) };
    };

    const run = await runBoundedProposal({ ask: "level" }, deps);

    expect(runBatch).not.toHaveBeenCalled();
    expect(run.outcome).toBe("aborted");
    expect(run.say).toBe("Stopped before application; no changes were applied.");
  });

  it("checks cancellation again after the final progress callback", async () => {
    const { deps, runBatch } = await fixture([{ status: "done", commands: [level] }]);
    const signal = { aborted: false };
    deps.signal = signal;
    deps.onProgress = (event) => { if (event.kind === "step-start") signal.aborted = true; };

    const run = await runBoundedProposal({ ask: "level" }, deps);

    expect(runBatch).not.toHaveBeenCalled();
    expect(run.outcome).toBe("aborted");
  });

  it("refuses the complete patch when any allowed-control validation fails", async () => {
    const { deps, runBatch } = await fixture([{ status: "done", commands: [level, room] }]);
    deps.bounded.validate = () => "room is protected";

    const run = await runBoundedProposal({ ask: "level and room" }, deps);

    expect(runBatch).not.toHaveBeenCalled();
    expect(run.say).toContain("room is protected");
  });

  it("does not apply an incremental proposal that grows beyond six commands", async () => {
    const { deps, runBatch } = await fixture([
      { status: "continue", commands: Array.from({ length: 6 }, () => level) },
      { status: "done", commands: [room] },
    ]);

    const run = await runBoundedProposal({ ask: "too many commands" }, deps);

    expect(runBatch).not.toHaveBeenCalled();
    expect(run.say).toContain("exceeds six");
  });

  it.each(["rolled_back", "unresolved", "rejected", "prepared", "undone", "cancelled"] as const)(
    "presents the native %s result instead of provider success", async (status) => {
      const { deps, snapshot } = await fixture([{ status: "done", commands: [level, room], say: "The mix is fixed" }]);
      const execution: AgentExecution = { requestId: "request-1", projectId: "project-1", status, appliedCount: status === "unresolved" ? 1 : 0 };
      deps.env.runBatch = async () => ({ snapshot, execution, results: [
        { command: level.command, ok: true, disposition: "rolled_back" },
        { command: room.command, ok: false, disposition: "refused", error: "native refusal" },
      ] });

      const run = await runBoundedProposal({ ask: "level and room" }, deps);

      expect(run.outcome).not.toBe("done");
      expect(run.say).not.toContain("The mix is fixed");
      expect(run.execution).toBe(execution);
      expect(run.transcript[0]?.results[0]?.disposition).toBe("rolled_back");
      expect(run.transcript[0]?.results[1]?.error).toBe("native refusal");
    },
  );

  it("reports committed effects when observation is cancelled without claiming rollback", async () => {
    const { deps, snapshot } = await fixture([{ status: "done", commands: [level] }]);
    const signal = { aborted: false };
    deps.signal = signal;
    deps.env.runBatch = async () => {
      signal.aborted = true;
      return { snapshot, results: [{ command: level.command, ok: true }], execution: {
        requestId: "request-1", projectId: "project-1", status: "committed", appliedCount: 1,
      } };
    };

    const run = await runBoundedProposal({ ask: "level" }, deps);

    expect(run.outcome).toBe("aborted");
    expect(run.say).toBe("Changes committed; observation was cancelled. Nothing was rolled back.");
  });
});
