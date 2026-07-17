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

  P4 self-heal (PR-1) — dev/test blob endpoints mirroring the cloud relay's
  contract (supabase/functions/relay/index.ts), so the stem round-trip is
  exercisable hermetically (no network) via the local relay:
  POST /mp/blob/head     {code, peerId, hash, ext} -> {exists}
  POST /mp/blob/put-url  {code, peerId, hash, ext} -> {url}   (PUT the bytes there)
  POST /mp/blob/get-url  {code, peerId, hash, ext} -> {url}   (404 if absent)
  PUT  /mp/blob/raw/<key>?tok=...                  -> {ok}    (raw octet-stream)
  GET  /mp/blob/raw/<key>?tok=...                  -> raw bytes (404 if absent)
  Storage is an in-memory, bounded (count + total bytes), content-addressed dict
  on the RelayState — a LOOPBACK DEV/TEST posture only: no persistence, no real
  signed-URL security (the `tok` query param is a per-mint random string for
  request-shape parity with the cloud's signed URL, not a security boundary).
  Never deploy this as a public relay; the cloud Edge Function is production.

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

# ── P4 self-heal (PR-1) blob-store limits (env-tunable). Audio stems are real
# files (not small control-plane JSON), so the per-blob cap is its OWN, much
# larger, ceiling than MAX_BODY_BYTES — comfortably above typical clip sizes but
# still bounded (a memory-exhaustion backstop for the in-memory dev store). The
# count/total-bytes caps bound the whole process's resident blob memory. ──
MAX_BLOB_BYTES = int(os.environ.get("MOSH_RELAY_MAX_BLOB", 256 * 1024 * 1024))
MAX_BLOB_COUNT = int(os.environ.get("MOSH_RELAY_MAX_BLOB_COUNT", 512))
MAX_BLOB_TOTAL_BYTES = int(os.environ.get("MOSH_RELAY_MAX_BLOB_TOTAL", 1024 * 1024 * 1024))


class BodyTooLarge(Exception):
    pass


class LengthRequired(Exception):
    """A request carried a chunked/streamed body with no Content-Length, so the
    body cap can't bound it — refuse it (411) rather than silently empty it."""
    pass


def _blob_key(hash_, ext):
    # Mirrors the cloud relay's keyFor (supabase/functions/relay/index.ts): a
    # content-addressed key, alnum-only extension, default "wav" like the cloud.
    ext = "".join(ch for ch in (ext or "wav") if ch.isalnum())
    return f"{hash_}.{ext}"


class BlobStore:
    """In-memory content-addressed stem store for the LOCAL dev/test relay only
    (mirrors the cloud `mp-stems` Supabase Storage bucket's contract: head / a
    put-url to PUT bytes to / a get-url to GET bytes from). Bounded by blob COUNT
    and TOTAL bytes (a crude memory backstop, not a per-room quota — content
    addressing means the same stem is stored once regardless of how many rooms
    reference it, same as the cloud bucket). NOT for production: no persistence
    across a restart, no real signed-URL cryptography — the per-mint `tok` is a
    random string for request-shape parity with the cloud's signed URL, checked
    only so a stray/forged raw request can't write or read (see check_token)."""

    def __init__(self, max_blob_bytes=None, max_count=None, max_total_bytes=None):
        self.max_blob_bytes = MAX_BLOB_BYTES if max_blob_bytes is None else max_blob_bytes
        self.max_count = MAX_BLOB_COUNT if max_count is None else max_count
        self.max_total_bytes = MAX_BLOB_TOTAL_BYTES if max_total_bytes is None else max_total_bytes
        self._blobs = {}     # key -> bytes
        self._tokens = {}    # key -> the most recently minted token for it
        self._lock = threading.Lock()

    def exists(self, key):
        with self._lock:
            return key in self._blobs

    def mint(self, key):
        tok = secrets.token_urlsafe(16)
        with self._lock:
            self._tokens[key] = tok
        return tok

    def check_token(self, key, tok):
        if not tok:
            return False
        with self._lock:
            return self._tokens.get(key) == tok

    def put(self, key, data):
        """Store `data` under `key`. Raises BodyTooLarge if it would breach any
        bound (per-blob size, blob count, or total resident bytes)."""
        if len(data) > self.max_blob_bytes:
            raise BodyTooLarge(f"blob too large ({len(data)} bytes, cap {self.max_blob_bytes})")
        with self._lock:
            if key not in self._blobs:
                if len(self._blobs) >= self.max_count:
                    raise BodyTooLarge(f"blob store full ({self.max_count} blobs)")
                total = sum(len(v) for v in self._blobs.values())
                if total + len(data) > self.max_total_bytes:
                    raise BodyTooLarge(f"blob store full ({self.max_total_bytes} bytes)")
            self._blobs[key] = data

    def get(self, key):
        with self._lock:
            return self._blobs.get(key)


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
        # P4 self-heal (PR-1): the blob store is process-global (content-addressed,
        # not per-room — mirrors the cloud's single `mp-stems` bucket), so it lives
        # alongside the room registry rather than inside any one Room.
        self.blobs = BlobStore()

    def is_member(self, code, peer_id):
        with self._lock:
            room = self._reg.get(code)
            return room is not None and room.has_peer(peer_id)

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
            # A chunked/streamed body carries no Content-Length, so MAX_BODY_BYTES
            # can't bound it (slow-POST / memory pressure) AND leaving it unread
            # desyncs the keep-alive stream. The relay's control plane only ever
            # sends small Content-Length JSON, so refuse a framed-without-length
            # body outright (411 + close).
            if self.headers.get("Transfer-Encoding"):
                raise LengthRequired("chunked/streamed bodies are not accepted")
            try:
                n = int(self.headers.get("Content-Length", 0) or 0)
            except ValueError:
                raise BodyTooLarge("invalid Content-Length")   # -> 413 + close, not a silent empty body
            if n < 0 or n > MAX_BODY_BYTES:
                raise BodyTooLarge(f"bad/oversize body length {n} (cap {MAX_BODY_BYTES})")
            if n == 0:
                return {}
            return json.loads(self.rfile.read(n).decode("utf-8") or "{}")

        def _raw_body(self, max_bytes):
            # Like _body() but returns raw bytes (a blob PUT), not JSON — same
            # chunked/oversize refusal posture, a separate (larger) cap.
            if self.headers.get("Transfer-Encoding"):
                raise LengthRequired("chunked/streamed bodies are not accepted")
            try:
                n = int(self.headers.get("Content-Length", 0) or 0)
            except ValueError:
                raise BodyTooLarge("invalid Content-Length")
            if n < 0 or n > max_bytes:
                raise BodyTooLarge(f"bad/oversize blob length {n} (cap {max_bytes})")
            if n == 0:
                return b""
            return self.rfile.read(n)

        def _send_raw(self, code, data):
            self.send_response(code)
            self.send_header("Content-Type", "application/octet-stream")
            self.send_header("Content-Length", str(len(data)))
            if self.close_connection:
                self.send_header("Connection", "close")
            self.end_headers()
            self.wfile.write(data)

        def _blob_delay(self):
            # PR-2 (async transfer) test hook: an env-tunable artificial delay on the
            # raw PUT/GET path so a "does the UI freeze during a slow stem transfer"
            # test can observe one in flight. 0 (default) = no delay.
            try:
                ms = float(os.environ.get("MOSH_RELAY_BLOB_DELAY_MS", 0) or 0)
            except ValueError:
                ms = 0
            if ms > 0:
                time.sleep(ms / 1000.0)

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
            if u.path.startswith("/mp/blob/raw/"):
                key = u.path[len("/mp/blob/raw/"):]
                q = parse_qs(u.query)
                tok = (q.get("tok") or [""])[0]
                if not state.blobs.check_token(key, tok):
                    return self._send(403, {"error": "bad_token"})
                self._blob_delay()
                data = state.blobs.get(key)
                if data is None:
                    return self._send(404, {"error": "not_found"})
                return self._send_raw(200, data)
            return self._send(404, {"error": "not found"})

        def do_PUT(self):
            if not self._rate_ok():
                return self._send(429, {"error": "rate_limited"})
            u = urlparse(self.path)
            if not u.path.startswith("/mp/blob/raw/"):
                return self._send(404, {"error": "not found"})
            key = u.path[len("/mp/blob/raw/"):]
            q = parse_qs(u.query)
            tok = (q.get("tok") or [""])[0]
            if not state.blobs.check_token(key, tok):
                # Drain a well-framed body before refusing so the connection can be
                # reused (mirrors the JSON body-cap path's own close-on-desync rule
                # only when the body ISN'T safely drainable — here it's still small
                # enough to read up to the blob cap before rejecting the token).
                try:
                    self._raw_body(state.blobs.max_blob_bytes)
                except (LengthRequired, BodyTooLarge):
                    self.close_connection = True
                return self._send(403, {"error": "bad_token"})
            try:
                data = self._raw_body(state.blobs.max_blob_bytes)
            except LengthRequired as e:
                self.close_connection = True
                return self._send(411, {"error": str(e)})
            except BodyTooLarge as e:
                self.close_connection = True
                return self._send(413, {"error": str(e)})
            self._blob_delay()
            try:
                state.blobs.put(key, data)
            except BodyTooLarge as e:
                return self._send(413, {"error": str(e)})
            return self._send(200, {"ok": True})

        def do_POST(self):
            if not self._rate_ok():
                return self._send(429, {"error": "rate_limited"})
            u = urlparse(self.path)
            try:
                b = self._body()
            except LengthRequired as e:
                # The streamed body is unbounded/unread — the framing is untrustworthy,
                # so close the connection rather than try to parse the next request on it.
                self.close_connection = True
                return self._send(411, {"error": str(e)})
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
                if u.path == "/mp/blob/head":
                    if not state.is_member(b.get("code", ""), b.get("peerId", "")):
                        return self._send(403, {"error": "not_a_member"})
                    key = _blob_key(b.get("hash", ""), b.get("ext", ""))
                    return self._send(200, {"exists": state.blobs.exists(key)})
                if u.path == "/mp/blob/put-url":
                    if not state.is_member(b.get("code", ""), b.get("peerId", "")):
                        return self._send(403, {"error": "not_a_member"})
                    key = _blob_key(b.get("hash", ""), b.get("ext", ""))
                    tok = state.blobs.mint(key)
                    url = f"http://127.0.0.1:{self.server.server_port}/mp/blob/raw/{key}?tok={tok}"
                    return self._send(200, {"url": url})
                if u.path == "/mp/blob/get-url":
                    if not state.is_member(b.get("code", ""), b.get("peerId", "")):
                        return self._send(403, {"error": "not_a_member"})
                    key = _blob_key(b.get("hash", ""), b.get("ext", ""))
                    if not state.blobs.exists(key):
                        return self._send(404, {"error": "not_found"})
                    tok = state.blobs.mint(key)
                    url = f"http://127.0.0.1:{self.server.server_port}/mp/blob/raw/{key}?tok={tok}"
                    return self._send(200, {"url": url})
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
