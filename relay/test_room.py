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
