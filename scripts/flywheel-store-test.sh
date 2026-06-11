#!/usr/bin/env bash
# Trajectory-store end-to-end (phase0 §5): a harness run records a session →
# the importer enforces the consent gate → consented import lands rows +
# content-addressed objects → export reproduces the spec §5 record shape.
set -uo pipefail

ROOT=$(cd "$(dirname "$0")/.." && pwd)
APP=${MOSH_APP:-$ROOT/build-macos-arm64/Mosh_artefacts/Debug/Mosh.app/Contents/MacOS/Mosh}
TMP=$(mktemp -d)
PASS=0; FAIL=0
check() { if [ "$1" -eq 0 ]; then echo "  ok   $2"; PASS=$((PASS+1)); else echo "  FAIL $2"; FAIL=$((FAIL+1)); fi }

echo "===== flywheel store end-to-end ====="

# 1. Record a session via the harness (recorder is always on).
D=$TMP/sess
MOSH_SESSION_DIR=$D MOSH_GAP_LEDGER=$D/gap.jsonl \
  "$APP" --harness "$ROOT/moshir/fixtures/harness_job_conformance.json" \
  --harness-out "$TMP/result.json" >/dev/null 2>&1
check $? "harness run recorded a session"
[ -s "$D/trajectory.jsonl" ]; check $? "trajectory.jsonl written"

# 2. Consent gate: default identity is consent=false → import REFUSES.
python3 -m flywheel.store.import_session "$D" --db "$TMP/store.sqlite3" >/dev/null 2>&1
[ $? -ne 0 ]; check $? "import without consent is REFUSED (opt-in contract)"

# 3. Consented session: pre-seed an identity with consent=true and re-record.
D2=$TMP/sess2
mkdir -p "$D2"
echo '{"name": "Store Test", "uuid": "test-uuid-1234", "consent": true}' > "$TMP/identity.json"
MOSH_SESSION_DIR=$D2 MOSH_GAP_LEDGER=$D2/gap.jsonl MOSH_IDENTITY_FILE=$TMP/identity.json \
  "$APP" --harness "$ROOT/moshir/fixtures/harness_job_conformance.json" \
  --harness-out "$TMP/result2.json" >/dev/null 2>&1
check $? "consented harness run recorded"

cd "$ROOT"
OUT=$(python3 -m flywheel.store.import_session "$D2" --db "$TMP/store.sqlite3" \
        --instruction "conformance fixture beat" --source tutorial_replication 2>&1)
check $? "consented import accepted"
echo "$OUT" | grep -q "consent=True"; check $? "import reports consent=True"

# 4. Rows + objects landed.
python3 - "$TMP/store.sqlite3" <<'EOF'
import sqlite3, sys
conn = sqlite3.connect(sys.argv[1])
t = conn.execute("SELECT COUNT(*) FROM trajectories").fetchone()[0]
s = conn.execute("SELECT COUNT(*) FROM steps").fetchone()[0]
o = conn.execute("SELECT COUNT(*) FROM objects").fetchone()[0]
ir = conn.execute("SELECT COUNT(*) FROM steps WHERE ir IS NOT NULL").fetchone()[0]
h = conn.execute("SELECT COUNT(*) FROM steps WHERE state_hash_after IS NOT NULL").fetchone()[0]
assert t == 1, f"trajectories {t}"
assert s >= 2, f"steps {s}"
assert o >= 1, f"objects {o}"        # the generated latent asset + bounce
assert ir >= 1, f"steps with IR {ir}"
assert h >= 1, f"steps with state_hash {h}"
print(f"rows: {t} traj, {s} steps ({ir} with IR, {h} hashed), {o} objects")
EOF
check $? "store rows + content-addressed objects landed"

# 5. Export reproduces the spec record shape and the ops validate.
python3 -m flywheel.store.export_jsonl --db "$TMP/store.sqlite3" > "$TMP/export.jsonl"
python3 - "$TMP/export.jsonl" "$ROOT" <<'EOF'
import json, sys
sys.path.insert(0, sys.argv[2] + "/moshir")
import validate as V
rec = json.loads(open(sys.argv[1]).read().splitlines()[0])
assert rec["ir_version"] == "0.3" and rec["source"] == "tutorial_replication"
assert rec["instruction"] == "conformance fixture beat"
assert rec["provenance"]["consent"] is True
ops = [op for st in rec["steps"] for op in st["ops"]]
assert ops, "no IR ops in export"
bad = [e for op in ops for e in V.validate_op(op)]
assert not bad, bad[:3]
print(f"export ok: {len(rec['steps'])} steps, {len(ops)} IR ops all schema-valid")
EOF
check $? "export matches spec record shape; all IR ops schema-valid"

# 6. Replay the stored trajectory through a fresh harness run → identical hash.
TRAJ=$(python3 - "$TMP/store.sqlite3" <<'EOF'
import sqlite3, sys
print(sqlite3.connect(sys.argv[1]).execute("SELECT traj_id FROM trajectories").fetchone()[0])
EOF
)
python3 -m flywheel.store.replay_check "$TRAJ" --db "$TMP/store.sqlite3" --app "$APP" --strict
check $? "stored trajectory replays to the RECORDED state_hash (loop closed)"

echo "===== $PASS passed, $FAIL failed ====="
rm -rf "$TMP"
exit $FAIL
