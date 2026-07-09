#!/usr/bin/env bash
set -uo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
SCRIPT="$ROOT/scripts/playtest/mp-live-smoke.sh"
TMP="${TMPDIR:-/tmp}/mp-live-smoke-verdict-test-$$"
mkdir -p "$TMP"
trap 'rm -rf "$TMP"' EXIT

FAKE_BIN="$TMP/fake-mosh"
cat > "$FAKE_BIN" <<'SH'
#!/usr/bin/env bash
set -uo pipefail

mode="${SMOKE_FIXTURE_MODE:?SMOKE_FIXTURE_MODE required}"
session="${MOSH_SELFTEST_SESSION:?MOSH_SELFTEST_SESSION required}"
out="${MOSH_RUN_SCRIPT_OUT:?MOSH_RUN_SCRIPT_OUT required}"
mkdir -p "$(dirname "$out")" "$HOME/Library/Mosh/$session/by-hash" "$HOME/Library/Mosh/$session/edit"

if [[ "$session" == *mpA* ]]; then
  printf '{"command":"mp_create_session","ok":true,"data":{"code":"ROOM42"}}\n'
  printf '{"command":"mp_commit_track","ok":true,"data":{"audioRefs":[{"hash":"stemhash"}]}}\n' > "$out"
  sleep 60
  exit 0
fi

printf '{"command":"mp_join_session","ok":true}\n{"command":"save","ok":true}\n' > "$out"

case "$mode" in
  pass)
    printf 'stem\n' > "$HOME/Library/Mosh/$session/by-hash/stemhash.wav"
    printf '<TRACK name="SmokeDrums"/>\n<TRACK name="SmokeTone"/>\n' > "$HOME/Library/Mosh/$session/edit/smoke.tracktionedit"
    ;;
  partial)
    printf 'stem\n' > "$HOME/Library/Mosh/$session/by-hash/stemhash.wav"
    printf '<TRACK name="SmokeDrums"/>\n' > "$HOME/Library/Mosh/$session/edit/smoke.tracktionedit"
    ;;
  fail)
    printf '<TRACK name="SmokeDrums"/>\n' > "$HOME/Library/Mosh/$session/edit/smoke.tracktionedit"
    ;;
  *)
    echo "unknown SMOKE_FIXTURE_MODE=$mode" >&2
    exit 64
    ;;
esac
SH
chmod +x "$FAKE_BIN"

run_case() {
  local mode="$1" expected_rc="$2" expected_text="$3"
  local home="$TMP/home-$mode" art="$TMP/art-$mode" log="$TMP/$mode.log"
  mkdir -p "$home" "$art"

  HOME="$home" ART="$art" MOSH_BIN="$FAKE_BIN" SMOKE_FIXTURE_MODE="$mode" \
    bash "$SCRIPT" > "$log" 2>&1
  local rc=$?

  if [ "$rc" -ne "$expected_rc" ]; then
    echo "FAIL: $mode expected rc=$expected_rc got rc=$rc" >&2
    cat "$log" >&2
    exit 1
  fi

  if ! grep -q "$expected_text" "$log"; then
    echo "FAIL: $mode expected output containing: $expected_text" >&2
    cat "$log" >&2
    exit 1
  fi
}

run_case pass 0 "PASS"
run_case partial 1 "PARTIAL"
run_case fail 1 "FAIL"

echo "mp-live-smoke verdict selftest PASS"
