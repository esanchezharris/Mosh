#!/usr/bin/env bash
# Stage 10 gate: git-style ASYNC session sync ("like GitHub", NOT real-time).
#
#   A creates a session & shares it  → B clones → identical state_hash
#   B edits & pushes → A pulls (fast-forward) → converge
#   concurrent: A edits (pending) while B pushed → A push REJECTED →
#     A pull = rebase (replay remote, re-execute pending) → push → B pulls → converge
#   conflict: B deletes a track A is renaming → A's pull surfaces the conflict,
#     session stays consistent, both converge
#
# Each app invocation is one harness run continuing a persistent session
# (MOSH_KEEP_SESSION=1). Run from the repo root.
set -uo pipefail

ROOT=$(cd "$(dirname "$0")/.." && pwd)
APP=${MOSH_APP:-$ROOT/build-macos-arm64/Mosh_artefacts/Debug/Mosh.app/Contents/MacOS/Mosh}
TMP=$(mktemp -d)
PASS=0; FAIL=0
check() { if [ "$1" -eq 0 ]; then echo "  ok   $2"; PASS=$((PASS+1)); else echo "  FAIL $2"; FAIL=$((FAIL+1)); fi }
field() { python3 -c "import json,sys;d=json.load(open('$1'));print(eval('d'+sys.argv[1]))" "$2" 2>/dev/null; }

run() {  # run <who:A|B> <job-json> <result-name>
  local who=$1 job=$2 out=$3
  echo "$job" > "$TMP/$out.job.json"
  MOSH_SESSION_DIR=$TMP/$who MOSH_KEEP_SESSION=1 \
    MOSH_IDENTITY_FILE=$TMP/identity-$who.json MOSH_GAP_LEDGER=$TMP/$who-gap.jsonl \
    "$APP" --harness "$TMP/$out.job.json" --harness-out "$TMP/$out.json" >/dev/null 2>&1
}

lastCmdHash() { field "$TMP/$1.json" "['commandResults'][-1]['data']['state_hash']"; }

REMOTE=$TMP/remote.git
git init --bare -q "$REMOTE"
echo '{"name": "Alice", "uuid": "alice-uuid-0001", "consent": true}' > "$TMP/identity-A.json"
echo '{"name": "Bob",   "uuid": "bob-uuid-0002",   "consent": true}' > "$TMP/identity-B.json"

echo "===== collab sync gate (git-style, async) ====="

