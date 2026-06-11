#!/usr/bin/env python3
"""MoshIR validator — the Python-side authority on op well-formedness.

Every pipeline component (extraction, Monster, GEPA, the store importer)
validates ops against moshir-0.3.schema.json through this module. The C++
executor has its own typed validation (src/moshir/); the schema here is the
source of truth both must agree with, and the lockstep fixtures under
moshir/fixtures/ are replayed by both sides' test suites.

Error messages are deliberately compact and concrete — they are fed back to
LLMs (extraction repair retries, GEPA textual feedback), where
'params.notes.0.vel: 200 is greater than the maximum of 127' is exactly the
kind of trace reflective prompt evolution feeds on.

CLI:
  python3 moshir/validate.py ops.json      # one op, an op list, or a step {ops: [...]}
  python3 moshir/validate.py --self-test   # run the bundled fixtures
Exit code = number of invalid ops (0 = all valid).
"""
from __future__ import annotations

import json
import re
import sys
from pathlib import Path

try:
    import jsonschema
except ModuleNotFoundError:  # pragma: no cover - exercised by repo shell gates
    jsonschema = None

SCHEMA_PATH = Path(__file__).parent / "moshir-0.3.schema.json"
IR_VERSION = "0.3"

_schema: dict | None = None
_kinds: list[str] | None = None
_branch_validators: dict[str, object] = {}


def schema() -> dict:
    global _schema
    if _schema is None:
        _schema = json.loads(SCHEMA_PATH.read_text())
        if jsonschema is not None:
            jsonschema.validators.validator_for(_schema).check_schema(_schema)
    return _schema


def kind_enum() -> list[str]:
    """All op kinds in the closed v0.1 vocabulary, in schema order."""
    global _kinds
    if _kinds is None:
        _kinds = [ref["$ref"].split("/")[-1] for ref in schema()["$defs"]["op"]["oneOf"]]
    return _kinds


def _branch_validator(kind: str):
    """Validator for one op kind's branch — gives focused errors instead of
    a 41-way oneOf mismatch dump."""
    if jsonschema is None:
        raise RuntimeError("jsonschema is not installed")
    v = _branch_validators.get(kind)
    if v is None:
        s = schema()
        cls = jsonschema.validators.validator_for(s)
        v = cls({"$ref": f"#/$defs/{kind}", "$defs": s["$defs"]})
        _branch_validators[kind] = v
    return v


def _schema_ref(ref: str) -> dict:
    prefix = "#/$defs/"
    name = ref[len(prefix):] if ref.startswith(prefix) else ref
    if name not in schema()["$defs"]:
        raise ValueError(f"unsupported $ref: {ref}")
    return schema()["$defs"][name]


def _path(path: str) -> str:
    return path or "(op)"


def _type_ok(value, expected: str) -> bool:
    if expected == "object":
        return isinstance(value, dict)
    if expected == "array":
        return isinstance(value, list)
    if expected == "string":
        return isinstance(value, str)
    if expected == "boolean":
        return isinstance(value, bool)
    if expected == "integer":
        return isinstance(value, int) and not isinstance(value, bool)
    if expected == "number":
        return isinstance(value, (int, float)) and not isinstance(value, bool)
    return True


def _fallback_validate(value, spec: dict, path: str = "") -> list[str]:
    """Tiny JSON Schema subset for moshir-0.3.schema.json.

    jsonschema is still used when installed. This fallback exists so harnesses,
    the trajectory importer, and CI do not depend on a global Python package.
    """
    if "$ref" in spec:
        return _fallback_validate(value, _schema_ref(spec["$ref"]), path)

    errors: list[str] = []

    if "const" in spec and value != spec["const"]:
        errors.append(f"{_path(path)}: {value!r} is not equal to {spec['const']!r}")
    if "enum" in spec and value not in spec["enum"]:
        errors.append(f"{_path(path)}: {value!r} is not one of {spec['enum']}")

    expected_type = spec.get("type")
    if expected_type is not None and not _type_ok(value, expected_type):
        return [f"{_path(path)}: {value!r} is not of type {expected_type}"]

    if isinstance(value, str):
        if "minLength" in spec and len(value) < spec["minLength"]:
            errors.append(f"{_path(path)}: {value!r} is too short")
        if "pattern" in spec and re.fullmatch(spec["pattern"], value) is None:
            errors.append(f"{_path(path)}: {value!r} does not match {spec['pattern']}")

    if isinstance(value, (int, float)) and not isinstance(value, bool):
        if "minimum" in spec and value < spec["minimum"]:
            errors.append(f"{_path(path)}: {value} is less than the minimum of {spec['minimum']}")
        if "maximum" in spec and value > spec["maximum"]:
            errors.append(f"{_path(path)}: {value} is greater than the maximum of {spec['maximum']}")
        if "exclusiveMinimum" in spec and value <= spec["exclusiveMinimum"]:
            errors.append(f"{_path(path)}: {value} is less than or equal to the minimum of {spec['exclusiveMinimum']}")

    if "oneOf" in spec:
        matches = [sub for sub in spec["oneOf"] if not _fallback_validate(value, sub, path)]
        if len(matches) != 1:
            errors.append(f"{_path(path)}: matches {len(matches)} oneOf branches, expected 1")

    if "anyOf" in spec:
        if not any(not _fallback_validate(value, sub, path) for sub in spec["anyOf"]):
            errors.append(f"{_path(path)}: does not match any allowed shape")

    if "if" in spec and "then" in spec and not _fallback_validate(value, spec["if"], path):
        errors.extend(_fallback_validate(value, spec["then"], path))

    if isinstance(value, dict):
        props = spec.get("properties", {})
        for key in spec.get("required", []):
            if key not in value:
                errors.append(f"{_path(path)}: {key!r} is a required property")
        if spec.get("additionalProperties") is False:
            extra = sorted(set(value) - set(props))
            if extra:
                errors.append(f"{_path(path)}: additional properties are not allowed: {extra}")
        for key, sub in props.items():
            if key in value:
                child = f"{path}.{key}" if path else key
                errors.extend(_fallback_validate(value[key], sub, child))

    if isinstance(value, list):
        if "minItems" in spec and len(value) < spec["minItems"]:
            errors.append(f"{_path(path)}: has too few items")
        if "maxItems" in spec and len(value) > spec["maxItems"]:
            errors.append(f"{_path(path)}: has too many items")
        if spec.get("uniqueItems") and len({json.dumps(v, sort_keys=True) for v in value}) != len(value):
            errors.append(f"{_path(path)}: has non-unique items")

        prefix = spec.get("prefixItems")
        if prefix is not None:
            for i, sub in enumerate(prefix):
                if i < len(value):
                    errors.extend(_fallback_validate(value[i], sub, f"{path}.{i}" if path else str(i)))
            if spec.get("items") is False and len(value) > len(prefix):
                errors.append(f"{_path(path)}: has unexpected additional items")
        elif isinstance(spec.get("items"), dict):
            for i, item in enumerate(value):
                errors.extend(_fallback_validate(item, spec["items"], f"{path}.{i}" if path else str(i)))

    return errors


