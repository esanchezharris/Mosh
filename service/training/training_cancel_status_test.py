#!/usr/bin/env python3
"""A Stop on a real local training run is recorded as "cancelled", not "error".

In-process (no HTTP/port): drives server._run_training_job through the REAL
local_pmetal path — trainer_job._local_train -> local_pmetal.run_training, a real
subprocess in its own process group, killpg on Stop — and presses Stop through
Handler.do_POST("/training/cancel"), the same route the native Stop reaches.
Only the parts that need the owner's machine are stood in: readiness, the SA3
precompute (MLX + weights), and the pmetal binary (a python sleeper).

The pre-fix bug: run_training returned 130 on Stop, _local_train raised a plain
RuntimeError("training cancelled"), and _run_training_job's except branch wrote
status "error" for every exception. /training/status relayed that verbatim and
the LoRA Lab header said "failed" after the producer pressed Stop. The stub path
never showed it because its step loop catches the cancel before train_lora runs.

  Stop while the trainer runs      -> "cancelled", error "", recorded "cancelled"
  Stop during precompute           -> "cancelled", and the trainer is never launched
  trainer exits non-zero, no Stop  -> "error" with the exit code (a real failure)
  real failure while Stop pending  -> "error" with its message (Stop did not end it)
  trainer exits 130 by itself      -> "error" naming the exit code
  precompute(should_cancel=...)    -> stops between clips (needs mlx; skips loudly)

Physical confirmation on a real pmetal run is an owner check; this proves the seam.

Run:  python3 service/training/training_cancel_status_test.py     (exit 0 = all pass)
"""
import io
import json
import os
import sys
import tempfile
import threading
import time

os.environ["MOSH_ENABLE_SA3"] = "0"  # FakeAdapter only, before importing server
os.environ["MOSH_TRAINING_BACKEND"] = "local_pmetal"

HERE = os.path.dirname(os.path.abspath(__file__))
SERVICE = os.path.dirname(HERE)
sys.path.insert(0, SERVICE)

import server  # noqa: E402
from training import lab_publish as LAB  # noqa: E402
from training import local_pmetal as LP  # noqa: E402
from training import sa3_precompute as PC  # noqa: E402

fails = []


def check(name, ok, detail=""):
    print(f"[{'PASS' if ok else 'FAIL'}] {name}" + (f" — {detail}" if detail else ""))
    if not ok:
        fails.append(name)


TMP = tempfile.mkdtemp(prefix="mosh-train-cancel-")
# Never touch the checked-in service/training/training_state.json.
STATE_PATH = os.path.join(TMP, "training_state.json")
server._training_state_path = lambda: STATE_PATH  # type: ignore[assignment]

# The precompute stand-in runs on the real MLX-owning worker thread, exactly as
# the service runs it (train() is given run_on_mlx=_run_on_mlx_thread).
threading.Thread(target=server._worker_loop, daemon=True).start()

# ── stand-ins for the owner-machine pieces ────────────────────────────────────
LP.readiness = lambda: (True, [])  # type: ignore[assignment]
LP.trainer_bin = lambda: sys.executable  # type: ignore[assignment]
LP.base_dit_path = lambda: os.path.join(TMP, "base.safetensors")  # type: ignore[assignment]
LAB.publish = lambda *a, **k: []  # type: ignore[assignment]  — never link into sa3/lab/

trainer = {"argv": [], "launches": 0}
LP.build_argv = lambda *a, **k: list(trainer["argv"])  # type: ignore[assignment]
_real_run_training = LP.run_training


def _counting_run_training(*a, **k):
    trainer["launches"] += 1
    return _real_run_training(*a, **k)


LP.run_training = _counting_run_training  # type: ignore[assignment]

precompute_hook = {"fn": None}


def _fake_precompute(clips, out_dir, *a, **k):
    os.makedirs(out_dir, exist_ok=True)
    manifest_path = os.path.join(out_dir, "manifest.json")
    with open(manifest_path, "w") as f:
        json.dump([], f)
    if precompute_hook["fn"]:
        precompute_hook["fn"]()
    return {"manifest_path": manifest_path, "count": len(clips), "skipped": []}