# ── 1. A builds a beat and shares it ──
run A "{\"ops\": [
  {\"kind\": \"project.set_tempo\", \"params\": {\"bpm\": 140}},
  {\"kind\": \"track.create\", \"params\": {\"track_id\": \"t1\", \"kind\": \"midi\", \"role\": \"melody\"}},
  {\"kind\": \"clip.create\", \"params\": {\"clip_id\": \"c1\", \"track_id\": \"t1\", \"start_bar\": 1, \"length_beats\": 8, \"kind\": \"midi\"}},
  {\"kind\": \"notes.add\", \"params\": {\"clip_id\": \"c1\", \"notes\": [
    {\"pitch\": \"C3\", \"start_beats\": 0, \"dur_beats\": 1, \"vel\": 100}]}}
 ],
 \"commands\": [
  {\"command\": \"collab_init\", \"args\": {\"remote\": \"$REMOTE\"}},
  {\"command\": \"collab_status\", \"args\": {}}
 ]}" a1
check $? "A: session built + collab_init + first push"
HA=$(lastCmdHash a1)
[ -n "$HA" ]; check $? "A: state_hash reported ($HA)"

# ── 2. B clones → identical hash ──
run B "{\"commands\": [
  {\"command\": \"collab_clone\", \"args\": {\"remote\": \"$REMOTE\"}}
 ]}" b1
check $? "B: collab_clone ran"
HB=$(field "$TMP/b1.json" "['commandResults'][0]['data']['state_hash']")
[ -n "$HB" ] && [ "$HB" = "$HA" ]; check $? "B's clone replays to A's EXACT state_hash"
[ "$(field "$TMP/b1.json" "['commandResults'][0]['data']['conflicts']")" = "[]" ]
check $? "B: clone replay had zero conflicts"

# ── 3. B edits + pushes; A pulls (fast-forward) → converge ──
run B "{\"ops\": [
  {\"kind\": \"track.create\", \"params\": {\"track_id\": \"t2\", \"kind\": \"audio\", \"role\": \"drums\"}},
  {\"kind\": \"mixer.set_gain\", \"params\": {\"track_id\": \"t2\", \"db\": -4}}
 ],
 \"commands\": [{\"command\": \"collab_push\", \"args\": {}}]}" b2
check $? "B: edit + push"
HB2=$(lastCmdHash b2)
run A "{\"commands\": [{\"command\": \"collab_pull\", \"args\": {}}]}" a2
check $? "A: pull ran"
HA2=$(field "$TMP/a2.json" "['commandResults'][0]['data']['state_hash']")
[ -n "$HA2" ] && [ "$HA2" = "$HB2" ]; check $? "A converged to B's hash after fast-forward pull"

# ── 4. Concurrent edits: push rejected → pull rebases → converge ──
run B "{\"ops\": [
  {\"kind\": \"track.create\", \"params\": {\"track_id\": \"t3\", \"kind\": \"audio\", \"role\": \"fx\"}}
 ],
 \"commands\": [{\"command\": \"collab_push\", \"args\": {}}]}" b3
check $? "B: concurrent edit pushed first"
# A edits WITHOUT pulling (pending work), then tries to push → must be rejected.
run A "{\"ops\": [
  {\"kind\": \"notes.add\", \"params\": {\"clip_id\": \"c1\", \"notes\": [
    {\"pitch\": \"G3\", \"start_beats\": 4, \"dur_beats\": 1, \"vel\": 90}]}}
 ],
 \"commands\": [{\"command\": \"collab_push\", \"args\": {}}]}" a3
RC=$?
[ $RC -ne 0 ] && grep -q "collab_pull first" "$TMP/a3.json"
check $? "A: behind push REJECTED (linear history, like git)"
run A "{\"commands\": [
  {\"command\": \"collab_pull\", \"args\": {}},
  {\"command\": \"collab_push\", \"args\": {}}
 ]}" a4
check $? "A: pull (rebase: replay remote + re-execute pending) + push"
HA4=$(lastCmdHash a4)
run B "{\"commands\": [{\"command\": \"collab_pull\", \"args\": {}}]}" b4
HB4=$(field "$TMP/b4.json" "['commandResults'][0]['data']['state_hash']")
[ -n "$HA4" ] && [ "$HA4" = "$HB4" ]; check $? "concurrent edits CONVERGE after rebase ($HA4)"

# ── 5. Conflict: B deletes the track A is concurrently renaming ──
# Symbolic ids work across peers: execute_ir entries replay through each
# peer's OWN executor, so 't2' is bound everywhere the log has been applied.
run B "{\"ops\": [
  {\"kind\": \"track.delete\", \"params\": {\"track_id\": \"t2\"}}
 ],
 \"commands\": [{\"command\": \"collab_push\", \"args\": {}}]}" b5
check $? "B: deleted t2 + pushed"
# A (not yet pulled) renames t2 — fine locally, doomed on rebase.
run A "{\"ops\": [
  {\"kind\": \"track.rename\", \"params\": {\"track_id\": \"t2\", \"name\": \"A was here\"}}
 ]}" a5
check $? "A: pending rename of t2 (locally fine)"
run A "{\"commands\": [
  {\"command\": \"collab_pull\", \"args\": {}},
  {\"command\": \"collab_push\", \"args\": {}}
 ]}" a6
check $? "A: pull (rebase) + push despite the conflict"
NCONF=$(field "$TMP/a6.json" "['commandResults'][0]['data']['conflicts'].__len__()")
[ -n "$NCONF" ] && [ "$NCONF" -ge 1 ]
check $? "A: the doomed rename SURFACED as a conflict (never silent)"
HA6=$(lastCmdHash a6)
run B "{\"commands\": [{\"command\": \"collab_pull\", \"args\": {}}]}" b6
HB6=$(field "$TMP/b6.json" "['commandResults'][0]['data']['state_hash']")
[ -n "$HA6" ] && [ "$HA6" = "$HB6" ]; check $? "post-conflict states converge ($HA6)"
# The dead op must NOT have been pushed: no peer should ever replay it.
! grep -q "A was here" "$TMP/B/collab/oplog.jsonl"
check $? "conflicted op was DROPPED from the shared log (dead ops never pushed)"

echo "===== $PASS passed, $FAIL failed ====="
rm -rf "$TMP"
exit $FAIL
