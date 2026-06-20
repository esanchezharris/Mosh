import { describe, it, expect, beforeEach } from "vitest";
import { useStore } from "../store";
import { __resetMockForTests } from "../bridge.mock";
import { isTrackLockedByOther } from "./sync";

// Drives the real store through the mock peer harness: a multiplayer session with
// a peer "Bo" holding the 2nd track. Verifies the mp_state / peer_selection
// reducers and the session actions end to end.

describe("multiplayer presence (store + mock peer)", () => {
  beforeEach(() => {
    __resetMockForTests();
    useStore.setState({
      mp: { active: false, roomCode: null, selfPeer: null, connected: false },
      peers: {}, peerSelection: {}, locksByLogicalId: {}, activeTrackId: null,
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
    expect(s.activeTrackId).toBeNull();
  });
});
