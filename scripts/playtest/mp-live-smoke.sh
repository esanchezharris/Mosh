#!/usr/bin/env bash
# mp-live-smoke.sh — TWO real Mosh processes, live, over the CLOUD relay (the
# playtest's actual path). Goes beyond `--selftest` (which runs two simulated peers
# in ONE process): here process A and process B are separate OS processes that only
# meet through the relay.
#
#   A: create a session  -> build a drum (MIDI) track + a tone (audio) track
#      -> claim + commit each -> stay alive (long __wait) so it can answer the joiner.
#   B: join with A's room code -> wait for sync -> export the whole project to WAV.
#
# Non-silent B export => B received A's tracks/instruments end-to-end across processes.
# A by-hash stem appearing in B's session dir => the audio-clip blob round-trip worked.
#
# Usage:  MOSH_BIN=/path/to/Mosh bash scripts/playtest/mp-live-smoke.sh
set -uo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
BIN="${MOSH_BIN:-$(find "$ROOT/build-macos-arm64-release" -name Mosh -path '*Mosh.app/Contents/MacOS/*' -type f 2>/dev/null | head -1)}"
[ -x "$BIN" ] || { echo "Mosh binary not found; set MOSH_BIN"; exit 2; }

ART="${ART:-/tmp/pp-mp-smoke}"; mkdir -p "$ART"
SESS_A="session-pp-mpA-$$"; SESS_B="session-pp-mpB-$$"
for s in "$SESS_A" "$SESS_B"; do rm -rf "$HOME/Library/Mosh/$s" "$HOME/Library/Mosh/${s}-undo"; done

echo "binary: $BIN"
if [ -n "${MOSH_RELAY_URL:-}" ]; then
  echo "relay : $MOSH_RELAY_URL"
else
  echo "relay : (baked cloud default — no MOSH_RELAY_URL set)"
fi

# ── Process A: create session, build content, commit, then stay online ──────────
cat > "$ART/a.jsonl" <<'EOF'
{"command":"mp_create_session","args":{"name":"HostA","color":"#3aa0ff"},"capture":{"ROOM":"code"}}
{"command":"create_track","args":{"name":"SmokeDrums","type":"drum"},"capture":{"TD":"trackId"}}
{"command":"add_midi_clip","args":{"trackId":"${TD}","start":0,"length":4,"notes":[{"pitch":36,"start":0,"length":0.5,"velocity":120},{"pitch":38,"start":1,"length":0.5,"velocity":110},{"pitch":36,"start":2,"length":0.5,"velocity":120},{"pitch":38,"start":3,"length":0.5,"velocity":110}]}}
{"command":"mp_claim_track","args":{"trackId":"${TD}"}}
{"command":"mp_commit_track","args":{"trackId":"${TD}"}}
{"command":"create_track","args":{"name":"SmokeTone"},"capture":{"TT":"trackId"}}
{"command":"add_test_tone_clip","args":{"trackId":"${TT}","seconds":2.0,"freq":330.0}}
{"command":"mp_claim_track","args":{"trackId":"${TT}"}}
{"command":"mp_commit_track","args":{"trackId":"${TT}"}}
{"command":"__wait","args":{"ms":45000}}
EOF

MOSH_NO_AUDIO=1 MOSH_SELFTEST_SESSION="$SESS_A" \
  MOSH_RUN_SCRIPT="$ART/a.jsonl" MOSH_RUN_SCRIPT_OUT="$ART/a.out" \
  "$BIN" --run-script > "$ART/a.stdout" 2>"$ART/a.stderr" &
APID=$!
trap 'kill "$APID" 2>/dev/null || true' EXIT

# ── capture A's room code from its live stdout (std::endl flushes each result) ──
# Results are pretty-printed JSON ("code": "..."), so parse properly rather than grep.
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
  echo "FAIL: A never produced a room code. A stderr tail:"; tail -10 "$ART/a.stderr"; exit 1
fi
echo "room code: $ROOM"

# ── Process B: join, wait for sync, then SAVE (so we can inspect the applied edit).
# NB: we deliberately do NOT export from the guest — export_audio inside a freshly
# joined session hangs in this headless run-script harness (see followups.md). We
# verify sync via on-disk artifacts instead: the downloaded stem + the saved edit.
# P4 self-heal (PR-1): mp_fetch_missing_stems{wait:true} + __snapshot right after the
# sync wait — normally a no-op (the commit/apply download already landed the stem, or
# mp_apply_bootstrap's own auto-trigger already healed it), but it's the real recovery
# path if this live cross-machine transfer hits a transient hiccup the __wait alone
# didn't ride out, and the snapshot is how the verdict below confirms no clip is left
# sourceMissing (not just that SOME stem file exists on disk).
cat > "$ART/b.jsonl" <<EOF
{"command":"mp_join_session","args":{"code":"$ROOM","name":"GuestB","color":"#ff7755"}}
{"command":"__wait","args":{"ms":16000}}
{"command":"mp_fetch_missing_stems","args":{"wait":true}}
{"command":"__snapshot"}
{"command":"save"}
EOF

