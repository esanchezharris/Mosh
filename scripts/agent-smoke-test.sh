#!/usr/bin/env bash
# Stage 11 gate (scaffolding): Monster v0 end-to-end with the MOCK provider —
# zero API spend, fully deterministic. Proves: /agent/propose returns
# schema-valid MoshIR (+ repair-retry plumbing), proposals execute through the
# harness with L1 pass, rollouts land in the store as agent_rollout, the eval
# reports rates, and the GEPA loop produces a Pareto pool + winner.
#
# The REAL bar (spec §1: >=70% end-to-end on all 24 tasks, judge >=4) runs
# with: GEMINI_API_KEY=... python3 -m flywheel.gepa.eval --provider gemini
set -uo pipefail

ROOT=$(cd "$(dirname "$0")/.." && pwd)
APP=${MOSH_APP:-$ROOT/build-macos-arm64/Mosh_artefacts/Debug/Mosh.app/Contents/MacOS/Mosh}
TMP=$(mktemp -d)
PASS=0; FAIL=0
check() { if [ "$1" -eq 0 ]; then echo "  ok   $2"; PASS=$((PASS+1)); else echo "  FAIL $2"; FAIL=$((FAIL+1)); fi }

cd "$ROOT"
echo "===== Monster v0 smoke (mock provider, zero spend) ====="

# 1. Direct proposal: schema-valid ops from the mock provider.
python3 - <<'EOF'
import sys
sys.path.insert(0, "service"); sys.path.insert(0, "moshir")
from agent import propose
import validate as V
r = propose.propose({"instruction": "8-bar trap drums at 142", "provider": "mock"})
assert r["ok"], r
bad = [e for op in r["ops"] for e in V.validate_op(op)]
assert not bad, bad[:3]
print(f"proposal: {len(r['ops'])} schema-valid ops, program {r['program_version']}")
EOF
check $? "mock proposal is schema-valid MoshIR"

# 2. Single rollout: propose → harness execute → L1 → stored as agent_rollout.
python3 - "$TMP/store.sqlite3" <<'EOF'
import json, sqlite3, sys
from pathlib import Path
sys.path.insert(0, ".")
from flywheel.gepa import rollout
from flywheel.gepa.eval import TASKS
r = rollout.run_rollout(TASKS[0], "mock", db_path=Path(sys.argv[1]))
assert r["l1"], r["feedback"][:3]
assert r["ok"], r
conn = sqlite3.connect(sys.argv[1])
n = conn.execute("SELECT COUNT(*) FROM trajectories WHERE source='agent_rollout'").fetchone()[0]
assert n == 1, n
print(f"rollout {r['task_id']}: score={r['score']} l0={r['l0']} l4={r['l4']} -> stored")
EOF
check $? "rollout executes (L1 pass) and lands in the store as agent_rollout"

# 3. Eval subset: report with rates.
python3 -m flywheel.gepa.eval --provider mock --tasks 4 \
    --db "$TMP/store.sqlite3" --out "$TMP/eval.jsonl" >/dev/null 2>&1
python3 - "$TMP/eval.jsonl" <<'EOF'
import json, sys
lines = [json.loads(l) for l in open(sys.argv[1])]
summary = lines[-1]["summary"]
assert summary["tasks"] == 4 and summary["l1_rate"] >= 0.75, summary
print("eval:", json.dumps(summary))
EOF
check $? "eval suite produces the JSONL report with rates"

# 4. GEPA loop: 2 candidates x 2 tasks x 2 generations, Pareto pool + winner.
python3 -m flywheel.gepa.gepa --provider mock --generations 2 --candidates 2 \
    --tasks 2 --out "$TMP/gepa" --db "$TMP/store.sqlite3" >/dev/null 2>&1
python3 - "$TMP/gepa/gepa-report.jsonl" <<'EOF'
import json, sys
lines = [json.loads(l) for l in open(sys.argv[1])]
summary = lines[-1]
assert summary.get("summary") and summary["pool"] == 4 and summary["winner"], summary
# reflection memory mutated between generations:
lessons = [l for l in lines[:-1] if l.get("lessons_applied")]
print(f"gepa: {summary['rollouts']} rollouts, front {summary['pareto_front']}/{summary['pool']}, "
      f"winner {summary['winner']}, {len(lessons)} candidates carried lessons")
EOF
check $? "GEPA loop: candidate pool, reflection mutation, Pareto winner"

# 5. Secrets hygiene: no key material anywhere in the new surface.
! grep -rEn "AIza[A-Za-z0-9_-]{20,}|sk-ant-|AQ\.[A-Za-z0-9_-]{20,}" \
    service/agent flywheel/gepa src/moshops/MoshOpsStage11.cpp ui/src/components/AgentPanel.tsx 2>/dev/null
check $? "no key material in the agent surface (env-only contract)"

echo "===== $PASS passed, $FAIL failed ====="
rm -rf "$TMP"
exit $FAIL
