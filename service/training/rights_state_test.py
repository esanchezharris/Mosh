"""Golden test for training-state read diagnostics (service/training/rights.py) — AL-015.

Deterministic + stdlib-only. Proves the MISSING vs CORRUPT/non-object distinction:
a missing file initialises normally (empty, no diagnostic), while unparseable JSON or a
valid-but-non-object payload is REPORTED invalid (a diagnostic surfaces) instead of being
silently dropped. Run via gate.sh run_py_tests (named *_test.py); meant to pass 3× identically.
"""
import os
import sys
import tempfile

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))  # service/training/
import rights


def main() -> None:
    td = tempfile.mkdtemp(prefix="rights-state-test-")

    # 1. MISSING file -> ({}, None): initialise normally, no diagnostic.
    missing = os.path.join(td, "does-not-exist.json")
    data, err = rights.read_json_object(missing)
    assert data == {} and err is None, ("missing", data, err)
    # legacy read_json still returns just the dict, unchanged.
    assert rights.read_json(missing) == {}, "missing read_json"

    # 2. VALID object -> (data, None).
    valid = os.path.join(td, "valid.json")
    open(valid, "w", encoding="utf-8").write('{"version": 1, "sources": []}')
    data, err = rights.read_json_object(valid)
    assert data == {"version": 1, "sources": []} and err is None, ("valid", data, err)

    # 3. CORRUPT JSON -> ({}, diagnostic): reported invalid, not silently {}.
    corrupt = os.path.join(td, "corrupt.json")
    open(corrupt, "w", encoding="utf-8").write("{ not valid json ")
    data, err = rights.read_json_object(corrupt)
    assert data == {} and err, ("corrupt", data, err)
    assert "corrupt" in err, err

    # 4. NON-OBJECT (valid JSON, wrong shape) -> ({}, diagnostic).
    nonobj = os.path.join(td, "nonobj.json")
    open(nonobj, "w", encoding="utf-8").write("[1, 2, 3]")
    data, err = rights.read_json_object(nonobj)
    assert data == {} and err, ("nonobj", data, err)
    assert "expected object" in err, err

    # 5. load_registry surfaces the diagnostic as stateError for corrupt / non-object,
    #    and never for a healthy or missing registry.
    reg = rights.load_registry(corrupt)
    assert reg.get("stateError"), ("registry corrupt", reg)
    assert reg["sources"] == [], reg  # still safe to consume
    reg = rights.load_registry(nonobj)
    assert reg.get("stateError"), ("registry nonobj", reg)
    reg = rights.load_registry(valid)
    assert "stateError" not in reg, ("registry valid", reg)
    reg = rights.load_registry(missing)
    assert "stateError" not in reg, ("registry missing", reg)

    print("rights_state_test: OK (missing=init / corrupt+nonobj=diagnostic; load_registry stateError)")


if __name__ == "__main__":
    main()
