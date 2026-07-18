#!/usr/bin/env bash
# Regression guard for SLF-CONC-001: `Mosh --selftest` must be hermetic against a
# CONCURRENT selftest on the same host.
#
# Before the fix, every headless mode used a FIXED session leaf (~/Library/Mosh/
# session-selftest) that MoshEngine wipes with deleteRecursively() at startup, so two
# concurrent runs deleted each other's exports / saved edit / mosh-log.jsonl mid-test.
# Observed: 6 and 2 failures across the export/save/command-log sections, and even the
# TOTAL check count varied between runs (failures short-circuit nested sub-blocks), so a
# raced run was not even comparable to the baseline.
#
# This runs two PLAIN selftests at once -- deliberately WITHOUT MOSH_SELFTEST_SESSION,
# because callers that pass it were never the broken case. Both must report the same
# total and zero failures.
#
# Usage: scripts/selftest-concurrency-check.sh [path/to/Mosh]
set -uo pipefail

BIN="${1:-build-app/Mosh_artefacts/Release/Mosh.app/Contents/MacOS/Mosh}"
if [[ ! -x "$BIN" ]]; then
    echo "FAIL: no Mosh binary at $BIN" >&2
    exit 2
fi

OUT="$(mktemp -d)"
trap 'rm -rf "$OUT"' EXIT

echo "== launching 2 concurrent plain --selftest runs =="
MOSH_NO_AUDIO=1 "$BIN" --selftest >"$OUT/a.log" 2>&1 & PA=$!
MOSH_NO_AUDIO=1 "$BIN" --selftest >"$OUT/b.log" 2>&1 & PB=$!
wait $PA; RA=$?
wait $PB; RB=$?

summarize() {  # -> "<passed> <total> <failed>"
    sed -n 's/.*===== \([0-9]*\)\/\([0-9]*\) checks passed, \([0-9]*\) failed =====.*/\1 \2 \3/p' "$1" | tail -1
}

SA="$(summarize "$OUT/a.log")"
SB="$(summarize "$OUT/b.log")"
DA="$(sed -n 's/^session dir: //p' "$OUT/a.log" | tail -1)"
DB="$(sed -n 's/^session dir: //p' "$OUT/b.log" | tail -1)"

echo "run A: exit=$RA  [$SA]  $DA"
echo "run B: exit=$RB  [$SB]  $DB"

fail() { echo "FAIL: $1" >&2; echo "--- A ---"; grep -E '^\s*FAIL' "$OUT/a.log" | head -20 >&2
         echo "--- B ---"; grep -E '^\s*FAIL' "$OUT/b.log" | head -20 >&2; exit 1; }

[[ -n "$SA" && -n "$SB" ]]        || fail "a run produced no summary line (crash? see logs)"
[[ $RA -eq 0 && $RB -eq 0 ]]      || fail "a concurrent run exited non-zero (A=$RA B=$RB)"
[[ "$(awk '{print $3}' <<<"$SA")" == "0" ]] || fail "run A reported failures"
[[ "$(awk '{print $3}' <<<"$SB")" == "0" ]] || fail "run B reported failures"

TA="$(awk '{print $2}' <<<"$SA")"; TB="$(awk '{print $2}' <<<"$SB")"
[[ "$TA" == "$TB" ]] || fail "check TOTALS differ between concurrent runs ($TA vs $TB) -- short-circuited sections"

# The isolation itself: two concurrent runs must not share a session dir.
[[ -n "$DA" && -n "$DB" ]] || fail "a run did not report its session dir"
[[ "$DA" != "$DB" ]]       || fail "both runs used the SAME session dir ($DA) -- not isolated"

echo "PASS: $TA/$TA checks in both concurrent runs, 0 failed, isolated session dirs"
