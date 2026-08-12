#!/usr/bin/env bash
# mp-two-window-dry-run.sh — the "two-window dry run" from
# docs/playtest-prep/HOST_CHECKLIST.md §4, adapted for a headless agent session
# (no Accessibility perms to synthetically click a real GUI — see CLAUDE.md's
# gotchas). Two REAL, SEPARATE OS processes (like scripts/playtest/mp-live-
# smoke.sh) driven via `--run-script`, each with its own genuinely distinct
# harness session directory (JUCE ignores $HOME — CLAUDE.md — so two windows
# sharing one session dir would not actually simulate two peers), talking over
# the LOCAL relay (same-machine simulation; the cloud relay path is already
# covered by mp-live-smoke.sh).
#
# Exercises, in order: create/join, a MIDI track commit, a real (if small)
# audio-take commit, explicit claim->commit(release) cycles for two different
# tracks, bus creation (MP-003), track-group creation (MP-003), a late-join
# bootstrap (B joins only after A has already built everything), and — the
# empirical ask from the playtest-readiness audit's blocker #2 — a REAL
# multi-minute audio take (not a 1-2s tone) committed and verified byte-
# identical on the peer.
#
# Usage:  bash scripts/playtest/mp-two-window-dry-run.sh
#   MOSH_BIN        override the Mosh binary (default: newest under build-macos-arm64*)
#   PORT            local relay port (default 8798 — distinct from run-mp-selftest.sh's 8799)
#   TAKE_SECONDS    length of the "real take" WAV (default 90 — keep under HOST_CHECKLIST's
#                   suggested 1-3 minute range while keeping the dry run itself quick)
set -uo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
source "$ROOT/scripts/lib/harness-session.sh"

BIN="${MOSH_BIN:-}"
if [ -z "$BIN" ]; then
  BIN="$(find "$ROOT/build-macos-arm64" -name Mosh -path '*Mosh.app/Contents/MacOS/*' -type f -newer "$ROOT/CMakeLists.txt" 2>/dev/null | head -1)"
  [ -x "$BIN" ] || BIN="$(find "$ROOT/build-macos-arm64" -name Mosh -path '*Mosh.app/Contents/MacOS/*' -type f 2>/dev/null | head -1)"
fi
[ -x "$BIN" ] || { echo "Mosh binary not found; set MOSH_BIN or build first"; exit 2; }
echo "binary: $BIN"

PORT="${PORT:-8798}"
TAKE_SECONDS="${TAKE_SECONDS:-90}"
ART="${ART:-/tmp/mp-dry-run}"
rm -rf "$ART"; mkdir -p "$ART"
SESS_A="_harness/session-mp-dryrun-A-$$"
SESS_B="_harness/session-mp-dryrun-B-$$"
for s in "$SESS_A" "$SESS_B"; do
  mosh_reset_owned_harness_session "$s"
  mosh_reset_owned_harness_session "${s}-undo"
done

# ── start the LOCAL relay (same-machine simulation of the two peers) ────────
PORT="$PORT" python3 "$ROOT/relay/server.py" >"$ART/relay.log" 2>&1 &
RELAY_PID=$!
cleanup() { kill "$RELAY_PID" "$APID" 2>/dev/null || true; pkill -f "relay/server.py.*$PORT" 2>/dev/null || true; }
trap cleanup EXIT
python3 - "$PORT" <<'PY'
import sys, urllib.request, time
for _ in range(100):
    try:
        urllib.request.urlopen(f"http://127.0.0.1:{sys.argv[1]}/health", timeout=0.5)
        break
    except Exception:
        time.sleep(0.05)
else:
    sys.exit("relay did not start")
PY
echo "relay: http://127.0.0.1:$PORT (local, same-machine simulation)"

# ── generate a REAL multi-minute take (not a 1-2s tone) ─────────────────────
# 16-bit stereo 44.1kHz sine-ish content, TAKE_SECONDS long (default 90s ~= 16MB) —
# a genuinely large stem, unlike every prior MP test (SelfTest.cpp / mp-live-
# smoke.sh both use 1-2 SECOND tones per the playtest-readiness audit's blocker #2).
python3 - "$ART/bigtake.wav" "$TAKE_SECONDS" <<'PY'
import sys, wave, struct, math
path, seconds = sys.argv[1], float(sys.argv[2])
sr = 44100
n = int(sr * seconds)
with wave.open(path, "wb") as w:
    w.setnchannels(2)
    w.setsampwidth(2)
    w.setframerate(sr)
    chunk = []
    for i in range(n):
        v = int(6000 * math.sin(2 * math.pi * 220.0 * i / sr))
        chunk.append(struct.pack("<hh", v, v))
        if len(chunk) >= 44100:
            w.writeframesraw(b"".join(chunk)); chunk = []
    if chunk: w.writeframesraw(b"".join(chunk))
