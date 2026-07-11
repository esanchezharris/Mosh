#!/usr/bin/env python3
"""Service _read_json robustness test — malformed / oversized Content-Length.

Spins up the real server.py HTTP service (FakeAdapter, ephemeral port) and drives
the POST body-parse path with a raw http.client so the Content-Length header is
under full control. Proves the two BH-server-clen defects are fixed:

  1. A NON-NUMERIC Content-Length must yield a proper HTTP 400 (not an unhandled
     ValueError that escapes do_POST and drops the connection).
  2. An OVERSIZED Content-Length (> server.MAX_BODY_BYTES) must be rejected with
     413 *before* any rfile.read(n) — never an unbounded read that hangs/allocs.

It also pins the PR #297 contract that survives the fix: an empty body and a
malformed-JSON body both parse to {} and reach the endpoint's own 400, and a
well-formed JSON body still parses normally.

Run:  python3 service/scripts/read_json_test.py     (exit 0 = all pass)
"""
import http.client
import json
import os
import sys
import threading
from http.server import ThreadingHTTPServer

# Force FakeAdapter-only BEFORE importing the server (skips all SA3 probing).
os.environ["MOSH_ENABLE_SA3"] = "0"

HERE = os.path.dirname(os.path.abspath(__file__))
SERVICE = os.path.dirname(HERE)
sys.path.insert(0, SERVICE)

import server  # noqa: E402

fails = []


def check(name, ok, detail=""):
    print(f"[{'PASS' if ok else 'FAIL'}] {name}" + (f" — {detail}" if detail else ""))
    if not ok:
        fails.append(name)


def raw_post(port, path, content_length_header, body=b"", timeout=8):
    """POST with an arbitrary (possibly bogus) Content-Length header value.

    Returns (status:int|None, error:str). status is None when the connection was
    dropped or the request timed out (i.e. the server failed to answer at all).
    """
    conn = http.client.HTTPConnection("127.0.0.1", port, timeout=timeout)
    try:
        conn.putrequest("POST", path, skip_accept_encoding=True)
        conn.putheader("Content-Type", "application/json")
        conn.putheader("Content-Length", str(content_length_header))
        conn.endheaders()
        if body:
            conn.send(body)
        resp = conn.getresponse()
        status = resp.status
        resp.read()
        return status, ""
    except Exception as e:  # noqa: BLE001 — dropped conn / timeout == the bug
        return None, f"{type(e).__name__}: {e}"
    finally:
        conn.close()


def main():
    httpd = ThreadingHTTPServer(("127.0.0.1", 0), server.Handler)
    port = httpd.server_address[1]
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    try:
        # Guard: the cap exists and is a sane positive bound.
        cap = getattr(server, "MAX_BODY_BYTES", None)
        check("MAX_BODY_BYTES defined + positive", isinstance(cap, int) and cap > 0, f"cap={cap}")
        cap = cap if isinstance(cap, int) and cap > 0 else (64 * 1024 * 1024)

        # 1. Non-numeric Content-Length: must be a real 400, NOT a dropped connection.
        status, err = raw_post(port, "/submit", "not-a-number", body=b"{}")
        check("non-numeric Content-Length -> 400 (not dropped connection)",
              status == 400, err or f"status={status}")

        # 2. Oversized Content-Length: rejected with 413 before reading the body
        #    (a tiny actual body is sent — the buggy path would block on rfile.read(cap+1)).
        status, err = raw_post(port, "/submit", cap + 1, body=b"{}")
        check("oversized Content-Length -> 413 (rejected before read)",
              status == 413, err or f"status={status}")

        # 3. Contract (PR #297): a malformed JSON body of a VALID length -> {} -> endpoint 400.
        bad = b"not json at all"
        status, err = raw_post(port, "/submit", len(bad), body=bad)
        check("malformed JSON body -> endpoint 400 (contract intact)",
              status == 400, err or f"status={status}")

        # 4. Contract: an empty body (no Content-Length) -> {} -> endpoint 400.
        status, err = raw_post(port, "/submit", 0, body=b"")
        check("empty body -> endpoint 400 (contract intact)",
              status == 400, err or f"status={status}")

        # 5. Normal path still parses well-formed JSON (cancel accepts any jobId -> 200).
        good = json.dumps({"jobId": "does-not-exist"}).encode()
        status, err = raw_post(port, "/cancel", len(good), body=good)
        check("well-formed JSON body still parses -> 200", status == 200, err or f"status={status}")
    finally:
        httpd.shutdown()

    print(f"\n{'ALL PASS' if not fails else 'FAILURES: ' + ', '.join(fails)}")
    return 1 if fails else 0


if __name__ == "__main__":
    raise SystemExit(main())
