// MP-003 — mpIdleCheckpointTick (ui/src/store/mp.ts). Closes the gap the prior
// playtest-readiness audit found (docs/2026-07-17-mp-playtest-readiness-audit.md
// §3 #1): the 90s lock lease (supabase/migrations/0001_mp_relay.sql) never
// renewed while a peer stayed parked on one track, and the "idle checkpoint"
// docs/MULTIPLAYER.md and this file's own former comments claimed did not exist
// anywhere in the codebase. This is a headless (no native binary) unit test of
// the fix, because a native --selftest/--run-script harness can never exercise
// it — the whole mechanism lives in the TS store, ticked off the mp_state event,
// same class of gap as "--selftest cannot see the reactive lane".
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useStore } from "../store";
import { __resetMockForTests, __emitMockEvent } from "../bridge.mock";
import { MP_IDLE_CHECKPOINT_MS } from "./mp";

describe("mpIdleCheckpointTick (MP-003)", () => {
  beforeEach(() => {
    __resetMockForTests();
    useStore.getState().init();
  });

  it("is a no-op with no active session", async () => {
    const exec = vi.spyOn(useStore.getState(), "exec");
    await useStore.getState().mpIdleCheckpointTick();
    expect(exec).not.toHaveBeenCalled();
  });

  it("is a no-op with an active session but no active track", async () => {
    await useStore.getState().mpCreateSession("Me", "#3aa0ff");
    expect(useStore.getState().mp.active).toBe(true);
    const exec = vi.spyOn(useStore.getState(), "exec");
    await useStore.getState().mpIdleCheckpointTick();
    expect(exec).not.toHaveBeenCalled();
  });

  it("is a no-op before MP_IDLE_CHECKPOINT_MS has elapsed since the last claim", async () => {
    await useStore.getState().mpCreateSession("Me", "#3aa0ff");
    const trackId = useStore.getState().snapshot!.tracks[0].id;
    useStore.setState({ activeTrackId: trackId, activeTrackClaimedAtMs: Date.now() });
    const exec = vi.spyOn(useStore.getState(), "exec");
    await useStore.getState().mpIdleCheckpointTick();
    expect(exec).not.toHaveBeenCalled();
  });

  it("re-commits then re-claims the active track once the interval has elapsed", async () => {
    await useStore.getState().mpCreateSession("Me", "#3aa0ff");
    const trackId = useStore.getState().snapshot!.tracks[0].id;
    // Simulate having claimed this track just over MP_IDLE_CHECKPOINT_MS ago —
    // the real scenario is a producer parked on one track without switching.
    useStore.setState({
      activeTrackId: trackId,
      activeTrackClaimedAtMs: Date.now() - MP_IDLE_CHECKPOINT_MS - 1,
    });
    const exec = vi.spyOn(useStore.getState(), "exec");
    await useStore.getState().mpIdleCheckpointTick();

    expect(exec).toHaveBeenCalledWith("mp_commit_track", { trackId });
    expect(exec).toHaveBeenCalledWith("mp_claim_track", { trackId });
    // Commit must be ordered before the re-claim (the native lock is released by
    // the commit, then re-acquired) — the whole point is minting a fresh epoch.
    const commitCallIndex = exec.mock.calls.findIndex((c) => c[0] === "mp_commit_track");
    const claimCallIndex = exec.mock.calls.findIndex((c) => c[0] === "mp_claim_track");
    expect(commitCallIndex).toBeGreaterThanOrEqual(0);
    expect(claimCallIndex).toBeGreaterThan(commitCallIndex);

    // The clock resets so a burst of ticks right after doesn't re-fire immediately.
    const afterTick = useStore.getState().activeTrackClaimedAtMs;
    expect(afterTick).not.toBeNull();
    expect(Date.now() - afterTick!).toBeLessThan(MP_IDLE_CHECKPOINT_MS);
  });

  it("does not fire twice back-to-back for the same overdue track", async () => {
    await useStore.getState().mpCreateSession("Me", "#3aa0ff");
    const trackId = useStore.getState().snapshot!.tracks[0].id;
    useStore.setState({
      activeTrackId: trackId,
      activeTrackClaimedAtMs: Date.now() - MP_IDLE_CHECKPOINT_MS - 1,
    });
    const exec = vi.spyOn(useStore.getState(), "exec");
    await useStore.getState().mpIdleCheckpointTick();
    const callsAfterFirst = exec.mock.calls.length;
    await useStore.getState().mpIdleCheckpointTick();
    expect(exec.mock.calls.length).toBe(callsAfterFirst);
  });

  it("is ticked automatically off the mp_state event while a session is active", async () => {
    await useStore.getState().mpCreateSession("Me", "#3aa0ff");
    const trackId = useStore.getState().snapshot!.tracks[0].id;
    useStore.setState({
      activeTrackId: trackId,
      activeTrackClaimedAtMs: Date.now() - MP_IDLE_CHECKPOINT_MS - 1,
    });
    const exec = vi.spyOn(useStore.getState(), "exec");
    // The native poll loop emits mp_state ~4/s while a session is active; this is
    // one such tick landing through the real store.ts dispatcher (store/events.ts's
    // onMpState), not a direct mpIdleCheckpointTick() call.
    __emitMockEvent("mp_state", { active: true, roomCode: "MOCK-ROOM-abcdef0123456789", selfPeer: "me", peers: {}, locks: {} });
    // mpIdleCheckpointTick's own exec calls are fired-and-forgotten (void) from
    // onMpState, so let the microtask queue drain before asserting.
    await Promise.resolve();
    await Promise.resolve();
    expect(exec).toHaveBeenCalledWith("mp_commit_track", { trackId });
  });

  it("does not re-claim if a real track switch raced ahead while the checkpoint commit was in flight", async () => {
    await useStore.getState().mpCreateSession("Me", "#3aa0ff");
    const [t0, t1] = useStore.getState().snapshot!.tracks;
    useStore.setState({
      activeTrackId: t0.id,
      activeTrackClaimedAtMs: Date.now() - MP_IDLE_CHECKPOINT_MS - 1,
    });
    const realExec = useStore.getState().exec;
    const exec = vi.spyOn(useStore.getState(), "exec").mockImplementation((command, args) => {
      // While the checkpoint's mp_commit_track await is in flight, simulate a
      // genuine track switch landing first (a different code path racing in).
      if (command === "mp_commit_track") useStore.setState({ activeTrackId: t1.id });
      return realExec(command, args as never);
    });
    await useStore.getState().mpIdleCheckpointTick();
    // t0 was committed (the checkpoint that was already due), but NOT re-claimed —
    // syncActiveTrack, not the checkpoint, owns claiming the NEW active track.
    expect(exec).toHaveBeenCalledWith("mp_commit_track", { trackId: t0.id });
    expect(exec).not.toHaveBeenCalledWith("mp_claim_track", { trackId: t0.id });
  });
});
