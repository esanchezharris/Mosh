"""Integration tests for the relay HTTP server (relay/server.py): real HTTP
round-trips between two simulated peers against an ephemeral-port instance."""
import json
import os
import sys
import threading
import urllib.error
import urllib.request

sys.path.insert(0, os.path.dirname(__file__))

import pytest  # noqa: E402
from server import make_server  # noqa: E402


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