_real_precompute = PC.precompute  # test 4 drives the real one
PC.precompute = _fake_precompute  # type: ignore[assignment]


def _bundle(name):
    """A minimal real corpus bundle: one source with its audio under sources/."""
    b = os.path.join(TMP, name)
    os.makedirs(os.path.join(b, "sources"), exist_ok=True)
    wav = os.path.join(b, "sources", "clip.wav")
    with open(wav, "wb") as f:
        f.write(b"RIFF")
    with open(os.path.join(b, "corpus.manifest.json"), "w") as f:
        json.dump({"bundle_hash": name, "sources": [
            {"source_id": "clip", "copied_path": wav, "caption": "test clip"}]}, f)
    return b


def _submit(name):
    record = server._create_training_job_record({"corpusBundle": _bundle(name)}, "127.0.0.1:8770")
    assert record.get("ok"), record
    return record["jobId"]


def _stop(job_id):
    """Press Stop the way native does: POST /training/cancel through the handler."""
    raw_body = json.dumps({"jobId": job_id}).encode()
    h = server.Handler.__new__(server.Handler)
    h.path = "/training/cancel"
    h.headers = {"Content-Length": str(len(raw_body)), "Host": "127.0.0.1:8770"}
    h.rfile = io.BytesIO(raw_body)
    sent = {}
    h._send = lambda code, payload: sent.update(code=code, payload=payload)  # type: ignore[assignment]
    h.do_POST()
    return sent


def _run(job_id):
    t = threading.Thread(target=server._run_training_job, args=(job_id,), daemon=True)
    t.start()
    return t


def _recorded(job_id):
    with open(STATE_PATH) as f:
        state = json.load(f)
    return next((j for j in state.get("jobs", []) if j.get("jobId") == job_id), {})


def _wait_for(pred, timeout):
    deadline = time.time() + timeout
    while time.time() < deadline:
        if pred():
            return True
        time.sleep(0.05)
    return False


def _status(job_id):
    with server._training_lock:
        job = server._training_jobs[job_id]
        return job["status"], job.get("error")


# ── 1. Stop while the trainer subprocess is running ───────────────────────────
def test_stop_while_trainer_runs_is_cancelled():
    started = os.path.join(TMP, "trainer-started")
    trainer["argv"] = [sys.executable, "-c",
                       f"import time; open({started!r}, 'w').close(); time.sleep(60)"]
    trainer["launches"] = 0
    precompute_hook["fn"] = None
    jid = _submit("bundle-running")
    t = _run(jid)
    check("stand-in trainer actually started", _wait_for(lambda: os.path.exists(started), 15.0))
    sent = _stop(jid)
    check("Stop accepted for the running job",
          sent.get("code") == 200 and sent["payload"].get("cancelRequested") is True, str(sent))
    t.join(20.0)
    check("run returned after Stop", not t.is_alive())
    status, error = _status(jid)
    check("status is cancelled, not error", status == "cancelled", f"status={status!r} error={error!r}")
    check("no error text on a cancelled job", not error, repr(error))
    rec = _recorded(jid)
    check("recorded job is cancelled", rec.get("status") == "cancelled", str(rec))


# ── 2. Stop during precompute: never launch the trainer just to kill it ───────
def test_stop_during_precompute_skips_the_trainer():
    trainer["argv"] = [sys.executable, "-c", "import time; time.sleep(60)"]
    trainer["launches"] = 0
    jid = _submit("bundle-precompute")
    precompute_hook["fn"] = lambda: _stop(jid)
    t = _run(jid)
    t.join(20.0)
    precompute_hook["fn"] = None
    check("run returned after Stop in precompute", not t.is_alive())
    status, error = _status(jid)
    check("precompute Stop is cancelled", status == "cancelled", f"status={status!r} error={error!r}")
    check("trainer never launched after a precompute Stop", trainer["launches"] == 0,
          f"launches={trainer['launches']}")
    check("recorded precompute-Stop job is cancelled", _recorded(jid).get("status") == "cancelled")


