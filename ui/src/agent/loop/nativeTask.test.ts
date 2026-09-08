import { beforeEach, describe, expect, it, vi } from "vitest";
import { useStore } from "../../store";
import { __resetMockForTests } from "../../bridge.mock";
import { createTaskExecutor } from "./taskExec";
import type { NativeTaskBinding } from "./nativeTask";

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
