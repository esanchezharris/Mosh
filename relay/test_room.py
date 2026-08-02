"""TDD suite for the pure relay room logic (relay/room.py)."""
import os
import sys

sys.path.insert(0, os.path.dirname(__file__))

import pytest  # noqa: E402
from room import Room, RoomRegistry, RoomFull, UnknownPeer  # noqa: E402


# ── Room membership / 2-peer cap ────────────────────────────────────────────

def test_join_tracks_peers():
    r = Room("ABCD")
    assert r.peer_count() == 0
    r.join("a", name="Ada", color="#f00")
    assert r.peer_count() == 1
    assert r.has_peer("a")
    assert r.peers()["a"]["name"] == "Ada"
    r.join("b", name="Bo")
    assert r.peer_count() == 2


def test_third_peer_is_rejected():
    r = Room("ABCD")
    r.join("a")
    r.join("b")
    with pytest.raises(RoomFull):
        r.join("c")


def test_rejoin_is_idempotent_and_updates_profile():
    r = Room("ABCD")
    r.join("a", name="Ada")
    r.join("a", name="Ada2")  # reconnect, same peer id
    assert r.peer_count() == 1
    assert r.peers()["a"]["name"] == "Ada2"


def test_leave_removes_peer_and_frees_a_slot():
    r = Room("ABCD")
    r.join("a")
    r.join("b")
    r.leave("a")
    assert r.peer_count() == 1
    assert not r.has_peer("a")
    r.join("c")  # slot freed
    assert r.peer_count() == 2


def _clocked_membership_room(start=1000.0, peer_lease=90):
    clk = [start]
    r = Room("ABCD", now_fn=lambda: clk[0], peer_lease_s=peer_lease)
    r.join("a", name="Ada")
    r.join("b", name="Bo")
    return r, clk


def test_silent_peer_expires_and_releases_its_locks():
    r, clk = _clocked_membership_room()
    r.try_lock("b", "track-b")
    clk[0] += 60
    r.touch("a")                                  # host stays active
    clk[0] += 31                                  # guest is now beyond 90s

    assert r.sweep_peers() == 1
    assert set(r.peers()) == {"a"}
    assert "track-b" not in r.locks()


def test_join_sweeps_a_stale_peer_before_enforcing_capacity():
    r, clk = _clocked_membership_room(peer_lease=10)
    clk[0] += 6
    r.touch("a")                                  # only b will expire
    clk[0] += 5

    r.join("c", name="Cy")                       # stale b no longer owns a slot
    assert set(r.peers()) == {"a", "c"}


def test_rejoin_within_lease_refreshes_profile_and_deadline():
    r, clk = _clocked_membership_room(peer_lease=10)
    clk[0] += 9
    r.touch("a")
    r.join("b", name="Bo back")                  # reconnect within grace
    clk[0] += 9

    assert r.sweep_peers() == 0
    assert r.peers()["b"]["name"] == "Bo back"


def test_expired_peer_cannot_resume_without_rejoining():
    r, clk = _clocked_membership_room(peer_lease=10)
    clk[0] += 6
    r.touch("a")
    clk[0] += 5

    with pytest.raises(UnknownPeer):
        r.publish("b", {"type": "presence"})
    with pytest.raises(UnknownPeer):
        r.try_lock("b", "track-b")

    r.join("b", name="Bo rejoined")
    assert r.publish("b", {"type": "presence"})["from"] == "b"


# ── Sequence + ring + catch-up ──────────────────────────────────────────────

def test_publish_assigns_monotonic_seq_and_frames():
    r = Room("ABCD")
    r.join("a")
    f1 = r.publish("a", {"type": "commit", "x": 1})
    f2 = r.publish("a", {"type": "commit", "x": 2})
    assert f1["seq"] == 1 and f2["seq"] == 2
    assert f1["from"] == "a"
    assert f1["msg"]["x"] == 1
    assert r.latest_seq() == 2


def test_publish_by_non_member_is_rejected():
    r = Room("ABCD")
    with pytest.raises(UnknownPeer):
        r.publish("ghost", {"type": "commit"})


