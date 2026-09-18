import { beforeEach, describe, expect, it } from "vitest";
import { __resetMockForTests, mockExecute } from "./bridge.mock";
import type { CommandResult, Snapshot } from "./types";

// The mock mirror of MoshOps.AgentRequest.cpp: the Producer bounded-request lifecycle that
// ui/src/agent/loop/nativeTask.ts drives. Those unit tests stub `exec`, so without this file
// nothing proves the dev mock actually answers the six commands (AL-017 fails them closed).

const run = (command: string, args: Record<string, unknown> = {}) =>
  mockExecute<CommandResult>({ command, args });

type Status = { status: string; appliedCount: number; undoable: boolean; replayed: boolean; results?: unknown[] };
const data = (r: CommandResult) => r.data as Status;

async function context() {
  const ctx = await run("get_agent_context");
  expect(ctx.ok).toBe(true);
  return ctx.data as { projectId: string; epoch: string; revision: number; snapshot: Snapshot; requests: unknown[] };
}

describe("bridge.mock — producer bounded-request lifecycle", () => {
  beforeEach(() => __resetMockForTests());

  it("get_agent_context carries a snapshot the nativeTask schema accepts and an empty ledger", async () => {
    const ctx = await context();
    expect(ctx.projectId).toBeTruthy();
    expect(ctx.epoch).toBeTruthy();
    expect(typeof ctx.revision).toBe("number");
    expect(Array.isArray(ctx.snapshot.tracks)).toBe(true);
    expect(ctx.requests).toEqual([]);
  });

  it("begin → apply → committed, visible in the ledger, then undone exactly once", async () => {
    const ctx = await context();
    const trackId = ctx.snapshot.tracks[0].id;
    const before = ctx.snapshot.tracks[0].volumeDb ?? 0;
    const identity = { requestId: "req-1", projectId: ctx.projectId, payload: { ask: "louder" } };

    const begun = await run("begin_agent_request", identity);
    expect(begun.ok).toBe(true);
    expect(data(begun).status).toBe("prepared");

    const applied = await run("apply_agent_patch", {
      ...identity, epoch: ctx.epoch, revision: ctx.revision,
      commands: [{ command: "set_track_volume", args: { trackId, db: before + 3 } }],
    });
    expect(applied.ok).toBe(true);
    expect(data(applied).status).toBe("committed");
    expect(data(applied).appliedCount).toBe(1);
    expect(data(applied).undoable).toBe(true);

    const after = await context();
    expect(after.snapshot.tracks[0].volumeDb ?? 0).toBeCloseTo(before + 3);
    expect((after.requests[0] as Status).status).toBe("committed");

    const status = await run("get_agent_request", { requestId: "req-1", projectId: ctx.projectId });
    expect(status.ok).toBe(true);
    expect(data(status).results).toHaveLength(1);

    const undone = await run("undo_agent_request", { requestId: "req-1", projectId: ctx.projectId });
    expect(undone.ok).toBe(true);
    expect(data(undone).status).toBe("undone");
    expect((await context()).snapshot.tracks[0].volumeDb ?? 0).toBeCloseTo(before);

    const again = await run("undo_agent_request", { requestId: "req-1", projectId: ctx.projectId });
    expect(again.ok).toBe(true);
    expect(data(again).replayed).toBe(true);
  });

  it("a failing inner command rolls the whole patch back and reports the failure", async () => {
    const ctx = await context();
    const trackId = ctx.snapshot.tracks[0].id;
    const before = ctx.snapshot.tracks[0].volumeDb ?? 0;
    const identity = { requestId: "req-2", projectId: ctx.projectId, payload: {} };
    await run("begin_agent_request", identity);
    const applied = await run("apply_agent_patch", {
      ...identity, epoch: ctx.epoch, revision: ctx.revision,
      commands: [
        { command: "set_track_volume", args: { trackId, db: before + 3 } },
        { command: "set_track_volume", args: { trackId: "no-such-track", db: 0 } },
      ],
    });
    expect(applied.ok).toBe(false);
    expect(data(applied).status).toBe("rolled_back");
    expect(data(applied).appliedCount).toBe(1);
    expect((await context()).snapshot.tracks[0].volumeDb ?? 0).toBeCloseTo(before);
  });

  it("refuses the engine's refusals: identity, unknown request, stale context, unsupported and oversize patches", async () => {
    const ctx = await context();
    expect((await run("get_agent_request", { requestId: "", projectId: ctx.projectId })).error).toMatch(/invalid_request_identity/);
    expect((await run("get_agent_request", { requestId: "nope", projectId: "other" })).error).toMatch(/project_conflict/);
    expect((await run("get_agent_request", { requestId: "nope", projectId: ctx.projectId })).error).toMatch(/unknown_request/);
    expect((await run("begin_agent_request", { requestId: "r", projectId: ctx.projectId })).error).toMatch(/payload_required/);

    const identity = { requestId: "req-3", projectId: ctx.projectId, payload: { a: 1 } };
    await run("begin_agent_request", identity);
    expect((await run("get_agent_request", { ...identity, payload: { a: 2 } })).error).toMatch(/request_identity_conflict/);

    const stale = await run("apply_agent_patch", { ...identity, epoch: ctx.epoch, revision: ctx.revision + 1,
      commands: [{ command: "set_track_volume", args: { trackId: ctx.snapshot.tracks[0].id, db: 0 } }] });
    expect(stale.error).toMatch(/stale_agent_context/);
    expect(data(stale).status).toBe("cancelled");   // a refusal cancels the request, as in the engine

    const identity4 = { requestId: "req-4", projectId: ctx.projectId, payload: {} };
    await run("begin_agent_request", identity4);
    const unsupported = await run("apply_agent_patch", { ...identity4, epoch: ctx.epoch, revision: ctx.revision,
      commands: [{ command: "remove_track", args: { trackId: ctx.snapshot.tracks[0].id } }] });
    expect(unsupported.error).toMatch(/unsupported_bounded_command/);

    const identity5 = { requestId: "req-5", projectId: ctx.projectId, payload: {} };
    await run("begin_agent_request", identity5);
    const oversize = await run("apply_agent_patch", { ...identity5, epoch: ctx.epoch, revision: ctx.revision,
      commands: Array.from({ length: 7 }, () => ({ command: "set_track_volume", args: { trackId: ctx.snapshot.tracks[0].id, db: 0 } })) });
    expect(oversize.error).toMatch(/invalid_bounded_patch/);
  });

  it("begin is idempotent for the same identity and cancel closes a prepared request", async () => {
    const ctx = await context();
    const identity = { requestId: "req-6", projectId: ctx.projectId, payload: { ask: "x" } };
    await run("begin_agent_request", identity);
    const replay = await run("begin_agent_request", identity);
    expect(replay.ok).toBe(true);
    expect(data(replay).replayed).toBe(true);
    const cancelled = await run("cancel_agent_request", identity);
    expect(cancelled.ok).toBe(true);
    expect(data(cancelled).status).toBe("cancelled");
    const applied = await run("apply_agent_patch", { ...identity, epoch: ctx.epoch, revision: ctx.revision,
      commands: [{ command: "set_track_volume", args: { trackId: ctx.snapshot.tracks[0].id, db: 0 } }] });
    expect(applied.ok).toBe(true);           // engine: a non-prepared request replays its status
    expect(data(applied).status).toBe("cancelled");
    expect(data(applied).replayed).toBe(true);
  });

  it("a later ordinary edit takes the undo head, so the request is no longer undoable", async () => {
    const ctx = await context();
    const trackId = ctx.snapshot.tracks[0].id;
    const identity = { requestId: "req-7", projectId: ctx.projectId, payload: {} };
    await run("begin_agent_request", identity);
    const applied = await run("apply_agent_patch", { ...identity, epoch: ctx.epoch, revision: ctx.revision,
      commands: [{ command: "set_track_volume", args: { trackId, db: -1 } }] });
    expect(data(applied).undoable).toBe(true);
    expect((await run("set_track_pan", { trackId, pan: 0.2 })).ok).toBe(true);
    const status = await run("get_agent_request", identity);
    expect(data(status).undoable).toBe(false);
    expect((await run("undo_agent_request", identity)).error).toMatch(/task_undo_not_owned/);
  });
});
