#!/usr/bin/env python3
"""POST /training/cancel answers what it found — unknown id -> 404, known -> its state.

In-process (no HTTP/port, stdlib only): drives Handler.do_POST directly, the same
way import_registry_test.py does.

The pre-fix bug: the route set the cancel flag when it knew the id and answered
{"ok": true} either way. Native could not tell a known job from a mistyped one, so
`cancel_training_job` reported success for anything and recorded a "cancelled" job
for ids that never existed. The answer now carries what the service actually knows:

  unknown id            -> 404 {"ok": false, "error": "unknown jobId"}   (as /training/status)
  queued / running job  -> 200, its status + progress, cancelRequested true, flag set
  finished job          -> 200, its status + progress, cancelRequested false, job untouched

`status` is the job's state when the request arrived. A stop has to reach the
trainer before the job is "cancelled", so the route never claims that itself.

Run:  python3 service/training/cancel_job_test.py     (exit 0 = all pass)
"""
import io
import json
import os
import sys

os.environ["MOSH_ENABLE_SA3"] = "0"  # FakeAdapter only, before importing server

HERE = os.path.dirname(os.path.abspath(__file__))
SERVICE = os.path.dirname(HERE)
sys.path.insert(0, SERVICE)

import server  # noqa: E402

fails = []


def check(name, ok, detail=""):
    print(f"[{'PASS' if ok else 'FAIL'}] {name}" + (f" — {detail}" if detail else ""))
    if not ok:
        fails.append(name)


def _cancel(job_id):
    """Drive Handler.do_POST in-process; return (status_code_or_None, payload)."""
    raw_body = json.dumps({"jobId": job_id}).encode()
    h = server.Handler.__new__(server.Handler)
    h.path = "/training/cancel"
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
    return captured["code"], (captured["payload"] or {})


def _job(status, progress):
    return {"status": status, "progress": progress, "bundle_path": "/b", "output_dir": "/o",
            "config": {}, "cancel": False, "error": ""}


# The jobs table is module state; the worker thread only starts in main(), so
# nothing here runs or mutates these records except the route under test.
server._training_jobs.clear()
server._training_jobs["job-queued"] = _job("queued", 0.0)
server._training_jobs["job-running"] = _job("running", 0.4)
server._training_jobs["job-ready"] = _job("ready", 1.0)
server._training_jobs["job-error"] = _job("error", 0.2)
server._training_jobs["job-cancelled"] = _job("cancelled", 0.1)
before = json.dumps(server._training_jobs, sort_keys=True)

# 1. Unknown id -> 404 "unknown jobId", and nothing is created or touched.
code, payload = _cancel("no-such-job")
check("unknown jobId -> 404", code == 404, f"code={code} payload={payload}")
check("unknown jobId -> ok false", payload.get("ok") is False, str(payload))
check("unknown jobId -> error names it", payload.get("error") == "unknown jobId", str(payload))
check("unknown jobId creates no job", "no-such-job" not in server._training_jobs,
      str(sorted(server._training_jobs)))
check("unknown jobId leaves every job untouched",
      json.dumps(server._training_jobs, sort_keys=True) == before)

# 2. Missing id is the same refusal (an empty id is not a job).
code, payload = _cancel("")
check("empty jobId -> 404", code == 404 and payload.get("ok") is False, f"code={code} payload={payload}")

# 3. A running job: flagged, and the answer says what state it was in.
code, payload = _cancel("job-running")
check("running job -> 200 ok", code == 200 and payload.get("ok") is True, f"code={code} payload={payload}")
check("running job -> answer carries jobId", payload.get("jobId") == "job-running", str(payload))
check("running job -> status is the state found, not 'cancelled'", payload.get("status") == "running", str(payload))
check("running job -> progress reported", payload.get("progress") == 0.4, str(payload))
check("running job -> cancelRequested true", payload.get("cancelRequested") is True, str(payload))
check("running job -> cancel flag set", server._training_jobs["job-running"]["cancel"] is True)
check("running job -> status left for the worker to change",
      server._training_jobs["job-running"]["status"] == "running")

# 4. A queued job is still stoppable.
code, payload = _cancel("job-queued")
check("queued job -> 200, status queued, cancelRequested true",
      code == 200 and payload.get("status") == "queued" and payload.get("cancelRequested") is True,
      f"code={code} payload={payload}")
check("queued job -> cancel flag set", server._training_jobs["job-queued"]["cancel"] is True)

# 5. Finished jobs: known, but there is nothing to stop — say so, change nothing.
for jid, status in (("job-ready", "ready"), ("job-error", "error"), ("job-cancelled", "cancelled")):
    code, payload = _cancel(jid)
    check(f"{status} job -> 200 ok", code == 200 and payload.get("ok") is True, f"code={code} payload={payload}")
    check(f"{status} job -> status reported as found", payload.get("status") == status, str(payload))
    check(f"{status} job -> cancelRequested false", payload.get("cancelRequested") is False, str(payload))
    check(f"{status} job -> cancel flag NOT set", server._training_jobs[jid]["cancel"] is False)
    check(f"{status} job -> status unchanged", server._training_jobs[jid]["status"] == status)

# 6. Stopping an already-flagged run again reports the request as still standing.
code, payload = _cancel("job-running")
check("second cancel on a flagged run -> cancelRequested stays true",
      code == 200 and payload.get("cancelRequested") is True, f"code={code} payload={payload}")

print(f"\ncancel_job_test: {'OK' if not fails else 'FAILED'} ({len(fails)} failing)")
sys.exit(1 if fails else 0)