def test_events_for_excludes_own_frames_and_honors_since():
    r = Room("ABCD")
    r.join("a")
    r.join("b")
    r.publish("a", {"n": 1})            # seq 1, from a
    r.publish("b", {"n": 2})            # seq 2, from b
    r.publish("a", {"n": 3})            # seq 3, from a

    # b polls from 0: sees a's frames (1 and 3), NOT its own (2) -> no echo.
    bs = r.events_for("b", 0)
    assert [f["seq"] for f in bs] == [1, 3]

    # b has now seen up to seq 3; polling again returns nothing new.
    assert r.events_for("b", 3) == []

    # a polls from 0: sees only b's frame (2).
    a_seqs = [f["seq"] for f in r.events_for("a", 0)]
    assert a_seqs == [2]


def test_ring_bounds_and_resync_detection():
    r = Room("ABCD", ring_capacity=4)
    r.join("a")
    r.join("b")
    for i in range(6):                  # 6 frames into a 4-slot ring
        r.publish("a", {"n": i})
    assert r.latest_seq() == 6
    assert r.oldest_seq() == 3          # seqs 1,2 rolled off; 3..6 remain

    # A peer that only has up to seq 1 cannot be caught up from the ring -> resync.
    assert r.needs_resync(1) is True
    # A peer current within the ring window does not need a resync.
    assert r.needs_resync(4) is False

    # events_for never returns rolled-off frames.
    assert [f["seq"] for f in r.events_for("b", 0)] == [3, 4, 5, 6]


# ── Registry: create / join by code ─────────────────────────────────────────

def test_registry_create_then_join():
    reg = RoomRegistry()
    room = reg.create("WXYZ")
    assert room.code == "WXYZ"
    assert "WXYZ" in reg.codes()

    same = reg.join("WXYZ", "a", name="Ada")
    assert same is room
    assert room.has_peer("a")


def test_registry_create_duplicate_is_rejected():
    reg = RoomRegistry()
    reg.create("WXYZ")
    with pytest.raises(Exception):
        reg.create("WXYZ")


def test_registry_join_unknown_code_is_rejected():
    reg = RoomRegistry()
    with pytest.raises(Exception):
        reg.join("NOPE", "a")


def test_registry_drop_removes_room():
    reg = RoomRegistry()
    reg.create("WXYZ")
    reg.drop("WXYZ")
    assert "WXYZ" not in reg.codes()
    assert reg.get("WXYZ") is None


# ── Lock table (the relay is the sole arbiter) ──────────────────────────────

def _two_peer_room():
    r = Room("ABCD")
    r.join("a")
    r.join("b")
    return r


def test_lock_free_key_is_granted_with_epoch():
    r = _two_peer_room()
    res = r.try_lock("a", "track-1")
    assert res["granted"] is True
    assert res["owner"] == "a"
    assert res["epoch"] >= 1
    assert r.locks()["track-1"]["owner"] == "a"


def test_lock_contended_key_is_denied_with_current_owner():
    r = _two_peer_room()
    r.try_lock("a", "track-1")
    res = r.try_lock("b", "track-1")
    assert res["granted"] is False
    assert res["owner"] == "a"  # loser is told who holds it


def test_relock_by_same_owner_is_idempotent():
    r = _two_peer_room()
    first = r.try_lock("a", "track-1")
    again = r.try_lock("a", "track-1")
    assert again["granted"] is True
    assert again["epoch"] == first["epoch"]  # no churn for the same holder


def test_steal_bumps_epoch_and_transfers_ownership():
    r = _two_peer_room()
    held = r.try_lock("a", "track-1")
    stolen = r.try_lock("b", "track-1", steal=True)
    assert stolen["granted"] is True
    assert stolen["owner"] == "b"
    assert stolen["epoch"] > held["epoch"]


def test_release_by_owner_frees_only_for_owner():
    r = _two_peer_room()
    r.try_lock("a", "track-1")
    assert r.release_lock("b", "track-1") is False  # non-owner cannot release
    assert "track-1" in r.locks()
    assert r.release_lock("a", "track-1") is True
    assert "track-1" not in r.locks()


def test_leave_auto_releases_a_peers_locks():
    r = _two_peer_room()
    r.try_lock("a", "track-1")
    r.try_lock("a", "track-2")
    r.try_lock("b", "track-3")
    r.leave("a")
    assert set(r.locks().keys()) == {"track-3"}  # a's locks gone, b's kept


