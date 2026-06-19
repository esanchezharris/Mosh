"""Pure, transport-agnostic relay room logic for 2-player Mosh multiplayer.

The relay's only job is to rendezvous two remote peers by a room code and forward
their messages (commits, locks, presence) reliably and in order. This module is
the *logic* — rooms, the 2-peer cap, a monotonic per-room sequence, a bounded ring
buffer, and `since`-N catch-up — with NO I/O. A thin websocket/HTTP wrapper drives
it. This mirrors the proven seq/ring/eventsSince pattern in
src/remote/RemoteCompanionServer.cpp (pushEvent + eventsSince, ring rolls at 256).
"""
from __future__ import annotations

from collections import deque

RING_CAPACITY = 256
MAX_PEERS = 2


class RoomError(Exception):
    pass


class RoomFull(RoomError):
    pass


class UnknownPeer(RoomError):
    pass


class Room:
    """One collaboration session. Holds <=2 peers, a monotonic seq, and a bounded
    ring of the most-recent frames for reconnect/late-join catch-up."""

    def __init__(self, code, capacity=MAX_PEERS, ring_capacity=RING_CAPACITY):
        self.code = code
        self.capacity = capacity
        self.ring_capacity = ring_capacity
        self._peers = {}                       # peer_id -> {"name", "color"}
        self._seq = 0                          # monotonic, per-room
        self._ring = deque(maxlen=ring_capacity)  # frames, oldest -> newest

    # ── membership ──────────────────────────────────────────────────────────
    def peer_count(self):
        return len(self._peers)

    def has_peer(self, peer_id):
        return peer_id in self._peers

    def peers(self):
        return {pid: dict(p) for pid, p in self._peers.items()}

    def join(self, peer_id, name="", color=""):
        # Re-join (reconnect) is idempotent: refresh the profile, keep the slot.
        if peer_id not in self._peers and len(self._peers) >= self.capacity:
            raise RoomFull(f"room {self.code} is full ({self.capacity})")
        self._peers[peer_id] = {"name": name, "color": color}
        return self._peers[peer_id]

    def leave(self, peer_id):
        self._peers.pop(peer_id, None)

    # ── frames / sequence / catch-up ────────────────────────────────────────
    def publish(self, sender_id, msg):
        if sender_id not in self._peers:
            raise UnknownPeer(f"{sender_id} is not a member of room {self.code}")
        self._seq += 1
        frame = {"seq": self._seq, "from": sender_id, "msg": msg}
        self._ring.append(frame)
        return frame

    def events_for(self, peer_id, since_seq):
        """Frames newer than `since_seq` that did NOT originate from `peer_id`
        (a peer never receives its own messages back — no echo)."""
        return [f for f in self._ring
                if f["seq"] > since_seq and f["from"] != peer_id]

    def latest_seq(self):
        return self._seq

    def oldest_seq(self):
        return self._ring[0]["seq"] if self._ring else 0

    def needs_resync(self, since_seq):
        """True when `since_seq` is older than the ring still holds, so the peer
        cannot be caught up incrementally and must re-bootstrap."""
        if not self._ring:
            return False
        return since_seq < self.oldest_seq() - 1


class RoomRegistry:
    """Maps room codes -> Room. One peer `create`s (and shares the code), the
    other `join`s."""

    def __init__(self):
        self._rooms = {}

    def create(self, code):
        if code in self._rooms:
            raise RoomError(f"room {code} already exists")
        room = Room(code)
        self._rooms[code] = room
        return room

    def get(self, code):
        return self._rooms.get(code)

    def join(self, code, peer_id, name="", color=""):
        room = self._rooms.get(code)
        if room is None:
            raise RoomError(f"no such room: {code}")
        room.join(peer_id, name=name, color=color)
        return room

    def drop(self, code):
        self._rooms.pop(code, None)

    def codes(self):
        return list(self._rooms.keys())
