#!/usr/bin/env bash
# Harness conformance suite (phase0 §4, hard requirements 1–5).
#
#   1. Determinism: identical (state, ops, seed) → identical state_hash and
#      byte-identical bounce — replayed 3×, including a SEEDED LATENT OP.
#   2. Canonical serialization is what makes #1 meaningful (src/state/StateHash).
#   3. Unseeded-stochastic rejection: hard error, not a default seed.
#   4. Batch mode: parallel app instances, isolated MOSH_SESSION_DIRs, no hang.
#   5. Gap-ledger emission: Unsupported ops append to the ledger.
#
# Run from the repo root:  scripts/harness-conformance.sh
set -uo pipefail

ROOT=$(cd "$(dirname "$0")/.." && pwd)
APP=${MOSH_APP:-$ROOT/build-macos-arm64/Mosh_artefacts/Debug/Mosh.app/Contents/MacOS/Mosh}
FIX=$ROOT/moshir/fixtures
TMP=$(mktemp -d)
PASS=0; FAIL=0

check() {  # check <ok:0|1> <label>
  if [ "$1" -eq 0 ]; then echo "  ok   $2"; PASS=$((PASS+1));
  else echo "  FAIL $2"; FAIL=$((FAIL+1)); fi
}

field() { python3 -c "import json,sys;d=json.load(open('$1'));print(eval('d'+sys.argv[1]))" "$2" 2>/dev/null; }

echo "===== Mosh harness conformance (phase0 s4) ====="

# ── 1+2: replay determinism, 3×, seeded latent op + bounce ──
HASHES=(); BOUNCES=()
for i in 1 2 3; do
  D=$TMP/replay$i; mkdir -p "$D"
  MOSH_SESSION_DIR=$D/sess MOSH_GAP_LEDGER=$D/gap.jsonl \
    "$APP" --harness "$FIX/harness_job_conformance.json" --harness-out "$D/result.json" \
    >/dev/null 2>&1
  RC=$?
  check $RC "replay $i ran (exit $RC)"
  HASHES+=("$(field "$D/result.json" "['state_hash']")")
  # audio_md5 = fmt+data chunks; the container's BWAV bext chunk carries an
  # engine-stamped wall-clock, so whole-file md5 is documented as non-replayable.
  BOUNCES+=("$(field "$D/result.json" "['bounce']['audio_md5']")")
done
echo "       state_hash: ${HASHES[0]}"
[ -n "${HASHES[0]}" ] && [ "${HASHES[0]}" = "${HASHES[1]}" ] && [ "${HASHES[1]}" = "${HASHES[2]}" ]
check $? "3x identical state_hash (incl. seeded latent.generate)"
[ -n "${BOUNCES[0]}" ] && [ "${BOUNCES[0]}" = "${BOUNCES[1]}" ] && [ "${BOUNCES[1]}" = "${BOUNCES[2]}" ]
check $? "3x byte-identical bounce (md5 ${BOUNCES[0]})"

# ── 3: unseeded stochastic ops are hard-rejected ──
D=$TMP/unseeded; mkdir -p "$D"
MOSH_SESSION_DIR=$D/sess MOSH_GAP_LEDGER=$D/gap.jsonl \
  "$APP" --harness "$FIX/harness_job_unseeded.json" --harness-out "$D/result.json" \
  >/dev/null 2>&1
RC=$?
[ $RC -eq 1 ]; check $? "unseeded humanize -> exit 1 (got $RC, no default seed)"
[ "$(field "$D/result.json" "['counts']['failed']")" = "1" ]
check $? "unseeded op reported as a validate failure"

# ── 5: gap-ledger emission ──
D=$TMP/gap; mkdir -p "$D"
MOSH_SESSION_DIR=$D/sess MOSH_GAP_LEDGER=$D/gap.jsonl \
  "$APP" --harness "$FIX/harness_job_gap.json" --harness-out "$D/result.json" \
  >/dev/null 2>&1
check $? "gap fixture ran (Unsupported is a finding, exit 0)"
grep -q "project.set_swing" "$D/gap.jsonl" 2>/dev/null
check $? "gap ledger received the Unsupported entry"

# ── 4: batch mode — two parallel instances, isolated sessions, no hang ──
D1=$TMP/batch1; D2=$TMP/batch2; mkdir -p "$D1" "$D2"
MOSH_SESSION_DIR=$D1/sess MOSH_GAP_LEDGER=$D1/gap.jsonl \
  "$APP" --harness "$FIX/harness_job_conformance.json" --harness-out "$D1/result.json" >/dev/null 2>&1 &
P1=$!
MOSH_SESSION_DIR=$D2/sess MOSH_GAP_LEDGER=$D2/gap.jsonl \
  "$APP" --harness "$FIX/harness_job_conformance.json" --harness-out "$D2/result.json" >/dev/null 2>&1 &
P2=$!
wait $P1; R1=$?; wait $P2; R2=$?
[ $R1 -eq 0 ] && [ $R2 -eq 0 ]
check $? "parallel batch: both instances completed (exits $R1/$R2)"
B1=$(field "$D1/result.json" "['state_hash']"); B2=$(field "$D2/result.json" "['state_hash']")
[ -n "$B1" ] && [ "$B1" = "$B2" ] && [ "$B1" = "${HASHES[0]}" ]
check $? "parallel batch: hashes match the serial runs"

echo "===== $PASS passed, $FAIL failed ====="
rm -rf "$TMP"
exit $FAIL
