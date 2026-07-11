#!/usr/bin/env python3
"""Training registry-import validation — malformed body -> 400, registry unchanged.

In-process (no HTTP/port, stdlib only): drives Handler.do_POST directly for the
POST /training/import-registry route. A malformed or non-object JSON body MUST be
rejected with HTTP 400 and MUST NOT clobber the rights registry.

The pre-fix bug: _read_json swallowed the JSON parse error and returned {}, so a
truncated/garbage body fell through to save_registry({}) — wiping every source and
returning 200 "ok". A valid-but-non-object body (e.g. a JSON array) instead raised
AttributeError on data.get(...) -> a 500. This guards both.

A follow-up review found two more silent-wipe paths that the first guard didn't
close: an EMPTY body (Content-Length 0) decodes to {} with _json_malformed=False
(indistinguishable from "no body sent" by design — see _read_json), and a
well-formed object that simply omits the "registry" key (e.g. {"foo": 1}) is
still `isinstance(data, dict)`. Both used to fall through to
`data.get("registry", {})` == {} -> save_registry(path, {}) -> 200, silently
wiping the registry. The guard now requires "registry" to be a present key, not
just a legal JSON object; an explicit {"registry": {}} still clears on purpose.

Run:  python3 service/training/import_registry_test.py     (exit 0 = all pass)
"""
import io
import json
import os
import sys
import tempfile

os.environ["MOSH_ENABLE_SA3"] = "0"  # FakeAdapter only, before importing server

HERE = os.path.dirname(os.path.abspath(__file__))
SERVICE = os.path.dirname(HERE)
sys.path.insert(0, SERVICE)

import server  # noqa: E402
from training.rights import load_registry  # noqa: E402

fails = []


def check(name, ok, detail=""):
    print(f"[{'PASS' if ok else 'FAIL'}] {name}" + (f" — {detail}" if detail else ""))
    if not ok:
        fails.append(name)


def _post(path, raw_body):
    """Drive Handler.do_POST in-process; return (status_code_or_None, payload)."""
    h = server.Handler.__new__(server.Handler)
    h.path = path
    h.headers = {"Content-Length": str(len(raw_body)), "Host": "127.0.0.1:8770"}
    h.rfile = io.BytesIO(raw_body)
    captured = {"code": None, "payload": None}

    def _capture(code, payload):
        captured["code"] = code
        captured["payload"] = payload

    h._send = _capture  # type: ignore[assignment]
    try:
        h.do_POST()
    except Exception as e:  # noqa: BLE001  — an uncaught handler error == no clean response
        captured["exc"] = repr(e)
    return captured["code"], captured["payload"]


def _source_ids(path):
    return [str(s.get("source_id", "")) for s in load_registry(path).get("sources", [])]


BASELINE = {
    "version": 1,
    "sources": [{
        "source_id": "beat-001", "title": "My Beat", "creator": "me",
        "source_url": "https://example.com/b", "local_path": "",
        "user_claimed_license": "owned", "proof_of_rights": "self",
        "approved_for_training": True,
    }],
}

with tempfile.TemporaryDirectory() as tmp:
    reg_path = os.path.join(tmp, "rights_registry.json")
    server.save_registry(reg_path, BASELINE)
    server._training_registry_path = lambda: reg_path  # route reads via this
    check("baseline registry has beat-001", _source_ids(reg_path) == ["beat-001"],
          str(_source_ids(reg_path)))

    # 1. Malformed (unparseable) JSON body -> 400, registry untouched.
    code, payload = _post("/training/import-registry", b'{"registry": {"sources": [')
    check("malformed JSON -> 400", code == 400, f"code={code} payload={payload}")
    check("malformed JSON leaves registry unchanged", _source_ids(reg_path) == ["beat-001"],
          str(_source_ids(reg_path)))

    # 2. Valid JSON but not an object (array) -> 400, registry untouched (was a 500).
    code, payload = _post("/training/import-registry", b"[1, 2, 3]")
    check("non-object JSON body -> 400", code == 400, f"code={code} payload={payload}")
    check("non-object JSON leaves registry unchanged", _source_ids(reg_path) == ["beat-001"],
          str(_source_ids(reg_path)))

    # 3. registry field present but not an object -> 400 (pre-existing guard still holds).
    code, payload = _post("/training/import-registry", json.dumps({"registry": "nope"}).encode())
    check("registry field not-an-object -> 400", code == 400, f"code={code} payload={payload}")
    check("bad registry field leaves registry unchanged", _source_ids(reg_path) == ["beat-001"],
          str(_source_ids(reg_path)))

    # 4. Happy path: a well-formed import still applies and returns 200.
    good = {"registry": {"version": 1, "sources": [{
        "source_id": "beat-002", "title": "Next", "creator": "me",
        "source_url": "https://example.com/n", "local_path": "",
        "user_claimed_license": "owned", "proof_of_rights": "self",
        "approved_for_training": True,
    }]}}
    code, payload = _post("/training/import-registry", json.dumps(good).encode())
    check("well-formed import -> 200", code == 200, f"code={code} payload={payload}")
    check("well-formed import applies (beat-002)", _source_ids(reg_path) == ["beat-002"],
          str(_source_ids(reg_path)))

    # 5. Empty body (Content-Length 0, e.g. a dropped/short-circuited POST) -> 400,
    #    registry untouched (was a silent wipe to 200).
    code, payload = _post("/training/import-registry", b"")
    check("empty body -> 400", code == 400, f"code={code} payload={payload}")
    check("empty body leaves registry unchanged", _source_ids(reg_path) == ["beat-002"],
          str(_source_ids(reg_path)))

    # 6. Well-formed object missing the "registry" key entirely -> 400, registry
    #    untouched (was a silent wipe to 200).
    code, payload = _post("/training/import-registry", json.dumps({"foo": 1}).encode())
    check("registry-less object -> 400", code == 400, f"code={code} payload={payload}")
    check("registry-less object leaves registry unchanged", _source_ids(reg_path) == ["beat-002"],
          str(_source_ids(reg_path)))

    # 7. Explicit {"registry": {}} still clears on purpose (the one intentional wipe).
    code, payload = _post("/training/import-registry", json.dumps({"registry": {}}).encode())
    check("explicit empty registry -> 200", code == 200, f"code={code} payload={payload}")
    check("explicit empty registry clears sources", _source_ids(reg_path) == [],
          str(_source_ids(reg_path)))

print(f"\n{'OK' if not fails else 'FAILED'}: {len(fails)} failure(s)")
sys.exit(len(fails))