# ── 3. A real failure with no Stop stays an error ─────────────────────────────
def test_trainer_failure_without_stop_stays_error():
    trainer["argv"] = [sys.executable, "-c", "import sys; sys.exit(3)"]
    trainer["launches"] = 0
    precompute_hook["fn"] = None
    jid = _submit("bundle-failure")
    t = _run(jid)
    t.join(20.0)
    status, error = _status(jid)
    check("trainer failure is error", status == "error", f"status={status!r}")
    check("error names the exit code", "trainer exited 3" in (error or ""), repr(error))
    rec = _recorded(jid)
    check("recorded failure is error", rec.get("status") == "error" and "trainer exited 3" in rec.get("error", ""),
          str(rec))


# ── 4. A real failure is still an error when a Stop happens to be pending ─────
def test_failure_with_stop_pending_stays_error():
    trainer["argv"] = [sys.executable, "-c", "import time; time.sleep(60)"]
    trainer["launches"] = 0
    jid = _submit("bundle-failure-pending-stop")

    def _stop_then_break():
        _stop(jid)
        raise RuntimeError("encode exploded")

    precompute_hook["fn"] = _stop_then_break
    t = _run(jid)
    t.join(20.0)
    precompute_hook["fn"] = None
    status, error = _status(jid)
    check("failure with Stop pending is error", status == "error", f"status={status!r}")
    check("failure with Stop pending keeps its message", error == "encode exploded", repr(error))


# ── 5. A trainer that exits 130 by itself was not stopped by anyone ───────────
def test_trainer_exit_130_without_stop_is_error():
    trainer["argv"] = [sys.executable, "-c", "import sys; sys.exit(130)"]
    trainer["launches"] = 0
    precompute_hook["fn"] = None
    jid = _submit("bundle-exit-130")
    t = _run(jid)
    t.join(20.0)
    status, error = _status(jid)
    check("unrequested exit 130 is error", status == "error", f"status={status!r}")
    check("unrequested exit 130 names the exit code", "trainer exited 130" in (error or ""), repr(error))


# ── 6. precompute itself stops between clips ─────────────────────────────────
def test_precompute_honours_should_cancel_between_clips():
    try:
        import mlx.core as mx
    except Exception as exc:  # noqa: BLE001
        print(f"[SKIP] precompute should_cancel — mlx unavailable ({exc}); "
              "the server-level tests above still ran")
        return

    class _Engine:
        def encode_for_training(self, wav):
            return mx.zeros((1, 64, 8)), 1.0

        def cond_for_training(self, caption, seconds):
            return mx.zeros((1, 4, 8)), mx.zeros((1, 8))

    wavs = []
    for i in range(3):
        p = os.path.join(TMP, f"pc-{i}.wav")
        open(p, "wb").close()
        wavs.append({"id": f"c{i}", "wav": p, "caption": "x"})
    encoded = []
    stop = {"v": False}

    def _progress(done, total, sample_id):
        encoded.append(sample_id)
        stop["v"] = True  # Stop lands while the first clip is being written

    res = _real_precompute(wavs, os.path.join(TMP, "pc-out"), engine=_Engine(),
                          on_progress=_progress, should_cancel=lambda: stop["v"])
    check("precompute stopped after the clip in flight", res["count"] == 1 and encoded == ["c0"],
          f"count={res['count']} encoded={encoded}")
    check("precompute reports it was cancelled", res.get("cancelled") is True, str(res))


def main():
    for name, fn in [(n, f) for n, f in globals().items() if n.startswith("test_") and callable(f)]:
        try:
            fn()
        except Exception as exc:  # noqa: BLE001
            check(name, False, f"{type(exc).__name__}: {exc}")
    if fails:
        print(f"\n{len(fails)} FAILED: {fails}")
        sys.exit(1)
    print("\ntraining_cancel_status_test: OK")


if __name__ == "__main__":
    main()