def test_lock_by_non_member_is_rejected():
    r = _two_peer_room()
    with pytest.raises(UnknownPeer):
        r.try_lock("ghost", "track-1")


def test_commit_epoch_fencing():
    r = _two_peer_room()
    held = r.try_lock("a", "track-1")
    # The holder with a current epoch may commit.
    assert r.commit_allowed("a", "track-1", held["epoch"]) is True
    # b steals -> a is now a zombie holder whose in-flight commit is fenced out.
    stolen = r.try_lock("b", "track-1", steal=True)
    assert r.commit_allowed("a", "track-1", held["epoch"]) is False   # stale epoch
    assert r.commit_allowed("b", "track-1", stolen["epoch"]) is True
    # A non-member / non-owner cannot commit a locked key.
    assert r.commit_allowed("a", "track-1", stolen["epoch"]) is False  # wrong owner
    # An unlocked key (e.g. uncontended structural op) is allowed.
    assert r.commit_allowed("a", "free-key", 0) is True


# ── Lock lease / expiry / GC (a crashed peer must not deadlock a track) ──────

def _clocked_room(start=1000.0, lease=90):
    clk = [start]
    # These cases isolate lock expiry; keep membership live much longer so a
    # lock-only test does not accidentally exercise the separate peer lease.
    r = Room("ABCD", now_fn=lambda: clk[0], lock_lease_s=lease,
             peer_lease_s=lease * 10)
    r.join("a")
    r.join("b")
    return r, clk


def test_lock_lapses_after_lease_and_key_becomes_free():
    r, clk = _clocked_room()
    held = r.try_lock("a", "t1")
    assert r.locks()["t1"]["owner"] == "a"
    clk[0] += 91                                   # lease (90s) lapsed
    assert "t1" not in r.locks()                   # not presented to clients
    assert r.commit_allowed("a", "t1", held["epoch"]) is True   # lapsed == unlocked
    # b takes it WITHOUT stealing — a lapsed lock is just free.
    res = r.try_lock("b", "t1")
    assert res["granted"] is True and res["owner"] == "b"
    assert "stolen" not in res


def test_active_owner_keeps_lease_via_touch():
    r, clk = _clocked_room()
    r.try_lock("a", "t1")
    for _ in range(10):                            # 300s of activity, refreshed each poll
        clk[0] += 30
        r.touch("a")
    assert r.locks()["t1"]["owner"] == "a"         # still held


def test_silent_owner_loses_lock_despite_other_peer_touch():
    r, clk = _clocked_room()
    r.try_lock("a", "t1")
    for _ in range(10):
        clk[0] += 30
        r.touch("b")                               # only b is active; a is silent
    assert "t1" not in r.locks()                   # a's lease lapsed -> freed


def test_reclaim_by_same_owner_renews_lease_and_keeps_epoch():
    r, clk = _clocked_room()
    e1 = r.try_lock("a", "t1")["epoch"]
    clk[0] += 80
    e2 = r.try_lock("a", "t1")["epoch"]            # re-claim renews
    assert e2 == e1
    clk[0] += 80                                   # 160s total, but renewed at 80s
    assert "t1" in r.locks()                       # still live


def test_sweep_locks_reclaims_expired_memory():
    r, clk = _clocked_room()
    r.try_lock("a", "t1")
    r.try_lock("a", "t2")
    clk[0] += 91
    assert r.sweep_locks() == 2
    assert r.locks() == {}


def test_touch_does_not_revive_a_lapsed_lock():
    # A reconnecting peer resuming its poll must NOT resurrect a lock the relay
    # already advertised as free — touch is a keep-alive, not a reviver.
    r, clk = _clocked_room()
    r.try_lock("a", "t1")
    clk[0] += 91                                   # a's lease lapsed -> t1 is free
    assert "t1" not in r.locks()
    assert r.commit_allowed("b", "t1", 0) is True
    r.touch("a")                                   # a polls again
    assert "t1" not in r.locks()                   # still free (not revived)
    assert r.commit_allowed("b", "t1", 0) is True  # b is NOT fenced out
    assert r.try_lock("b", "t1")["granted"] is True  # b can still take it
