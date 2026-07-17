import { describe, it, expect, beforeEach } from "vitest";
import { useStore } from "../store";
import { __resetMockForTests, __emitMockEvent } from "../bridge.mock";
import { isTrackLockedByOther } from "./sync";

// Drives the real store through the mock peer harness: a multiplayer session with
// a peer "Bo" holding the 2nd track. Verifies the mp_state / peer_selection
// reducers and the session actions end to end.

describe("multiplayer presence (store + mock peer)", () => {
  beforeEach(() => {
    __resetMockForTests();
    useStore.setState({
      mp: { active: false, roomCode: null, selfPeer: null, connected: false },
      peers: {}, peerSelection: {}, peerPresence: {}, locksByLogicalId: {}, activeTrackId: null,
      pendingCommits: {}, failedCommits: {},
    });
    useStore.getState().init();
  });

  it("mp_create_session populates session, roster and the lock table", async () => {
    await useStore.getState().mpCreateSession("Ada", "#3aa0ff");
    const s = useStore.getState();
    expect(s.mp.active).toBe(true);
    expect(s.mp.selfPeer).toBe("me");
    expect(s.mp.roomCode).toBeTruthy();
    expect(Object.keys(s.peers).sort()).toEqual(["bo", "me"]);
    expect(s.peers.bo.name).toBe("Bo");
    expect(Object.values(s.locksByLogicalId)).toContain("bo");
    expect(s.peerSelection.bo).toBeTruthy();
    expect(s.peerSelection.bo.trackId).toBeTruthy();
    expect(s.peerPresence.bo).toBeTruthy();
    expect(s.peerPresence.bo.position).toBe(5.25);
    expect(s.peerPresence.bo.playing).toBe(true);
  });

  it("a peer-held track reads as locked-by-other (but not our own / free tracks)", async () => {
    await useStore.getState().mpCreateSession();
    const s = useStore.getState();
    const [lid, owner] = Object.entries(s.locksByLogicalId)[0];
    expect(owner).toBe("bo");
    expect(isTrackLockedByOther({ logicalId: lid }, s.locksByLogicalId, s.mp.selfPeer)).toBe(true);
    expect(isTrackLockedByOther({ logicalId: "free-lid" }, s.locksByLogicalId, s.mp.selfPeer)).toBe(false);
  });

  it("mpLeaveSession clears all presence (back to single-player)", async () => {
    await useStore.getState().mpCreateSession();
    await useStore.getState().mpLeaveSession();
    const s = useStore.getState();
    expect(s.mp.active).toBe(false);
    expect(Object.keys(s.peers)).toHaveLength(0);
    expect(Object.keys(s.locksByLogicalId)).toHaveLength(0);
    expect(Object.keys(s.peerPresence)).toHaveLength(0);
    expect(s.activeTrackId).toBeNull();
  });

  // Regression: rapid selection changes used to fire syncActiveTrack concurrently,
  // letting a commit race ahead of (or behind) its own claim. The runs are now
  // serialized — each run's commit/claim/broadcast must be contiguous.
  it("serializes overlapping syncActiveTrack runs (no interleaved relay calls)", async () => {
    await useStore.getState().syncActiveTrack();   // settle the module sync chain (mp inactive => no-op)

    const calls: string[] = [];
    const resolvers: Array<() => void> = [];
    const execMock = (cmd: string, args?: Record<string, unknown>) => {
      calls.push(`${cmd}:${String(args?.trackId)}`);
      return new Promise((res) => resolvers.push(() => res({ ok: true })));
    };
    useStore.setState({
      mp: { active: true, roomCode: "R", selfPeer: "me", connected: true },
      selection: new Set<string>(),
      selectedTrackId: "T1",
      activeTrackId: "T1",
      snapshot: null,
      exec: execMock as never,
    });

    // run1 (T1 -> T2): starts and parks on its first exec (commit T1).
    useStore.setState({ selectedTrackId: "T2" });
    const p1 = useStore.getState().syncActiveTrack();
    await Promise.resolve();
    await Promise.resolve();

    // run2 (T2 -> T3) is queued behind run1; it must NOT have started yet.
    useStore.setState({ selectedTrackId: "T3" });
    const p2 = useStore.getState().syncActiveTrack();
    await Promise.resolve();
    expect(calls).toEqual(["mp_commit_track:T1"]);

    // Drain parked execs, flushing a microtask each tick so the chain advances
    // (don't stop on a transient empty moment during the run1 -> run2 hand-off).
    for (let i = 0; i < 60; i++) {
      if (resolvers.length) resolvers.shift()!();
      await Promise.resolve();
    }
    await Promise.all([p1, p2]);

    expect(calls).toEqual([
      "mp_commit_track:T1",
      "mp_claim_track:T2",
      "mp_broadcast_selection:T2",
      "mp_commit_track:T2",
      "mp_claim_track:T3",
      "mp_broadcast_selection:T3",
    ]);
  });

  // A bridge-level exec rejection on the LAST run must not surface as an unhandled
  // rejection (callers `void` the promise), and the chain must still self-heal.
  it("a rejecting exec self-heals the sync chain without an unhandled rejection", async () => {
    await useStore.getState().syncActiveTrack();   // settle the module chain

    const unhandled: string[] = [];
    const onUnhandled = (e: unknown) => unhandled.push(String((e as Error)?.message ?? e));
    process.on("unhandledRejection", onUnhandled);
    try {
      let n = 0;
      const execMock = () => {
        n += 1;
        return n === 1 ? Promise.reject(new Error("bridge down")) : Promise.resolve({ ok: true });
      };
      useStore.setState({
        mp: { active: true, roomCode: "R", selfPeer: "me", connected: true },
        selection: new Set<string>(), selectedTrackId: "T2", activeTrackId: "T1",
        snapshot: null, exec: execMock as never,
      });

      // run1's first exec (commit T1) rejects; caller discards the promise (prod pattern).
      void useStore.getState().syncActiveTrack();
      await new Promise((r) => setTimeout(r, 0));

      // Self-heal: a subsequent run still fires despite the prior rejection.
      useStore.setState({ selectedTrackId: "T3", activeTrackId: "T2" });
      await useStore.getState().syncActiveTrack();
      expect(n).toBeGreaterThan(1);

      await new Promise((r) => setTimeout(r, 0));
      expect(unhandled.some((m) => m.includes("bridge down"))).toBe(false);
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
  });
});

// PR-2 adversarial-review BLOCKER: mp_commit_done previously had NO frontend
// consumer at all -- store.ts's event dispatch chain had no branch for it and no
// default, so a failed stem upload (commit-on-move, PR-2's async transfer) was
// silently dropped. A track could sit sourceMissing for the peer forever with
// nothing telling the producer anything had gone wrong. These tests drive the
// reducer directly via __emitMockEvent (the mock backend has no realistic way to
// fail an upload itself -- there is no upload to fail in the dev mock).
describe("mp_commit_done (PR-2 adversarial-review BLOCKER)", () => {
  beforeEach(() => {
    __resetMockForTests();
    useStore.setState({
      mp: { active: true, roomCode: "R", selfPeer: "me", connected: true },
      pendingCommits: {}, failedCommits: {}, lastError: null,
    });
    useStore.getState().init();   // subscribe the mosh_event listener __emitMockEvent drives
  });

  it("ok:false surfaces visibly: failedCommits + lastError, and clears pendingCommits", () => {
    useStore.setState({ pendingCommits: { "lid-1": true } });
    __emitMockEvent("mp_commit_done", { logicalId: "lid-1", ok: false, error: "relay rejected the upload" });

    const s = useStore.getState();
    expect(s.pendingCommits["lid-1"]).toBeUndefined();
    expect(s.failedCommits["lid-1"]).toBe("relay rejected the upload");
    expect(s.lastError).toBe("relay rejected the upload");
  });

  it("ok:false with no error string still surfaces a non-empty message (never a silent drop)", () => {
    __emitMockEvent("mp_commit_done", { logicalId: "lid-2", ok: false });
    const s = useStore.getState();
    expect(s.failedCommits["lid-2"]).toBeTruthy();
    expect(s.lastError).toBeTruthy();
  });

  it("ok:true clears both pendingCommits and any stale failedCommits entry", () => {
    useStore.setState({
      pendingCommits: { "lid-3": true },
      failedCommits: { "lid-3": "a previous failure" },
    });
    __emitMockEvent("mp_commit_done", { logicalId: "lid-3", ok: true });

    const s = useStore.getState();
    expect(s.pendingCommits["lid-3"]).toBeUndefined();
    expect(s.failedCommits["lid-3"]).toBeUndefined();
  });

  it("an event with no logicalId is a harmless no-op (doesn't throw, doesn't touch state)", () => {
    useStore.setState({ pendingCommits: { keep: true } });
    expect(() => __emitMockEvent("mp_commit_done", { ok: false })).not.toThrow();
    expect(useStore.getState().pendingCommits).toEqual({ keep: true });
  });

  it("retryFailedCommit re-fires mp_commit_track for the resolved trackId and marks it pending", async () => {
    const calls: Array<{ command: string; args?: Record<string, unknown> }> = [];
    useStore.setState({
      failedCommits: { "lid-4": "upload failed" },
      snapshot: { tracks: [{ id: "T9", logicalId: "lid-4", name: "Drums" }] } as never,
      exec: (async (command: string, args?: Record<string, unknown>) => {
        calls.push({ command, args });
        return { ok: true, command };
      }) as never,
    });

    await useStore.getState().retryFailedCommit("lid-4");

    expect(calls).toEqual([{ command: "mp_commit_track", args: { trackId: "T9" } }]);
    expect(useStore.getState().pendingCommits["lid-4"]).toBe(true);
  });

  it("retryFailedCommit on a logicalId with no matching track just drops the stale entry", async () => {
    useStore.setState({
      failedCommits: { "gone-lid": "upload failed" },
      snapshot: { tracks: [] } as never,
    });
    await useStore.getState().retryFailedCommit("gone-lid");
    expect(useStore.getState().failedCommits["gone-lid"]).toBeUndefined();
  });
});
