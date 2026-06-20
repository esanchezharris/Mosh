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
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse, parse_qs

from room import RoomRegistry, RoomError, RoomFull, UnknownPeer, StaleCommit

DEFAULT_PORT = 8771

# ── Abuse limits (env-tunable). The control plane carries only small JSON (audio
# bytes go out-of-band), so a few MB is a generous ceiling that still blocks a
# memory-exhaustion / slow-POST body. The rate limit is per remote IP over a
# fixed window; LOOPBACK IS EXEMPT (the self-host relay's own selftest hammers
# 127.0.0.1, and the limiter's job is to blunt remote abuse). 0 disables. ──
MAX_BODY_BYTES = int(os.environ.get("MOSH_RELAY_MAX_BODY", 8 * 1024 * 1024))
RATE_LIMIT = int(os.environ.get("MOSH_RELAY_RATE_LIMIT", 600))     # requests / window / IP
RATE_WINDOW_S = float(os.environ.get("MOSH_RELAY_RATE_WINDOW", 60))
SOCKET_TIMEOUT_S = float(os.environ.get("MOSH_RELAY_SOCKET_TIMEOUT", 30))  # slow-loris guard
_LOOPBACK = {"127.0.0.1", "::1", "::ffff:127.0.0.1"}


class BodyTooLarge(Exception):
    pass


class FixedWindowLimiter:
    """A tiny thread-safe per-key fixed-window rate limiter. `allow(key)` returns
    False once `limit` calls land within `window_s`; the window then resets. limit<=0
    disables it. Memory is bounded by pruning windows that have fully elapsed."""

    def __init__(self, limit, window_s, now_fn=None):
        self.limit = limit
        self.window = window_s
        self._now = now_fn if now_fn is not None else time.monotonic
        self._buckets = {}     # key -> [window_start, count]
        self._lock = threading.Lock()

    def allow(self, key):
        if self.limit <= 0:
            return True
        now = self._now()
        with self._lock:
            if len(self._buckets) > 4096:   # crude unbounded-growth backstop
                self._buckets = {k: w for k, w in self._buckets.items()
                                 if now - w[0] < self.window}
            w = self._buckets.get(key)
            if w is None or now - w[0] >= self.window:
                self._buckets[key] = [now, 1]
                return True
            if w[1] >= self.limit:
                return False
            w[1] += 1
            return True


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
            room.touch(peer_id)   # publishing is liveness — refresh this peer's lock leases
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
            room.touch(peer_id)    # polling is the peer's liveness heartbeat (keeps its locks)
            room.sweep_locks()     # lazy GC: reclaim any lapsed (crashed-owner) locks
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


def make_handler(state: RelayState, limiter: "FixedWindowLimiter | None" = None):
    limiter = limiter if limiter is not None else FixedWindowLimiter(RATE_LIMIT, RATE_WINDOW_S)

    class Handler(BaseHTTPRequestHandler):
        protocol_version = "HTTP/1.1"
        timeout = SOCKET_TIMEOUT_S   # drop a connection that dribbles bytes (slow-loris)

        def log_message(self, *args):
            pass  # quiet

        def _send(self, code, obj):
            body = json.dumps(obj).encode("utf-8")
            self.send_response(code)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            if self.close_connection:   # tell a keep-alive client in-band the socket ends (e.g. 413)
                self.send_header("Connection", "close")
            self.end_headers()
            self.wfile.write(body)

        def _client_ip(self):
            return self.client_address[0] if self.client_address else ""

        def _rate_ok(self):
            ip = self._client_ip()
            if ip in _LOOPBACK:          # self-host / selftest traffic is never throttled
                return True
            return limiter.allow(ip)

        def _body(self):
            try:
                n = int(self.headers.get("Content-Length", 0) or 0)
            except ValueError:
                raise BodyTooLarge("invalid Content-Length")   # -> 413 + close, not a silent empty body
            if n < 0 or n > MAX_BODY_BYTES:
                raise BodyTooLarge(f"bad/oversize body length {n} (cap {MAX_BODY_BYTES})")
            if n == 0:
                return {}
            return json.loads(self.rfile.read(n).decode("utf-8") or "{}")

        def do_GET(self):
            u = urlparse(self.path)
            # The /mp/events long-poll is the designed steady-state heartbeat (~4/s per
            # peer); throttling it would blank a legitimate session's presence. Only
            # rate-limit the burst-prone endpoints (create + the mutating POSTs).
            if u.path != "/mp/events" and not self._rate_ok():
                return self._send(429, {"error": "rate_limited"})
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
            if not self._rate_ok():
                return self._send(429, {"error": "rate_limited"})
            u = urlparse(self.path)
            try:
                b = self._body()
            except BodyTooLarge as e:
                # We deliberately did NOT drain the oversized body, so the keep-alive
                # stream is desynced — close the connection rather than mis-frame the
                # next request on it.
                self.close_connection = True
                return self._send(413, {"error": str(e)})
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


def make_server(port=0, state=None, limiter=None):
    """Build a ThreadingHTTPServer bound to `port` (0 = ephemeral, for tests).
    Returns (httpd, actual_port). `limiter` overrides the default per-IP rate limit."""
    state = state or RelayState()
    httpd = ThreadingHTTPServer(("127.0.0.1", port), make_handler(state, limiter))
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