print(f"wrote {path}: {seconds}s stereo 44.1kHz")
PY
BIGTAKE_HASH="$(shasum -a 256 "$ART/bigtake.wav" | cut -d' ' -f1)"
BIGTAKE_SIZE="$(stat -f%z "$ART/bigtake.wav" 2>/dev/null || stat -c%s "$ART/bigtake.wav")"
echo "real take: $ART/bigtake.wav ($BIGTAKE_SIZE bytes, sha256 $BIGTAKE_HASH)"

# ── Peer A ("window A"): create, build a MIDI track + a small real audio take +
#    a bus + a track group, each via an explicit claim -> edit -> commit
#    (release) cycle, then import + commit the real multi-minute take, then
#    stay alive to answer B's late-join bootstrap. ───────────────────────────
cat > "$ART/a.jsonl" <<EOF
{"command":"mp_create_session","args":{"name":"WindowA","color":"#3aa0ff"},"capture":{"ROOM":"code"}}
{"command":"create_track","args":{"name":"Drums","type":"drum"},"capture":{"TD":"trackId"}}
{"command":"mp_claim_track","args":{"trackId":"\${TD}"}}
{"command":"add_midi_clip","args":{"trackId":"\${TD}","start":0,"length":4,"notes":[{"pitch":36,"start":0,"length":0.5,"velocity":120},{"pitch":38,"start":1,"length":0.5,"velocity":110}]}}
{"command":"mp_commit_track","args":{"trackId":"\${TD}"}}
{"command":"create_track","args":{"name":"Tone"},"capture":{"TT":"trackId"}}
{"command":"mp_claim_track","args":{"trackId":"\${TT}"}}
{"command":"add_test_tone_clip","args":{"trackId":"\${TT}","seconds":2.0,"freq":330.0}}
{"command":"mp_commit_track","args":{"trackId":"\${TT}"}}
{"command":"create_bus","args":{"name":"DryRunReverb"},"capture":{"BUSNUM":"busNumber"}}
{"command":"create_track_group","args":{"trackIds":["\${TD}","\${TT}"],"name":"DryRunGroup","kind":"edit_mix"},"capture":{"GROUPID":"groupId"}}
{"command":"create_track","args":{"name":"BigTake"},"capture":{"TB":"trackId"}}
{"command":"mp_claim_track","args":{"trackId":"\${TB}"}}
{"command":"import_clip","args":{"trackId":"\${TB}","file":"$ART/bigtake.wav","startSeconds":0}}
{"command":"mp_commit_track","args":{"trackId":"\${TB}"}}
{"command":"__wait","args":{"ms":20000}}
{"command":"__snapshot","args":{"label":"A_final"}}
{"command":"__wait","args":{"ms":30000}}
EOF

MOSH_NO_AUDIO=1 MOSH_SELFTEST_SESSION="$SESS_A" MOSH_RELAY_URL="http://127.0.0.1:$PORT" \
  MOSH_RUN_SCRIPT="$ART/a.jsonl" MOSH_RUN_SCRIPT_OUT="$ART/a.out" \
  "$BIN" --run-script > "$ART/a.stdout" 2>"$ART/a.stderr" &
APID=$!

# ── capture A's room code ────────────────────────────────────────────────────
ROOM=""
for _ in $(seq 1 80); do
  ROOM="$(python3 - "$ART/a.stdout" <<'PY'
import sys, json
for line in open(sys.argv[1]):
    line = line.strip()
    if not line: continue
    try: o = json.loads(line)
    except Exception: continue
    if o.get("command") == "mp_create_session" and o.get("ok"):
        print(o.get("data", {}).get("code", "")); break
PY
)"
  [ -n "$ROOM" ] && break
  python3 -c "import time;time.sleep(0.5)"
done
if [ -z "$ROOM" ]; then
  echo "FAIL: A never produced a room code. A stderr tail:"; tail -20 "$ART/a.stderr"; exit 1
fi
echo "room code: $ROOM"

# Give A time to actually build + commit everything (MIDI/tone/bus/group are
# fast; the big-take upload is the long pole) before B's LATE join.
sleep_secs=0
while [ "$sleep_secs" -lt 25 ]; do
  if grep -q '"label":"A_final"' "$ART/a.stdout" 2>/dev/null; then break; fi
  python3 -c "import time;time.sleep(1)"
  sleep_secs=$((sleep_secs + 1))
