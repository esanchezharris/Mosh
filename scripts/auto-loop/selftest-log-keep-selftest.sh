#!/usr/bin/env bash
# selftest-log-keep-selftest.sh — unit test for keep_failed_selftest_log in lib.sh.
#
# The native gate runs --selftest three times and deletes each run's log. When one run (the
# known run-3-only signature: failed_max:1, nonzero_exit "r3:rc=1") failed, the gate JSON
# recorded only the tally, so the failing check's NAME was unrecoverable. The gate now copies
# a failing run's log to $AL_HOME/selftest-logs/<head12>-r<i>.log before deleting it. This
# pins: which runs are kept (rc≠0 or failed≠0, including the crashed "-1" tally), the name
# and content of the copy, that the caller's log is untouched, that a copy failure is never
# an error, and that the directory stays bounded.
#
# Pure filesystem in a private sandbox; never touches the real ~/.mosh-auto-loop.
set -euo pipefail

SELF_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
. "$SELF_DIR/lib.sh"

SANDBOX="$(mktemp -d)"
trap 'rm -rf "$SANDBOX"' EXIT
AL_HOME="$SANDBOX/home"          # the helper reads AL_HOME at call time
KEEP="$AL_HOME/selftest-logs"
SHA="0123456789abcdef0123456789abcdef01234567"

FAILED=0
ok()   { printf '  ok   %s\n' "$1"; }
fail() { printf '  FAIL %s\n' "$1"; FAILED=1; }

LOG="$SANDBOX/run.log"
printf '  FAIL [loop] loop_record names the missing audio device\n3751 checks passed, 1 failed\n' > "$LOG"

# ── a clean run keeps nothing ─────────────────────────────────────────────────────
out="$(keep_failed_selftest_log "$LOG" 0 0 "$SHA" 1)"
[ -z "$out" ] && ok "rc=0 failed=0 keeps nothing" || fail "a clean run was kept: $out"
[ ! -e "$KEEP/0123456789ab-r1.log" ] && ok "no file for a clean run" || fail "a clean run left a file"

# ── a failing check keeps the log, named by head12 and run index ──────────────────
out="$(keep_failed_selftest_log "$LOG" 0 1 "$SHA" 3)"
[ "$out" = "$KEEP/0123456789ab-r3.log" ] && ok "failed=1 is kept as <head12>-r3.log" || fail "unexpected kept path: '$out'"
cmp -s "$LOG" "$KEEP/0123456789ab-r3.log" && ok "the copy is byte-identical" || fail "the copy differs from the run log"
grep -q '^  FAIL \[loop\] loop_record' "$KEEP/0123456789ab-r3.log" && ok "the FAIL line is recoverable" || fail "FAIL line missing from the copy"
[ -f "$LOG" ] && ok "the caller's log is left for the caller to delete" || fail "the helper removed the caller's log"

# ── a non-zero exit with 0 failed checks is kept too ──────────────────────────────
out="$(keep_failed_selftest_log "$LOG" 139 0 "$SHA" 2)"
[ -n "$out" ] && [ -f "$KEEP/0123456789ab-r2.log" ] && ok "rc=139 failed=0 is kept" || fail "a crashed exit was not kept"

# ── a run that died before its summary (tally -1) is kept ─────────────────────────
rm -f "$KEEP/0123456789ab-r1.log"
out="$(keep_failed_selftest_log "$LOG" 0 -1 "$SHA" 1)"
[ -f "$KEEP/0123456789ab-r1.log" ] && ok "a missing summary (failed=-1) is kept" || fail "failed=-1 was not kept"

# ── best effort: an unusable AL_HOME is not an error ──────────────────────────────
printf 'not a directory\n' > "$SANDBOX/file-home"
if out="$(AL_HOME="$SANDBOX/file-home" keep_failed_selftest_log "$LOG" 1 1 "$SHA" 1)"; then
  [ -z "$out" ] && ok "an unwritable home returns 0 and keeps nothing" || fail "unwritable home claimed a copy: $out"
else
  fail "an unwritable home made the helper fail (would it redden the gate?)"
fi

# ── bounded: the directory never grows past the cap ───────────────────────────────
rm -rf "$KEEP"; mkdir -p "$KEEP"
for n in $(seq 1 45); do printf 'old %s\n' "$n" > "$KEEP/old-$n.log"; touch -t "2001010101.$(printf '%02d' $((n % 60)))" "$KEEP/old-$n.log"; done
keep_failed_selftest_log "$LOG" 1 1 "$SHA" 3 >/dev/null
count="$(find "$KEEP" -name '*.log' | wc -l | tr -d ' ')"
[ "$count" -le "$SELFTEST_LOG_KEEP_MAX" ] && ok "pruned to $count ≤ $SELFTEST_LOG_KEEP_MAX logs" || fail "kept $count logs (cap $SELFTEST_LOG_KEEP_MAX)"
[ -f "$KEEP/0123456789ab-r3.log" ] && ok "the newest log survives the prune" || fail "the prune deleted the log just kept"
[ -z "$(find "$SANDBOX" -path "$KEEP" -prune -o -name '*.log' -newer "$LOG" -print)" ] \
  && ok "nothing written outside the keep dir" || fail "files written outside $KEEP"

[ "$FAILED" -eq 0 ] && printf 'selftest-log-keep: all ok\n' || { printf 'selftest-log-keep: FAILED\n'; exit 1; }
