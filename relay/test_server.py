"""Integration tests for the relay HTTP server (relay/server.py): real HTTP
round-trips between two simulated peers against an ephemeral-port instance."""
import json
import os
import sys
import threading
import time
import urllib.error
import urllib.request

sys.path.insert(0, os.path.dirname(__file__))

import pytest  # noqa: E402
from server import make_server, FixedWindowLimiter  # noqa: E402


@pytest.fixture()
def relay():
    httpd, port = make_server(0)
    t = threading.Thread(target=httpd.serve_forever, daemon=True)
    t.start()
    base = f"http://127.0.0.1:{port}"
    yield base
    httpd.shutdown()
    httpd.server_close()


def _post(base, path, body):
    req = urllib.request.Request(
        base + path, data=json.dumps(body).encode(), method="POST",
        headers={"Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=5) as r:
            return r.status, json.loads(r.read())
    except urllib.error.HTTPError as e:
        return e.code, json.loads(e.read())


def _get(base, path):
    with urllib.request.urlopen(base + path, timeout=5) as r:
        return r.status, json.loads(r.read())


def test_health(relay):
    status, body = _get(relay, "/health")
    assert status == 200
    assert body["ok"] is True
    assert body["rooms"] == 0


def test_create_join_publish_route(relay):
    # Peer A creates a room and gets a high-entropy code.
    status, body = _post(relay, "/mp/create", {"peerId": "a", "name": "Ada"})
    assert status == 200
    code = body["code"]
    assert len(code) >= 16

    # Peer B joins; sees both peers.
    status, body = _post(relay, "/mp/join", {"code": code, "peerId": "b", "name": "Bo"})
    assert status == 200
    assert set(body["peers"].keys()) == {"a", "b"}

    # A publishes a commit; B receives it; A does NOT get its own back.
    status, body = _post(relay, "/mp/publish", {"code": code, "peerId": "a",
                                                "msg": {"type": "commit", "n": 1}})
    assert status == 200 and body["seq"] == 1

    status, body = _get(relay, f"/mp/events?code={code}&peerId=b&since=0")
    assert status == 200
    assert [f["seq"] for f in body["frames"]] == [1]
    assert body["frames"][0]["from"] == "a"
    assert body["frames"][0]["msg"]["n"] == 1
    assert body["latest"] == 1
    assert body["resync"] is False

    # A polling its own frame back: empty (no echo).
    status, body = _get(relay, f"/mp/events?code={code}&peerId=a&since=0")
    assert body["frames"] == []


def test_full_room_rejected(relay):
    _, b = _post(relay, "/mp/create", {"peerId": "a"})
    code = b["code"]
    _post(relay, "/mp/join", {"code": code, "peerId": "b"})
    status, body = _post(relay, "/mp/join", {"code": code, "peerId": "c"})
    assert status == 409
    assert "full" in body["error"]


def test_join_unknown_room(relay):
    status, body = _post(relay, "/mp/join", {"code": "nope", "peerId": "a"})
    assert status == 404


def test_publish_by_non_member(relay):
    _, b = _post(relay, "/mp/create", {"peerId": "a"})
    code = b["code"]
    status, body = _post(relay, "/mp/publish", {"code": code, "peerId": "ghost", "msg": {}})
    assert status == 404


def test_lock_grant_deny_steal_over_http(relay):
    _, b = _post(relay, "/mp/create", {"peerId": "a"})
    code = b["code"]
    _post(relay, "/mp/join", {"code": code, "peerId": "b"})

    status, res = _post(relay, "/mp/lock", {"code": code, "peerId": "a", "key": "track-1"})
    assert status == 200 and res["granted"] is True and res["epoch"] >= 1

    status, res = _post(relay, "/mp/lock", {"code": code, "peerId": "b", "key": "track-1"})
    assert status == 200 and res["granted"] is False and res["owner"] == "a"

    status, res = _post(relay, "/mp/lock", {"code": code, "peerId": "b", "key": "track-1", "steal": True})
    assert status == 200 and res["granted"] is True and res["owner"] == "b"


def test_events_carry_lock_state(relay):
    _, b = _post(relay, "/mp/create", {"peerId": "a"})
    code = b["code"]
    _post(relay, "/mp/join", {"code": code, "peerId": "b"})
    _post(relay, "/mp/lock", {"code": code, "peerId": "a", "key": "track-1"})

    _, ev = _get(relay, f"/mp/events?code={code}&peerId=b&since=0")
    assert ev["locks"]["track-1"]["owner"] == "a"


def test_unlock_frees(relay):
    _, b = _post(relay, "/mp/create", {"peerId": "a"})
    code = b["code"]
    _post(relay, "/mp/lock", {"code": code, "peerId": "a", "key": "track-1"})
    status, res = _post(relay, "/mp/unlock", {"code": code, "peerId": "a", "key": "track-1"})
    assert status == 200 and res["released"] is True
    _, ev = _get(relay, f"/mp/events?code={code}&peerId=a&since=0")
    assert "track-1" not in ev["locks"]


def test_commit_epoch_fencing_over_http(relay):
    _, b = _post(relay, "/mp/create", {"peerId": "a"})
    code = b["code"]
    _post(relay, "/mp/join", {"code": code, "peerId": "b"})

    _, lk = _post(relay, "/mp/lock", {"code": code, "peerId": "a", "key": "T1"})
    held_epoch = lk["epoch"]

    # b steals -> a is now stale.
    _post(relay, "/mp/lock", {"code": code, "peerId": "b", "key": "T1", "steal": True})

    # a's in-flight commit with the stale epoch is fenced (409).
    status, res = _post(relay, "/mp/publish", {
        "code": code, "peerId": "a",
        "msg": {"type": "commit", "logicalId": "T1", "epoch": held_epoch, "blob": "x"}})
    assert status == 409

    # b's commit with the current epoch goes through.
    _, ev = _get(relay, f"/mp/events?code={code}&peerId=b&since=0")  # learn current epoch
    cur = ev["locks"]["T1"]["epoch"]
    status, res = _post(relay, "/mp/publish", {
        "code": code, "peerId": "b",
        "msg": {"type": "commit", "logicalId": "T1", "epoch": cur, "blob": "y"}})
    assert status == 200 and res["seq"] >= 1


def test_leave_drops_empty_room(relay):
    _, b = _post(relay, "/mp/create", {"peerId": "a"})
    code = b["code"]
    _post(relay, "/mp/leave", {"code": code, "peerId": "a"})
    _, health = _get(relay, "/health")
    assert health["rooms"] == 0
    # events on a dropped room -> 404
    req = urllib.request.Request(relay + f"/mp/events?code={code}&peerId=a&since=0")
    try:
        urllib.request.urlopen(req, timeout=5)
        assert False, "expected 404"
    except urllib.error.HTTPError as e:
        assert e.code == 404


# ── Abuse limits (body cap, rate limiter, loopback exemption) ────────────────

def test_oversized_body_is_rejected_413(monkeypatch):
    # A Content-Length above the cap is refused before the body is read, so a huge
    # /slow POST can't exhaust memory. (The body cap applies to everyone — loopback
    # is exempt only from the rate limiter.) Use a tiny cap so the over-cap body
    # still flushes fully before the client reads the 413 (no broken pipe).
    import server as srv
    monkeypatch.setattr(srv, "MAX_BODY_BYTES", 256)
    httpd, port = srv.make_server(0)
    t = threading.Thread(target=httpd.serve_forever, daemon=True)
    t.start()
    try:
        status, body = _post(f"http://127.0.0.1:{port}", "/mp/create",
                             {"peerId": "a", "blob": "x" * 1024})
        assert status == 413
        assert "oversize" in body["error"] or "cap" in body["error"]
    finally:
        httpd.shutdown()
        httpd.server_close()


def test_loopback_is_never_rate_limited(relay):
    # The selftest hammers 127.0.0.1; loopback must sail past the limiter. A burst
    # of creates from loopback all succeed (no 429).
    for _ in range(40):
        status, _b = _post(relay, "/mp/create", {"peerId": "a"})
        assert status == 200


def test_fixed_window_limiter_allows_then_blocks_then_resets():
    clk = [0.0]
    lim = FixedWindowLimiter(limit=3, window_s=10, now_fn=lambda: clk[0])
    assert [lim.allow("1.2.3.4") for _ in range(3)] == [True, True, True]
    assert lim.allow("1.2.3.4") is False          # 4th in-window -> blocked
    assert lim.allow("9.9.9.9") is True           # a different IP has its own window
    clk[0] += 10                                   # window elapsed
    assert lim.allow("1.2.3.4") is True           # reset


def test_fixed_window_limiter_disabled_when_limit_nonpositive():
    lim = FixedWindowLimiter(limit=0, window_s=10)
    assert all(lim.allow("1.2.3.4") for _ in range(1000))


def _raw_request(host, port, raw_bytes):
    """Speak raw HTTP over a socket (urllib won't stream a hand-rolled chunked
    body). Returns the decoded response head + first body chunk we can read."""
    import socket
    s = socket.create_connection((host, port), timeout=5)
    try:
        s.sendall(raw_bytes)
        s.settimeout(5)
        chunks = []
        while True:
            try:
                d = s.recv(4096)
            except socket.timeout:
                break
            if not d:
                break
            chunks.append(d)
            if b"\r\n\r\n" in b"".join(chunks):  # got at least the head
                break
        return b"".join(chunks)
    finally:
        s.close()


# ── P4 self-heal (PR-1): dev-relay blob endpoints ────────────────────────────
# The cloud relay (supabase/functions/relay/index.ts) has always had /mp/blob/head,
# /mp/blob/put-url, /mp/blob/get-url + a real signed-URL object store. The local
# dev/test relay had none, so the whole stem round-trip was invisible to the
# hermetic `--selftest` gate. These mirror the cloud contract (membership-gated
# head/put-url/get-url + PUT/GET raw bytes) for local/CI use only.

def _put(base, path, data, content_type="application/octet-stream"):
    req = urllib.request.Request(
        base + path, data=data, method="PUT",
        headers={"Content-Type": content_type})
    try:
        with urllib.request.urlopen(req, timeout=5) as r:
            return r.status, r.read()
    except urllib.error.HTTPError as e:
        return e.code, e.read()


def _get_raw(base, path):
    try:
        with urllib.request.urlopen(base + path, timeout=5) as r:
            return r.status, r.read()
    except urllib.error.HTTPError as e:
        return e.code, e.read()


def _room(relay):
    _, b = _post(relay, "/mp/create", {"peerId": "a"})
    code = b["code"]
    _post(relay, "/mp/join", {"code": code, "peerId": "b"})
    return code


def test_blob_head_false_for_unknown_hash(relay):
    code = _room(relay)
    status, body = _post(relay, "/mp/blob/head",
                         {"code": code, "peerId": "a", "hash": "ab" * 32, "ext": "wav"})
    assert status == 200
    assert body["exists"] is False


def test_blob_head_rejects_non_member_403(relay):
    code = _room(relay)
    status, body = _post(relay, "/mp/blob/head",
                         {"code": code, "peerId": "ghost", "hash": "ab" * 32, "ext": "wav"})
    assert status == 403
    assert body["error"] == "not_a_member"


def test_blob_put_url_rejects_non_member_403(relay):
    code = _room(relay)
    status, body = _post(relay, "/mp/blob/put-url",
                         {"code": code, "peerId": "ghost", "hash": "cd" * 32, "ext": "wav"})
    assert status == 403
    assert body["error"] == "not_a_member"


def test_blob_get_url_404_when_absent(relay):
    code = _room(relay)
    status, body = _post(relay, "/mp/blob/get-url",
                         {"code": code, "peerId": "a", "hash": "ef" * 32, "ext": "wav"})
    assert status == 404


def test_blob_put_url_then_put_then_head_then_get_url_then_get_round_trip(relay):
    code = _room(relay)
    h = "11" * 32
    payload = b"\x00\x01RIFF-fake-wav-bytes\xff" * 100

    status, body = _post(relay, "/mp/blob/head", {"code": code, "peerId": "a", "hash": h, "ext": "wav"})
    assert status == 200 and body["exists"] is False

    status, body = _post(relay, "/mp/blob/put-url", {"code": code, "peerId": "a", "hash": h, "ext": "wav"})
    assert status == 200
    put_url = body["url"]
    assert put_url.startswith("http://127.0.0.1:")
    assert f"/mp/blob/raw/{h}.wav" in put_url

    status, _b = _put(put_url, "", payload)
    assert status == 200

    status, body = _post(relay, "/mp/blob/head", {"code": code, "peerId": "b", "hash": h, "ext": "wav"})
    assert status == 200 and body["exists"] is True

    status, body = _post(relay, "/mp/blob/get-url", {"code": code, "peerId": "b", "hash": h, "ext": "wav"})
    assert status == 200
    get_url = body["url"]

    status, got = _get_raw(get_url, "")
    assert status == 200
    assert got == payload


def test_blob_get_url_rejects_non_member_403(relay):
    code = _room(relay)
    h = "22" * 32
    _post(relay, "/mp/blob/put-url", {"code": code, "peerId": "a", "hash": h, "ext": "wav"})
    status, body = _post(relay, "/mp/blob/get-url",
                         {"code": code, "peerId": "ghost", "hash": h, "ext": "wav"})
    assert status == 403
    assert body["error"] == "not_a_member"


def test_blob_raw_put_over_max_blob_bytes_is_rejected_413(monkeypatch):
    import server as srv
    monkeypatch.setattr(srv, "MAX_BLOB_BYTES", 64)
    httpd, port = srv.make_server(0)
    t = threading.Thread(target=httpd.serve_forever, daemon=True)
    t.start()
    base = f"http://127.0.0.1:{port}"
    try:
        code = _room(base)
        h = "33" * 32
        _, body = _post(base, "/mp/blob/put-url", {"code": code, "peerId": "a", "hash": h, "ext": "wav"})
        put_url = body["url"]
        status, _b = _put(put_url, "", b"x" * 4096)
        assert status == 413
    finally:
        httpd.shutdown()
        httpd.server_close()


def test_blob_raw_get_missing_key_404(relay):
    # A valid token (minted via get-url's sibling, put-url — the raw endpoint checks
    # the token before existence, so it never leaks exists/not-exists to a request
    # without one) for a key that was never actually PUT -> 404, not a crash/500.
    code = _room(relay)
    h = "66" * 32
    _, body = _post(relay, "/mp/blob/put-url", {"code": code, "peerId": "a", "hash": h, "ext": "wav"})
    put_url = body["url"]
    status, _b = _get_raw(put_url, "")
    assert status == 404


def test_blob_raw_get_rejects_bad_token(relay):
    status, _b = _get_raw(relay, "/mp/blob/raw/deadbeef.wav?tok=nope")
    assert status == 403


def test_blob_raw_put_bad_token_is_rejected(relay):
    code = _room(relay)
    h = "44" * 32
    _post(relay, "/mp/blob/put-url", {"code": code, "peerId": "a", "hash": h, "ext": "wav"})
    # A forged/garbage token must not authorize the write.
    status, _b = _put(relay + f"/mp/blob/raw/{h}.wav?tok=forged", "", b"nope")
    assert status in (401, 403)


def test_blob_delay_hook_env_slows_raw_put(monkeypatch):
    # PR-2 (async transfer, stacked on this PR) needs a way to make a stem transfer
    # artificially slow so a no-UI-freeze test can observe it in flight. Wire the hook
    # now (trivial) even though nothing here exercises the no-freeze behavior itself.
    import server as srv
    monkeypatch.setenv("MOSH_RELAY_BLOB_DELAY_MS", "150")
    httpd, port = srv.make_server(0)
    t = threading.Thread(target=httpd.serve_forever, daemon=True)
    t.start()
    base = f"http://127.0.0.1:{port}"
    try:
        code = _room(base)
        h = "55" * 32
        _, body = _post(base, "/mp/blob/put-url", {"code": code, "peerId": "a", "hash": h, "ext": "wav"})
        put_url = body["url"]
        t0 = time.monotonic()
        status, _b = _put(put_url, "", b"hi")
        elapsed = time.monotonic() - t0
        assert status == 200
        assert elapsed >= 0.14
    finally:
        monkeypatch.delenv("MOSH_RELAY_BLOB_DELAY_MS", raising=False)
        httpd.shutdown()
        httpd.server_close()


def test_blob_corrupt_hook_env_flips_raw_get_bytes_for_matching_ext(monkeypatch):
    # Adversarial-review should-fix (PR-1): nothing previously proved the client-side
    # SHA-256 integrity check (MultiplayerClient::downloadBlob) actually rejects a
    # corrupted transfer -- this hook lets a selftest simulate exactly that
    # deterministically (a dropped/flipped byte mid-transfer), without needing a
    # real flaky network to produce one. When set, the raw GET handler returns the
    # SAME LENGTH payload with its bytes corrupted (flipped) rather than the stored
    # blob -- so a naive "did I get *some* bytes back" check would still pass, only
    # a real content-hash check catches it. EXT-scoped (unlike the blanket delay
    # hook): only keys ending in ".<the configured ext>" are corrupted, so a
    # dedicated selftest can use a reserved sentinel ext and leave every other
    # blob (all real stems use ext="wav") untouched in the SAME gate run.
    import server as srv
    monkeypatch.setenv("MOSH_RELAY_BLOB_CORRUPT", "corrupttest")
    httpd, port = srv.make_server(0)
    t = threading.Thread(target=httpd.serve_forever, daemon=True)
    t.start()
    base = f"http://127.0.0.1:{port}"
    try:
        code = _room(base)
        h = "66" * 32
        payload = b"\x01\x02\x03REAL-STEM-BYTES\xfe\xfd" * 50
        _, body = _post(base, "/mp/blob/put-url", {"code": code, "peerId": "a", "hash": h, "ext": "corrupttest"})
        put_url = body["url"]
        status, _b = _put(put_url, "", payload)
        assert status == 200

        _, body = _post(base, "/mp/blob/get-url", {"code": code, "peerId": "b", "hash": h, "ext": "corrupttest"})
        get_url = body["url"]
        status, got = _get_raw(get_url, "")
        assert status == 200
        assert len(got) == len(payload)
        assert got != payload   # corrupted -- a length-only check would miss this
    finally:
        monkeypatch.delenv("MOSH_RELAY_BLOB_CORRUPT", raising=False)
        httpd.shutdown()
        httpd.server_close()


def test_blob_corrupt_hook_leaves_other_extensions_untouched(monkeypatch):
    # The safety property that makes it OK to leave this hook armed for a whole
    # selftest gate run (not just a dedicated single-purpose invocation, unlike
    # MOSH_RELAY_BLOB_DELAY_MS): with MOSH_RELAY_BLOB_CORRUPT=corrupttest, a real
    # stem (ext="wav") must round-trip byte-perfect.
    import server as srv
    monkeypatch.setenv("MOSH_RELAY_BLOB_CORRUPT", "corrupttest")
    httpd, port = srv.make_server(0)
    t = threading.Thread(target=httpd.serve_forever, daemon=True)
    t.start()
    base = f"http://127.0.0.1:{port}"
    try:
        code = _room(base)
        h = "88" * 32
        payload = b"clean-real-stem-bytes-unaffected" * 20
        _, body = _post(base, "/mp/blob/put-url", {"code": code, "peerId": "a", "hash": h, "ext": "wav"})
        _put(body["url"], "", payload)
        _, body = _post(base, "/mp/blob/get-url", {"code": code, "peerId": "b", "hash": h, "ext": "wav"})
        status, got = _get_raw(body["url"], "")
        assert status == 200
        assert got == payload
    finally:
        monkeypatch.delenv("MOSH_RELAY_BLOB_CORRUPT", raising=False)
        httpd.shutdown()
        httpd.server_close()


def test_blob_corrupt_hook_off_by_default(relay):
    # The corruption hook must be strictly opt-in -- every OTHER test in this file
    # relies on a byte-perfect round trip, so an accidental default-on would be a
    # much bigger regression than the thing it's meant to test.
    code = _room(relay)
    h = "77" * 32
    payload = b"clean-bytes-no-corruption" * 20
    _, body = _post(relay, "/mp/blob/put-url", {"code": code, "peerId": "a", "hash": h, "ext": "wav"})
    _put(body["url"], "", payload)
    _, body = _post(relay, "/mp/blob/get-url", {"code": code, "peerId": "b", "hash": h, "ext": "wav"})
    status, got = _get_raw(body["url"], "")
    assert status == 200
    assert got == payload


def test_chunked_body_is_rejected_not_silently_emptied(relay):
    # A POST with Transfer-Encoding: chunked carries NO Content-Length, so the
    # body-cap (which keys off Content-Length) can't bound it — an attacker could
    # stream an unbounded chunked body (slow-POST / memory pressure) AND the unread
    # body desyncs the keep-alive stream. The relay's control plane only ever sends
    # small Content-Length JSON, so chunked requests are refused outright (411) and
    # the connection closed, rather than parsed as a silent empty {} success.
    host, port = relay.replace("http://", "").split(":")
    port = int(port)
    raw = (
        b"POST /mp/create HTTP/1.1\r\n"
        b"Host: 127.0.0.1\r\n"
        b"Transfer-Encoding: chunked\r\n"
        b"Content-Type: application/json\r\n"
        b"Connection: keep-alive\r\n"
        b"\r\n"
        b"5\r\nhello\r\n"        # one chunk; we never send the 0-terminator
    )
    resp = _raw_request(host, port, raw)
    head = resp.split(b"\r\n\r\n", 1)[0].decode("latin-1")
    status_line = head.splitlines()[0]
    # Must NOT be a 200 (a silently-emptied body would create a room and 200).
    assert " 200 " not in status_line, f"chunked body silently accepted: {status_line!r}"
    assert " 411 " in status_line, f"expected 411 Length Required, got: {status_line!r}"
    # And the relay must signal the connection is ending (can't trust the framing).
    assert "connection: close" in head.lower()
    # The half-open chunked stream never created a room.
    _, health = _get(relay, "/health")
    assert health["rooms"] == 0
