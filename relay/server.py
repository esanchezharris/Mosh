#!/usr/bin/env python3
"""Mosh multiplayer RELAY — the remote rendezvous + forwarding server.

The cloud-side hop that lets two NAT'd peers find each other by a room code and
exchange messages (commits, locks, presence). Control plane is HTTP/JSON with a
seq-numbered `since`-N poll — the same shape proven by the iPhone companion server
(src/remote/RemoteCompanionServer.cpp). Stdlib only (no websockets dependency):
each peer SHORT-polls GET /mp/events; the bounded ring + monotonic seq make the
poll idempotent and reconnect-safe. Audio bytes never transit the relay (P4 ships
them out-of-band via an object store keyed by content hash).

Endpoints:
  GET  /health                                  -> {ok, rooms}
  POST /mp/create {name?, color?, peerId}       -> {code, peerId}     (creator joins)
  POST /mp/join   {code, peerId, name?, color?} -> {ok, peers}
  POST /mp/publish{code, peerId, msg}           -> {seq}
  GET  /mp/events?code=&peerId=&since=N         -> {frames, latest, resync}
  POST /mp/leave  {code, peerId}                -> {ok}

Run:  python3 relay/server.py            # PORT env, default 8771
"""
from __future__ import annotations

import json
import os
import secrets
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse, parse_qs

from room import RoomRegistry, RoomError, RoomFull, UnknownPeer, StaleCommit

DEFAULT_PORT = 8771


def _new_code():
    # High-entropy bearer (the room code IS the access token for v0). Copy-paste
    # shareable, ~128 bits, URL-safe.
    return secrets.token_urlsafe(16)


class RelayState:
    """Thread-safe wrapper around the RoomRegistry (ThreadingHTTPServer serves
    each request on its own thread)."""

    def __init__(self):
        self._reg = RoomRegistry()
        self._lock = threading.Lock()

    def create(self, peer_id, name="", color=""):
        with self._lock:
            code = _new_code()
            room = self._reg.create(code)
            room.join(peer_id, name=name, color=color)
            return code

    def join(self, code, peer_id, name="", color=""):
        with self._lock:
            room = self._reg.join(code, peer_id, name=name, color=color)
            return room.peers()

    def publish(self, code, peer_id, msg):
        with self._lock:
            room = self._reg.get(code)
            if room is None:
                raise RoomError(f"no such room: {code}")
            # Epoch fencing: a track commit must come from the lock's current owner
            # carrying a non-stale epoch (a zombie holder whose lock was stolen is
            # rejected so it cannot clobber the new owner's track).
            if isinstance(msg, dict) and msg.get("type") == "commit":
                key = msg.get("logicalId")
                if key and not room.commit_allowed(peer_id, key, msg.get("epoch", 0)):
                    raise StaleCommit(f"commit for {key} fenced (stale epoch / not owner)")
            return room.publish(peer_id, msg)["seq"]

    def lock(self, code, peer_id, key, steal=False):
        with self._lock:
            room = self._reg.get(code)
            if room is None:
                raise RoomError(f"no such room: {code}")
            return room.try_lock(peer_id, key, steal=steal)

    def unlock(self, code, peer_id, key):
        with self._lock:
            room = self._reg.get(code)
            if room is None:
                raise RoomError(f"no such room: {code}")
            return room.release_lock(peer_id, key)

    def events(self, code, peer_id, since):
        with self._lock:
            room = self._reg.get(code)
            if room is None:
                raise RoomError(f"no such room: {code}")
            return {
                "frames": room.events_for(peer_id, since),
                "latest": room.latest_seq(),
                "resync": room.needs_resync(since),
                "locks": room.locks(),
                "peers": room.peers(),
            }

    def leave(self, code, peer_id):
        with self._lock:
            room = self._reg.get(code)
            if room is not None:
                room.leave(peer_id)
                if room.peer_count() == 0:
                    self._reg.drop(code)

    def room_count(self):
        with self._lock:
            return len(self._reg.codes())


def make_handler(state: RelayState):
    class Handler(BaseHTTPRequestHandler):
        protocol_version = "HTTP/1.1"

        def log_message(self, *args):
            pass  # quiet

        def _send(self, code, obj):
            body = json.dumps(obj).encode("utf-8")
            self.send_response(code)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def _body(self):
            n = int(self.headers.get("Content-Length", 0) or 0)
            if n <= 0:
                return {}
            return json.loads(self.rfile.read(n).decode("utf-8") or "{}")

        def do_GET(self):
            u = urlparse(self.path)
            if u.path == "/health":
                return self._send(200, {"ok": True, "rooms": state.room_count()})
            if u.path == "/mp/events":
                q = parse_qs(u.query)
                code = (q.get("code") or [""])[0]
                peer = (q.get("peerId") or [""])[0]
                since = int((q.get("since") or ["0"])[0])
                try:
                    return self._send(200, state.events(code, peer, since))
                except RoomError as e:
                    return self._send(404, {"error": str(e)})
            return self._send(404, {"error": "not found"})

        def do_POST(self):
            u = urlparse(self.path)
            try:
                b = self._body()
            except Exception as e:  # noqa: BLE001
                return self._send(400, {"error": f"bad json: {e}"})
            try:
                if u.path == "/mp/create":
                    code = state.create(b.get("peerId", ""), b.get("name", ""), b.get("color", ""))
                    return self._send(200, {"code": code, "peerId": b.get("peerId", "")})
                if u.path == "/mp/join":
                    peers = state.join(b["code"], b["peerId"], b.get("name", ""), b.get("color", ""))
                    return self._send(200, {"ok": True, "peers": peers})
                if u.path == "/mp/publish":
                    seq = state.publish(b["code"], b["peerId"], b.get("msg", {}))
                    return self._send(200, {"seq": seq})
                if u.path == "/mp/lock":
                    res = state.lock(b["code"], b["peerId"], b["key"], bool(b.get("steal", False)))
                    return self._send(200, res)
                if u.path == "/mp/unlock":
                    released = state.unlock(b["code"], b["peerId"], b["key"])
                    return self._send(200, {"released": released})
                if u.path == "/mp/leave":
                    state.leave(b["code"], b["peerId"])
                    return self._send(200, {"ok": True})
            except StaleCommit as e:
                return self._send(409, {"error": str(e), "stale": True})
            except RoomFull as e:
                return self._send(409, {"error": str(e)})
            except (UnknownPeer, RoomError) as e:
                return self._send(404, {"error": str(e)})
            except KeyError as e:
                return self._send(400, {"error": f"missing field: {e}"})
            return self._send(404, {"error": "not found"})

    return Handler


def make_server(port=0, state=None):
    """Build a ThreadingHTTPServer bound to `port` (0 = ephemeral, for tests).
    Returns (httpd, actual_port)."""
    state = state or RelayState()
    httpd = ThreadingHTTPServer(("127.0.0.1", port), make_handler(state))
    return httpd, httpd.server_address[1]


def main():
    port = int(os.environ.get("PORT", DEFAULT_PORT))
    httpd, port = make_server(port)
    print(f"mosh relay listening on http://127.0.0.1:{port}", flush=True)
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
