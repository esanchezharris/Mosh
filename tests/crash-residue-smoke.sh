#!/usr/bin/env bash
# CAP-001 — crash mid-take, relaunch, recover the take. Nobody at the mic.
#
# Run 1: `--record-hold-smoke` arms a track on a loopback input (BlackHole 2ch), starts
#        recording, announces itself, and holds. This script SIGKILLs it a few seconds in —
#        exactly the failure the feature exists for.
# Run 2: a headless `--run-script` on the SAME session dir reopens the project and must see
#        recoveryAvailable plus the orphan take in recordingResidue.
# Run 3: adopts it and must see a clip marked recovered, with real length, on the Vox track.
#
# Usage: tests/crash-residue-smoke.sh /path/to/Mosh.app/Contents/MacOS/Mosh [device]
set -euo pipefail
app="${1:?usage: crash-residue-smoke.sh /path/to/Mosh [device-name]}"
device="${2:-BlackHole 2ch}"
if ! system_profiler SPAudioDataType 2>/dev/null | grep -Fq "$device"; then
  printf 'crash-residue-smoke: audio device "%s" not present (install BlackHole)\n' "$device" >&2
  exit 2
fi
scratch="$(mktemp -d /private/tmp/mosh-crash-residue.XXXXXX)"
keep=0
cleanup() {
  if [ "$keep" = 1 ] || [ "${MOSH_CRASH_SMOKE_KEEP:-0}" = 1 ]; then
    printf 'crash-residue-smoke: scratch kept at %s\n' "$scratch" >&2
    find "$scratch/mosh" -type f \( -name '*.wav' -o -name '*.mosh' -o -name 'session.running' \) 2>/dev/null >&2
    for f in "$scratch"/out*.jsonl; do [ -f "$f" ] && { printf -- '--- %s ---\n' "$f" >&2; cut -c1-600 "$f" >&2; }; done
    return
  fi
  /bin/rm -rf -- "$scratch"
}
trap cleanup EXIT
fail() { keep=1; printf 'crash-residue-smoke: FAIL %s\n' "$1" >&2; exit 1; }
mosh_dir="$scratch/mosh"; mkdir -m 700 "$mosh_dir"
session="_harness/crash-residue-$$-$RANDOM"
common=(env MOSH_ENABLE_TEST_MOSH_DIR=1 MOSH_TEST_MOSH_DIR="$mosh_dir" MOSH_SELFTEST_SESSION="$session")
log1="$scratch/run1.log"

# ── run 1: record, then die ──
"${common[@]}" MOSH_AUDIO_OUTPUT_DEVICE="$device" MOSH_AUDIO_INPUT_DEVICE="$device" \
  "$app" --record-hold-smoke -ApplePersistenceIgnoreState YES > "$log1" 2>&1 &
pid=$!
for _ in $(seq 1 120); do
  grep -q "RECORD-HOLD: recording" "$log1" 2>/dev/null && break
  kill -0 "$pid" 2>/dev/null || break
  sleep 0.5
done
if ! grep -q "RECORD-HOLD: recording" "$log1"; then
  printf -- '--- run 1 output ---\n' >&2; cat "$log1" >&2; fail "run 1 never reached recording"
fi
edit_file="$(sed -n 's/.*editFile=\(.*\) sessionDir=.*/\1/p' "$log1" | head -1)"
sleep 4            # a few seconds of take on disk
kill -9 "$pid"; wait "$pid" 2>/dev/null || true
printf 'crash-residue-smoke: killed run 1 (pid %s) mid-take; edit=%s\n' "$pid" "$edit_file"

# ── run 2: relaunch headless on the same session, list residue ──
cat > "$scratch/run2.jsonl" <<EOF
{"command":"open_project","args":{"file":"$edit_file"}}
{"command":"list_recording_residue","args":{}}
{"command":"__snapshot","args":{}}
EOF
"${common[@]}" MOSH_NO_AUDIO=1 MOSH_RUNSCRIPT_KEEP_SESSION=1 MOSH_RUN_SCRIPT="$scratch/run2.jsonl" MOSH_RUN_SCRIPT_OUT="$scratch/out2.jsonl" \
  "$app" --run-script -ApplePersistenceIgnoreState YES > "$scratch/run2.log" 2>&1 || true
residue_file="$(python3 - "$scratch/out2.jsonl" <<'PY'
import json, sys
rows=[json.loads(l) for l in open(sys.argv[1]) if l.strip()]
listed=[r for r in rows if r.get("command")=="list_recording_residue"][0]
res=listed["data"]["residue"]
snap=[r for r in rows if r.get("command")=="__snapshot"][0]["data"]
sess=snap["session"]
assert sess.get("recoveryAvailable") is True, "relaunch did not read as unclean"
assert isinstance(sess.get("recordingResidue"), list) and len(sess["recordingResidue"])>=1, "snapshot carries no residue after the crash"
assert len(res)>=1, "list_recording_residue is empty after the crash"
top=res[0]
# JUCE writes the WAV sizes only on close, so a killed take is never directly readable;
# the scan must see through that (repairable) and still decide "adopt".
assert top["decision"]=="adopt", f"the crashed take is not adoptable: {top}"
assert top["readable"] is True or top["repairable"] is True, f"neither readable nor repairable: {top}"
assert top["seconds"]>=2.0, f"the crashed take is shorter than expected: {top['seconds']}"
print(top["file"])
PY
)" || fail "run 2 did not offer the crashed take"
printf 'crash-residue-smoke: residue offered: %s\n' "$residue_file"

# ── run 3: adopt it ──
cat > "$scratch/run3.jsonl" <<EOF
{"command":"open_project","args":{"file":"$edit_file"}}
{"command":"adopt_recording_residue","args":{"file":"$residue_file"}}
{"command":"__snapshot","args":{}}
EOF
"${common[@]}" MOSH_NO_AUDIO=1 MOSH_RUNSCRIPT_KEEP_SESSION=1 MOSH_RUN_SCRIPT="$scratch/run3.jsonl" MOSH_RUN_SCRIPT_OUT="$scratch/out3.jsonl" \
  "$app" --run-script -ApplePersistenceIgnoreState YES > "$scratch/run3.log" 2>&1 || true
python3 - "$scratch/out3.jsonl" <<'PY' || fail "run 3 did not adopt the take"
import json, sys
rows=[json.loads(l) for l in open(sys.argv[1]) if l.strip()]
ad=[r for r in rows if r.get("command")=="adopt_recording_residue"][0]
assert ad.get("ok") is True, f"adopt failed: {ad}"
snap=[r for r in rows if r.get("command")=="__snapshot"][0]["data"]
clips=[(t["name"],c) for t in snap["tracks"] for c in t.get("clips",[])]
rec=[(n,c) for n,c in clips if c.get("recovered")]
assert rec, "no clip is marked recovered after adopt"
name,c=rec[0]
assert name=="Vox", f"recovered take landed on {name}, not Vox"
assert c["length"]>=2.0, f"recovered take is too short: {c['length']}"
assert "peakLevel" in c, "recovered take was not measured"
print(f"crash-residue-smoke: PASS — recovered {c['length']:.2f}s take on {name}, silent={c.get('silent')}")
PY