MOSH_NO_AUDIO=1 MOSH_SELFTEST_SESSION="$SESS_B" \
  MOSH_RUN_SCRIPT="$ART/b.jsonl" MOSH_RUN_SCRIPT_OUT="$ART/b.out" \
  "$BIN" --run-script > "$ART/b.stdout" 2>"$ART/b.stderr"

kill "$APID" 2>/dev/null || true; wait "$APID" 2>/dev/null || true

echo "=== B command results ==="; cat "$ART/b.out" 2>/dev/null
BDIR="$HOME/Library/Mosh/$SESS_B"

# A's uploaded stem hash (from A's tone-track commit).
A_HASH="$(python3 - "$ART/a.out" "$ART/a.stdout" <<'PY'
import json, os, sys
for path in sys.argv[1:]:
    if not os.path.exists(path):
        continue
    for line in open(path):
        line=line.strip()
        if not line: continue
        try: o=json.loads(line)
        except Exception: continue
        for r in (o.get("data",{}).get("audioRefs") or []):
            if r.get("hash"): print(r["hash"]); raise SystemExit
PY
)"
echo "A uploaded stem hash: ${A_HASH:-<none>}"

echo "=== B by-hash stems (audio blob DOWNLOAD evidence) ==="
find "$BDIR" -path '*by-hash*' -type f 2>/dev/null | sed "s|$HOME|~|" || echo "(none)"

echo "=== B applied tracks (saved edit) ==="
BEDIT="$(find "$BDIR" -name '*.tracktionedit' -type f 2>/dev/null | head -1)"
DRUMS=0; TONE=0
if [ -n "$BEDIT" ]; then
  grep -q "SmokeDrums" "$BEDIT" && DRUMS=1
  grep -q "SmokeTone"  "$BEDIT" && TONE=1
  echo "edit: ${BEDIT#$HOME/} (SmokeDrums=$DRUMS SmokeTone=$TONE)"
else
  echo "(no saved edit found)"
fi

echo "=== B mp_fetch_missing_stems (P4 self-heal) ==="
FETCH_LINE="$(python3 - "$ART/b.out" <<'PY'
import json, sys
for line in open(sys.argv[1]):
    line = line.strip()
    if not line: continue
    try: o = json.loads(line)
    except Exception: continue
    if o.get("command") == "mp_fetch_missing_stems":
        print(json.dumps(o.get("data", {}))); break
PY
)"
echo "${FETCH_LINE:-(no mp_fetch_missing_stems result found)}"

echo "=== B snapshot: any clip still sourceMissing? ==="
# The real verdict for the self-heal path: not "does a by-hash file exist somewhere",
# but "does B's OWN applied project resolve every clip's audio" (the __snapshot
# emitted right after mp_fetch_missing_stems above is the same snapshot() the WebView
# would render). A track landing with its structure but a dangling sourceMissing clip
# is exactly the P4 regression this PR fixes — catch it here on a REAL cross-machine
# transfer, not just in the hermetic --selftest gate.
ANY_MISSING="$(python3 - "$ART/b.out" <<'PY'
import json, sys
snap = None
for line in open(sys.argv[1]):
    line = line.strip()
    if not line: continue
    try: o = json.loads(line)
    except Exception: continue
    if o.get("command") == "__snapshot":
        snap = o.get("data", {})
missing = []
if snap:
    for t in snap.get("tracks", []):
        for c in t.get("clips", []):
            if c.get("type") == "wave" and c.get("sourceMissing"):
                missing.append(c.get("id", "?"))
print("yes" if missing else "no")
PY
)"
echo "sourceMissing present: $ANY_MISSING"

# ── verdict ─────────────────────────────────────────────────────────────────────
STEM_OK=0
if [ -n "$A_HASH" ] && [ -n "$(find "$BDIR" -name "$A_HASH.*" -type f -print -quit 2>/dev/null)" ]; then
  STEM_OK=1
fi
echo
echo "RESULT:"
if [ "$ANY_MISSING" = "yes" ]; then
  echo "  FAIL — B's snapshot still shows a sourceMissing wave clip after mp_fetch_missing_stems{wait:true} — the P4 self-heal did not resolve it on this real cross-machine transfer."
  exit 1
elif [ "$STEM_OK" = 1 ] && [ "$DRUMS" = 1 ] && [ "$TONE" = 1 ]; then
  echo "  PASS — B (separate process) received A's MIDI track + audio track AND downloaded the audio stem over the cloud relay (no clip left sourceMissing)."
  exit 0
elif [ "$STEM_OK" = 1 ]; then
  echo "  PARTIAL — B downloaded A's audio stem (blob round-trip OK), but the saved edit did not show both track names (DRUMS=$DRUMS TONE=$TONE)."
  exit 1
else
  echo "  FAIL — B did not receive A's audio stem; sync did not deliver across processes."
  exit 1
fi
