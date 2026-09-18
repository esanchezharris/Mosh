import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useStore } from "../../store";
import { __resetMockForTests } from "../../bridge.mock";
import { createTaskExecutor } from "./taskExec";
import type { NativeTaskBinding } from "./nativeTask";
import { undoNativeTask } from "./nativeTask";
import type { AgentExecution } from "../loopSeam";

describe("bounded native task adapter", () => {
  beforeEach(async () => { __resetMockForTests(); await useStore.getState().refresh(); });
  function fixture(status = "committed") {
    const snapshot = useStore.getState().snapshot;
    if (!snapshot) throw new Error("missing fixture snapshot");
    const binding: NativeTaskBinding = {
      requestId: "logical-1", payload: { ask: "test" },
      context: { projectId: "project", epoch: "epoch", revision: 17, snapshot, requests: [] }, validate: () => null,
    };
    const calls = [
      { command: "set_track_volume", args: { trackId: "lead", db: 3 } },
      { command: "set_track_volume", args: { trackId: "room", db: -6 } },
    ];
    const signal = { aborted: false };
    const exec = vi.fn(async (command: string, _args?: Record<string, unknown>) => ({ ok: status === "committed", data: {
      requestId: "logical-1", projectId: "project", status: command === "cancel_agent_request" ? "cancelled" : status,
      appliedCount: command === "cancel_agent_request" ? 0 : 2,
      results: command === "cancel_agent_request" ? [] : calls.map((call) => ({ command: call.command, ok: true })),
    } }));
    const refresh = vi.fn(async () => undefined);
    return { binding, calls, signal, exec, refresh };
  }
  it("sends the complete patch once with the frozen native precondition, then observes", async () => {
    const f = fixture();
    const executor = createTaskExecutor("test", {}, { ...f, bounded: f.binding });
    expect(await executor.env.getSnapshot()).toBe(f.binding.context.snapshot);
    expect(f.exec).not.toHaveBeenCalled();
    const result = await executor.env.runBatch("all", f.calls);
    await executor.close();
    expect(f.exec.mock.calls).toEqual([["apply_agent_patch", {
      requestId: "logical-1", projectId: "project", payload: { ask: "test" }, epoch: "epoch", revision: 17, commands: f.calls,
    }, "producer_v0"]]);
    expect(f.refresh).toHaveBeenCalledOnce();
    expect(result.execution?.status).toBe("committed");
    expect(result.results.map((r) => r.disposition)).toEqual(["applied", "applied"]);
    await expect(executor.env.runBatch("again", f.calls)).rejects.toThrow("only once");
  });
  it("cancel before apply sends no patch or generic batch", async () => {
    const f = fixture(); f.signal.aborted = true;
    const executor = createTaskExecutor("test", {}, { ...f, bounded: f.binding });
    const result = await executor.env.runBatch("all", f.calls);
    expect(f.exec.mock.calls.map((c) => c[0])).toEqual(["cancel_agent_request"]);
    expect(result.execution?.status).toBe("cancelled");
  });
  it("retains native partial results and marks exact rollback", async () => {
    const f = fixture("rolled_back");
    f.exec.mockImplementation(async () => ({ ok: false, data: {
      requestId: "logical-1", projectId: "project", status: "rolled_back", appliedCount: 1,
      results: [{ command: "set_track_volume", ok: true }, { command: "set_track_volume", ok: false }],
    } }));
    const result = await createTaskExecutor("test", {}, { ...f, bounded: f.binding }).env.runBatch("all", f.calls);
    expect(result.results.map((r) => [r.ok, r.disposition])).toEqual([[true, "rolled_back"], [false, "refused"]]);
    expect(result.execution?.appliedCount).toBe(1);
  });
  it("unknown native delivery is looked up, never reapplied", async () => {
    const f = fixture(); f.exec.mockRejectedValueOnce(new Error("connection lost"));
    const result = await createTaskExecutor("test", {}, { ...f, bounded: f.binding }).env.runBatch("all", f.calls);
    expect(f.exec.mock.calls.map((c) => c[0])).toEqual(["apply_agent_patch", "get_agent_request"]);
    expect(result.execution?.status).toBe("committed");
  });
  it("preserves uncertainty when both response and status are unavailable", async () => {
    const f = fixture(); f.exec.mockRejectedValue(new Error("connection lost"));
    const result = await createTaskExecutor("test", {}, { ...f, bounded: f.binding }).env.runBatch("all", f.calls);
    expect(result.execution?.status).toBe("unresolved");
    expect(result.execution?.error).toContain("effects are unknown");
    expect(result.results.every((r) => !r.ok)).toBe(true);
  });
  it("rejects a host-invalid complete patch before any write", async () => {
    const f = fixture(); f.binding.validate = () => "protected track";
    const result = await createTaskExecutor("test", {}, { ...f, bounded: f.binding }).env.runBatch("all", f.calls);
    expect(f.exec.mock.calls.map((c) => c[0])).toEqual(["cancel_agent_request"]);
    expect(result.execution?.status).toBe("rejected");
  });
});

