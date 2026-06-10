#!/usr/bin/env bash
# Stage 12 gate (scaffolding): extraction v0 end-to-end on the fixture
# tutorial with the mock provider — deterministic, zero spend. Proves:
# segmentation, per-step inference w/ validation, one-shot harness replay
# (L0/L1 + projection), typed-claims diff (L2), the graded accept policy
# (gold path + the L2-miss → silver fallback + the reject path), provenance
# in the store. Real ASR/VLM run when mlx-whisper / a provider key exist.
set -uo pipefail

ROOT=$(cd "$(dirname "$0")/.." && pwd)
TMP=$(mktemp -d)
PASS=0; FAIL=0
check() { if [ "$1" -eq 0 ]; then echo "  ok   $2"; PASS=$((PASS+1)); else echo "  FAIL $2"; FAIL=$((FAIL+1)); fi }

cd "$ROOT"
echo "===== extraction v0 smoke (fixture tutorial, mock provider) ====="

# 1. Full pipeline → gold.
OUT=$(python3 -m flywheel.extract.pipeline --fixture flywheel/extract/fixtures/trap140 \
        --provider mock --db "$TMP/store.sqlite3" 2>&1)
check $? "pipeline ran and accepted"
LAST=$(echo "$OUT" | tail -1)
python3 -c "
import json, sys
r = json.loads(sys.argv[1])
assert r['steps'] == 3 and r['unextracted'] == 0, r
assert r['l0'] == 1.0 and r['l1'] is True, r
assert r['l2'] == 1.0, r                       # all typed claims verified
assert r['grade'] == 'gold' and r['accepted'], r
print(f\"gold path: {r['ops']} ops, L2={r['l2']}, L4={r['l4']}\")
" "$LAST"
check $? "rich visible state -> GOLD (L2 = 1.0 against the projection)"

# 2. The trajectory is in the store with mandatory provenance + markers.
python3 - "$TMP/store.sqlite3" <<'EOF'
import json, sqlite3, sys
conn = sqlite3.connect(sys.argv[1])
row = conn.execute("SELECT source, grade, provenance FROM trajectories").fetchone()
assert row[0] == "tutorial_replication" and row[1] == "gold", row
prov = json.loads(row[2])
assert prov.get("accessed_at") and prov.get("license_notes"), prov
m = conn.execute("SELECT COUNT(*) FROM markers").fetchone()[0]
assert m == 3, m
print(f"stored: source={row[0]} grade={row[1]} markers={m} provenance complete")
EOF
check $? "stored with mandatory provenance + narration markers"

# 3. Accept-policy unit paths: L2 miss -> silver (L4 relaxation), bad L0 -> reject.
python3 - <<'EOF'
import sys
sys.path.insert(0, ".")
from flywheel.extract import verify
l3 = verify.l3_score()
silver = verify.grade(1.0, True, {"score": 0.4, "misses": ["bpm=999"]}, l3, 4.5)
assert silver["grade"] == "silver" and any("relaxation" in n for n in silver["policy_notes"]), silver
bronze = verify.grade(0.9, True, {"score": None}, l3, 2.0)
assert bronze["grade"] == "bronze", bronze
reject = verify.grade(0.5, True, {"score": 1.0}, l3, 5.0)
assert reject["accepted"] is False, reject
claims = verify.l2_score(
    [{"kind": "bpm", "value": 999}],
    '{"tempo": 140.0, "tracks": [], "sections": []}')
assert claims["score"] == 0.0 and claims["misses"], claims
print("policy: gold/silver(relaxed)/bronze/reject all route correctly; L2 catches wrong claims")
EOF
check $? "accept policy: silver relaxation + bronze + reject + L2 miss detection"

# 4. Unextracted steps degrade, never crash: a fixture step with no ops.
python3 - "$TMP" <<'EOF'
import json, shutil, subprocess, sys
from pathlib import Path
src, dst = Path("flywheel/extract/fixtures/trap140"), Path(sys.argv[1]) / "fx"
shutil.copytree(src, dst)
# Knock out the FINAL step (the mix): a hole that later steps depend on
# would correctly fail L1 and reject — a trailing hole is the recoverable case.
steps = json.loads((dst / "steps.json").read_text())
steps[2] = None
(dst / "steps.json").write_text(json.dumps(steps))
p = subprocess.run([sys.executable, "-m", "flywheel.extract.pipeline",
                    "--fixture", str(dst), "--provider", "mock",
                    "--db", sys.argv[1] + "/store2.sqlite3"],
                   capture_output=True, text=True)
r = json.loads(p.stdout.strip().splitlines()[-1])
assert r["unextracted"] == 1 and r["accepted"], r   # gaps recorded, still graded
print(f"gapped tutorial: unextracted={r['unextracted']}, still graded {r['grade']}")
EOF
check $? "unextracted step -> gap recorded, trajectory still graded (never a crash)"

echo "===== $PASS passed, $FAIL failed ====="
rm -rf "$TMP"
exit $FAIL
