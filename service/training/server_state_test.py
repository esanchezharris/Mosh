"""Golden test for the server training-state loader/saver (service/server.py) — AL-015.

Deterministic + stdlib-only (imports server, which is side-effect-free until main()).
Proves: a MISSING state file initialises normally; a CORRUPT / non-object state file is
reported invalid (stateError surfaced) AND preserved as a .corrupt sidecar on the next save
rather than silently overwritten; the transient stateError is never persisted to disk.
Run via gate.sh run_py_tests (named *_test.py); meant to pass 3× identically.
"""
import json
import os
import sys
import tempfile

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))  # service/
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))  # service/training/
import server


def _with_state_path(path: str):
    server._training_state_path = lambda: path  # type: ignore[assignment]


def main() -> None:
    td = tempfile.mkdtemp(prefix="server-state-test-")
    p = os.path.join(td, "training_state.json")
    _with_state_path(p)

    # 1. MISSING -> initialise normally, no diagnostic.
    st = server._load_training_state()
    assert "stateError" not in st, ("missing", st)
    for k in ("activeAdapterId", "activeAdapterPath", "activeCorpusHash", "jobs", "adapters"):
        assert k in st, ("missing defaults", k, st)

    # 2. CORRUPT -> reported invalid (stateError) but still safe to consume.
    open(p, "w", encoding="utf-8").write("{ not valid json ")
    st = server._load_training_state()
    assert st.get("stateError"), ("corrupt load", st)
    assert st["jobs"] == [] and st["adapters"] == [], st

    # 3. Saving after a corrupt read PRESERVES the corrupt bytes as a .corrupt sidecar
    #    instead of silently overwriting them; the fresh state lands at the main path.
    original = open(p, encoding="utf-8").read()
    server._save_training_state(st)
    backup = p + ".corrupt"
    assert os.path.exists(backup), "corrupt sidecar not preserved"
    assert open(backup, encoding="utf-8").read() == original, "sidecar bytes differ"
    # the transient diagnostic must NOT be persisted (else it would be sticky forever).
    on_disk = json.load(open(p, encoding="utf-8"))
    assert "stateError" not in on_disk, ("stateError persisted", on_disk)
    # and the freshly-written file re-reads clean (no diagnostic).
    assert "stateError" not in server._load_training_state(), "clean reload"

    # 4. NON-OBJECT (valid JSON, wrong shape) -> reported invalid too.
    p2 = os.path.join(td, "state2.json")
    _with_state_path(p2)
    open(p2, "w", encoding="utf-8").write('["not", "an", "object"]')
    st = server._load_training_state()
    assert st.get("stateError"), ("nonobject load", st)

    print("server_state_test: OK (missing=init / corrupt+nonobj=diagnostic + .corrupt sidecar, no sticky stateError)")


if __name__ == "__main__":
    main()