describe("native task undo outcome and observation", () => {
  const originalExec = useStore.getState().exec;
  const originalRefresh = useStore.getState().refresh;
  const committed: AgentExecution = { requestId: "undo-request", projectId: "project", status: "committed", appliedCount: 2 };
  const undone: AgentExecution = { ...committed, status: "undone" };
  const identity = { requestId: committed.requestId, projectId: committed.projectId };

  afterEach(() => useStore.setState({ exec: originalExec, refresh: originalRefresh }));

  function fixture() {
    const exec = vi.fn<typeof originalExec>();
    const refresh = vi.fn(async () => undefined);
    useStore.setState({ exec, refresh });
    return { exec, refresh };
  }

  it("retains proven native undo when fresh observation fails", async () => {
    const { exec, refresh } = fixture();
    exec.mockResolvedValue({ ok: true, command: "undo_agent_request", data: undone });
    refresh.mockRejectedValue(new Error("snapshot unavailable"));

    const result = await undoNativeTask(committed);

    expect(result.ok).toBe(true);
    expect(result.execution?.status).toBe("undone");
    expect(result.message).toMatch(/undone.*observation.*unavailable/i);
    expect(result.message).not.toMatch(/refused/i);
    expect(exec.mock.calls.map((call) => call[0])).toEqual(["undo_agent_request"]);
  });

  it("looks up a lost undo response exactly once without repeating undo", async () => {
    const { exec, refresh } = fixture();
    exec.mockRejectedValueOnce(new Error("undo response lost"))
      .mockResolvedValueOnce({ ok: true, command: "get_agent_request", data: undone });

    const result = await undoNativeTask(committed);

    expect(result.ok).toBe(true);
    expect(result.execution?.status).toBe("undone");
    expect(exec.mock.calls).toEqual([
      ["undo_agent_request", identity, undefined, "producer_v0"],
      ["get_agent_request", identity, undefined, "producer_v0"],
    ]);
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it("reports unconfirmed undo when both delivery and outcome lookup are unavailable", async () => {
    const { exec, refresh } = fixture();
    exec.mockRejectedValue(new Error("native bridge unavailable"));

    const result = await undoNativeTask(committed);

    expect(result.ok).toBe(false);
    expect(result.message).toMatch(/unconfirmed|unresolved|unknown/i);
    expect(result.message).not.toMatch(/refused|Task undone|no changes/i);
    expect(result.execution?.status).not.toBe("undone");
    expect(exec.mock.calls.map((call) => call[0])).toEqual(["undo_agent_request", "get_agent_request"]);
    expect(refresh).not.toHaveBeenCalled();
  });

  it("retains a known native refusal when outcome lookup still reports committed", async () => {
    const { exec } = fixture();
    exec.mockResolvedValueOnce({ ok: false, command: "undo_agent_request", error: "undo_head_mismatch: newer manual work" })
      .mockResolvedValueOnce({ ok: true, command: "get_agent_request", data: committed });

    const result = await undoNativeTask(committed);

    expect(result.ok).toBe(false);
    expect(result.execution?.status).toBe("committed");
    expect(result.message).toContain("newer manual work");
    expect(result.message).toMatch(/refused/i);
    expect(exec.mock.calls.map((call) => call[0])).toEqual(["undo_agent_request", "get_agent_request"]);
  });
});