def validate_op(op) -> list[str]:
    """Return a list of human-readable problems (empty = valid)."""
    if not isinstance(op, dict):
        return ["op is not an object"]
    kind = op.get("kind")
    if not isinstance(kind, str) or kind not in kind_enum():
        return [f"kind: {kind!r} is not a MoshIR {IR_VERSION} op kind"]
    if jsonschema is None:
        return _fallback_validate(op, _schema_ref(kind))[:5]
    errs = sorted(_branch_validator(kind).iter_errors(op),
                  key=jsonschema.exceptions.relevance)
    out = []
    for e in errs[:5]:
        path = ".".join(str(p) for p in e.absolute_path) or "(op)"
        out.append(f"{path}: {e.message}")
    return out


def validate_ops(ops: list) -> dict:
    """Validate a sequence. Returns {valid, results: [{index, kind, errors}]}."""
    results = []
    for i, op in enumerate(ops):
        results.append({
            "index": i,
            "kind": op.get("kind") if isinstance(op, dict) else None,
            "errors": validate_op(op),
        })
    return {"valid": all(not r["errors"] for r in results), "results": results}


def extract_ops(doc) -> list:
    """Accept a bare op, an op array, or a step-shaped {ops: [...]} document."""
    if isinstance(doc, list):
        return doc
    if isinstance(doc, dict) and isinstance(doc.get("ops"), list):
        return doc["ops"]
    return [doc]


def _self_test() -> int:
    fixtures = Path(__file__).parent / "fixtures"
    fails = 0
    n = 0
    for f in sorted(fixtures.glob("valid_*.json")):
        report = validate_ops(extract_ops(json.loads(f.read_text())))
        n += len(report["results"])
        ok = report["valid"]
        print(f"  {'PASS' if ok else 'FAIL'}  {f.name} "
              f"({len(report['results'])} ops, expected valid)")
        if not ok:
            fails += 1
            for r in report["results"]:
                for e in r["errors"]:
                    print(f"        op[{r['index']}] {r['kind']}: {e}")
    for f in sorted(fixtures.glob("invalid_*.json")):
        for i, op in enumerate(extract_ops(json.loads(f.read_text()))):
            n += 1
            errors = validate_op(op)
            ok = bool(errors)
            print(f"  {'PASS' if ok else 'FAIL'}  {f.name}[{i}] (expected invalid)"
                  + (f" → {errors[0]}" if errors else ""))
            if not ok:
                fails += 1
    covered = {op.get("kind") for f in fixtures.glob("valid_*.json")
               for op in extract_ops(json.loads(f.read_text())) if isinstance(op, dict)}
    missing = [k for k in kind_enum() if k not in covered]
    if missing:
        fails += 1
        print(f"  FAIL  coverage: no valid fixture for: {', '.join(missing)}")
    else:
        print(f"  PASS  coverage: all {len(kind_enum())} op kinds have a valid fixture")
    print(f"moshir self-test: {n} checks, {'OK' if fails == 0 else f'{fails} FAILURES'}")
    return fails


def main() -> int:
    if len(sys.argv) > 1 and sys.argv[1] == "--self-test":
        return _self_test()
    if len(sys.argv) != 2:
        print(__doc__)
        return 2
    report = validate_ops(extract_ops(json.loads(Path(sys.argv[1]).read_text())))
    print(json.dumps(report, indent=2))
    return sum(1 for r in report["results"] if r["errors"])


if __name__ == "__main__":
    sys.exit(main())
