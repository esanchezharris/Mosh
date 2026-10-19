#!/usr/bin/env python3
"""Service loopback guard — the helper only serves this machine's own Mosh clients.

Spins up the real server.py HTTP service (FakeAdapter, ephemeral port) and proves:

  1. A browser-style cross-site POST (Origin: https://evil.example, text/plain body,
     the no-preflight shape any web page can send to 127.0.0.1) is refused with 403
     and queues NO job, so a page cannot choose outputWav/manifest paths.
  2. A DNS-rebinding request (Host: a non-loopback name, including one that merely
     starts with "127.") is refused with 403 unless MOSH_SERVICE_ALLOW_LAN=1.
  3. Native clients (no Origin, loopback Host) and loopback Origins still work.
  4. main() refuses to bind a non-loopback MOSH_SERVICE_HOST without the opt-in.

Run:  python3 service/scripts/loopback_guard_test.py     (exit 0 = all pass)
"""
import http.client
import json
import os
import sys
import threading
from http.server import ThreadingHTTPServer

os.environ["MOSH_ENABLE_SA3"] = "0"
os.environ.pop("MOSH_SERVICE_ALLOW_LAN", None)

HERE = os.path.dirname(os.path.abspath(__file__))
SERVICE = os.path.dirname(HERE)
sys.path.insert(0, SERVICE)

import server  # noqa: E402

fails = []


def check(name, ok, detail=""):
    print(f"[{'PASS' if ok else 'FAIL'}] {name}" + (f" — {detail}" if detail else ""))
    if not ok:
        fails.append(name)


def request(port, method, path, headers=None, body=b""):
    conn = http.client.HTTPConnection("127.0.0.1", port, timeout=8)
    try:
        conn.putrequest(method, path, skip_host=True, skip_accept_encoding=True)
        hdrs = {"Host": f"127.0.0.1:{port}"}
        hdrs.update(headers or {})
        for k, v in hdrs.items():
            if v is not None:
                conn.putheader(k, v)
        conn.putheader("Content-Length", str(len(body)))
        conn.endheaders()
        if body:
            conn.send(body)
        resp = conn.getresponse()
        return resp.status, resp.read()
    finally:
        conn.close()


def job_count():
    with server._lock:
        return len(server._jobs)


def main() -> int:
    check("helper: localhost / 127.x / ::1 are loopback",
          all(server._is_loopback_host(h) for h in
              ("localhost", "localhost:8770", "127.0.0.1", "127.0.0.1:8770", "127.5.6.7",
               "::1", "[::1]", "[::1]:8770")))
    check("helper: LAN, wildcard, empty and rebinding names are not loopback",
          not any(server._is_loopback_host(h) for h in
                  ("", "0.0.0.0", "192.168.1.20", "10.0.0.1:8770", "evil.example",
                   "127.0.0.1.evil.example", "127.0.0.1.evil.example:8770", "[::]")))

    httpd = ThreadingHTTPServer(("127.0.0.1", 0), server.Handler)
    port = httpd.server_address[1]
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    try:
        body = json.dumps({"adapter": "fake", "inputWav": "", "outputWav": "/tmp/x.wav",
                           "params": {"mode": "generate"}}).encode()

        before = job_count()
        status, _ = request(port, "POST", "/submit",
                            {"Origin": "https://evil.example", "Content-Type": "text/plain"}, body)
        check("cross-site browser POST /submit is refused", status == 403, f"status={status}")
        check("cross-site browser POST queues no job", job_count() == before)

        status, _ = request(port, "POST", "/submit", {"Origin": "null"}, body)
        check("opaque (null) Origin is refused", status == 403, f"status={status}")

        for host in ("evil.example", "127.0.0.1.evil.example", "192.168.1.20:8770"):
            status, _ = request(port, "GET", "/health", {"Host": host})
            check(f"Host {host!r} is refused without the LAN opt-in", status == 403, f"status={status}")

        os.environ["MOSH_SERVICE_ALLOW_LAN"] = "1"
        try:
            status, _ = request(port, "GET", "/health", {"Host": "192.168.1.20:8770"})
            check("LAN Host is served with MOSH_SERVICE_ALLOW_LAN=1", status == 200, f"status={status}")
            status, _ = request(port, "GET", "/health",
                                {"Host": "192.168.1.20:8770", "Origin": "https://evil.example"})
            check("cross-site Origin is refused even with the LAN opt-in", status == 403, f"status={status}")
        finally:
            os.environ.pop("MOSH_SERVICE_ALLOW_LAN", None)

        status, raw = request(port, "GET", "/health")
        check("native GET /health (no Origin, loopback Host) is served",
              status == 200 and json.loads(raw).get("ok") is True, f"status={status}")
        status, _ = request(port, "GET", "/health", {"Origin": f"http://localhost:{port}"})
        check("loopback Origin is served", status == 200, f"status={status}")

        before = job_count()
        status, raw = request(port, "POST", "/submit",
                              {"Content-Type": "application/json"}, body)
        check("native POST /submit still queues a job",
              status == 200 and json.loads(raw).get("ok") is True and job_count() == before + 1,
              f"status={status}")
        # Cancel it so the background worker (not started here) leaves no state behind.
        jid = json.loads(raw).get("jobId", "")
        request(port, "POST", "/cancel", {"Content-Type": "application/json"},
                json.dumps({"jobId": jid}).encode())
    finally:
        httpd.shutdown()

    os.environ["MOSH_SERVICE_HOST"] = "0.0.0.0"
    try:
        rc = server.main()
        check("main() refuses a 0.0.0.0 bind without the LAN opt-in", rc == 2, f"rc={rc}")
    finally:
        os.environ.pop("MOSH_SERVICE_HOST", None)

    print("\nALL PASS" if not fails else f"\n{len(fails)} FAILED: {fails}")
    return 0 if not fails else 1


if __name__ == "__main__":
    sys.exit(main())