done

# ── Peer B ("window B"): LATE join (after A has already built everything —
#    the bootstrap path, not just live commit-forwarding), wait for the
#    bootstrap + self-heal, snapshot, save. ─────────────────────────────────
cat > "$ART/b.jsonl" <<EOF
{"command":"mp_join_session","args":{"code":"$ROOM","name":"WindowB","color":"#ff7755"}}
{"command":"__wait","args":{"ms":25000}}
{"command":"mp_fetch_missing_stems","args":{"wait":true}}
{"command":"__snapshot","args":{"label":"B_after_bootstrap"}}
{"command":"save"}
EOF

MOSH_NO_AUDIO=1 MOSH_SELFTEST_SESSION="$SESS_B" MOSH_RELAY_URL="http://127.0.0.1:$PORT" \
  MOSH_RUN_SCRIPT="$ART/b.jsonl" MOSH_RUN_SCRIPT_OUT="$ART/b.out" \
  "$BIN" --run-script > "$ART/b.stdout" 2>"$ART/b.stderr"
B_RC=$?

kill "$APID" 2>/dev/null || true; wait "$APID" 2>/dev/null || true

if [ "$B_RC" -ne 0 ]; then
  echo "FAIL: peer B's run-script exited $B_RC. B stderr tail:"; tail -30 "$ART/b.stderr"; exit 1
fi

# ── verdict: everything A built must be visible in B's post-bootstrap snapshot ──
python3 - "$ART/b.stdout" "$ART/a.stdout" "$BIGTAKE_HASH" "$BIGTAKE_SIZE" <<'PY'
import sys, json, os

b_stdout, a_stdout, bigtake_hash, bigtake_size = sys.argv[1], sys.argv[2], sys.argv[3], int(sys.argv[4])

def find_snapshot(path, label):
    for line in open(path):
        line = line.strip()
        if not line: continue
        try: o = json.loads(line)
        except Exception: continue
        if o.get("command") == "__snapshot" and o.get("label") == label:
            return o.get("data")
    return None

snap = find_snapshot(b_stdout, "B_after_bootstrap")
if snap is None:
    print("FAIL: B never produced a B_after_bootstrap snapshot"); sys.exit(1)

failures = []

names = {t["name"] for t in snap.get("tracks", [])}
for want in ("Drums", "Tone", "BigTake"):
    if want not in names:
        failures.append(f"track {want!r} missing from B's snapshot (tracks: {sorted(names)})")

buses = snap.get("buses", [])
if not any(bus.get("name") == "DryRunReverb" for bus in buses):
    failures.append(f"bus 'DryRunReverb' did not replicate to B (buses: {buses})")

groups = snap.get("trackGroups", [])
if not any(g.get("name") == "DryRunGroup" for g in groups):
    failures.append(f"track group 'DryRunGroup' did not replicate to B (trackGroups: {groups})")
else:
    g = next(g for g in groups if g.get("name") == "DryRunGroup")
    if len(g.get("trackIds", [])) != 2:
        failures.append(f"track group 'DryRunGroup' replicated with wrong membership: {g}")

bigtake = next((t for t in snap.get("tracks", []) if t["name"] == "BigTake"), None)
if bigtake is None:
    failures.append("BigTake track missing")
else:
    clips = bigtake.get("clips", [])
    if not clips:
        failures.append("BigTake track has no clips on B")
    else:
        src = clips[0].get("sourceFile", "")
        if clips[0].get("sourceMissing"):
            failures.append(f"BigTake clip is sourceMissing on B: {clips[0]}")
        elif not os.path.isabs(src) or not os.path.exists(src):
            failures.append(f"BigTake clip's source file does not exist on disk: {src!r}")
        else:
            actual_size = os.path.getsize(src)
            if actual_size != bigtake_size:
                failures.append(f"BigTake stem size mismatch: expected {bigtake_size}, got {actual_size} ({src})")
            import hashlib
            h = hashlib.sha256(open(src, "rb").read()).hexdigest()
            if h != bigtake_hash:
                failures.append(f"BigTake stem hash mismatch: expected {bigtake_hash}, got {h} ({src})")
            print(f"BigTake stem verified byte-identical on B: {src} ({actual_size} bytes)")

if failures:
    print("FAIL:")
    for f in failures: print(" -", f)
    sys.exit(1)

print("PASS: two-window dry run — MIDI track, audio track, bus, track group, and a real"
      f" {bigtake_size}-byte take all replicated correctly to the late-joining peer B.")
PY
VERDICT_RC=$?
exit "$VERDICT_RC"
