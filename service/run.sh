#!/usr/bin/env bash
# Dev launcher for the Mosh generative service (06 §5).
#
# Interpreter selection: when MOSH_ENABLE_SA3=1 and the SA3 MLX venv exists, run
# under $SA3_MLX_DIR/.venv/bin/python so the carved in-process SA3 engine can import
# mlx + the model code. Otherwise system python3 (FakeAdapter only — it is stdlib).
# FakeAdapter works under either interpreter, so the choice is invisible over HTTP.
#
# External deps stay external, pointed at by env vars (App. B):
#   SA3_MLX_DIR    — the MLX Stable-Audio-3 port (model + scripts)
#   COLORRACK_DATA — the built colour rack (service/colors/build_colorrack.py)
set -euo pipefail
cd "$(dirname "$0")"

# Service stderr/stdout default to a file under ~/Library/Mosh/logs (mkdir'd here) so
# a spawn/crash/import-error is diagnosable after the fact (collect-diagnostics.sh
# picks this up); MOSH_SERVICE_LOG still overrides the path when explicitly set.
# Simple size cap: rotate the single previous file once past ~20 MB so a long-lived
# install doesn't grow service.log unbounded.
export MOSH_SERVICE_LOG="${MOSH_SERVICE_LOG:-$HOME/Library/Mosh/logs/service.log}"
mkdir -p "$(dirname "$MOSH_SERVICE_LOG")" 2>/dev/null || true

# Rotation race: two run.sh instances can start near-simultaneously (a stale-service
# reap racing a fresh spawn, or a second launcher on the same machine) and both decide
# to rotate the same oversized log, clobbering each other's ".old". The PID handshake
# file (GenerativeJobManager's C2 reap mechanism: "<pid> <port>") tells us whether a
# service is ALREADY alive; if so, that instance owns the log lifecycle and we skip
# rotating out from under it — rotation is a nice-to-have size cap, not
# correctness-critical, so skipping it in this rare race is the safe call. A missing or
# stale (dead-PID) handshake file means no one else is alive, so rotating is safe.
_other_instance_alive() {
  local pidfile="$HOME/Library/Mosh/service.pid" live_pid
  [[ -f "$pidfile" ]] || return 1
  live_pid="$(awk '{print $1}' "$pidfile" 2>/dev/null)"
  [[ -n "$live_pid" ]] && kill -0 "$live_pid" 2>/dev/null
}
if [[ -f "$MOSH_SERVICE_LOG" ]] && ! _other_instance_alive; then
  SZ="$(stat -f%z "$MOSH_SERVICE_LOG" 2>/dev/null || stat -c%s "$MOSH_SERVICE_LOG" 2>/dev/null || echo 0)"
  if [[ "$SZ" -gt $((20 * 1024 * 1024)) ]]; then
    mv -f "$MOSH_SERVICE_LOG" "$MOSH_SERVICE_LOG.old" 2>/dev/null || true
  fi
fi
exec >> "$MOSH_SERVICE_LOG" 2>&1
printf '[run.sh] cwd=%s\n' "$PWD"

REQUESTED_MOSH_ENABLE_SA3="${MOSH_ENABLE_SA3:-}"
REQUESTED_MOSH_SERVICE_PYTHON="${MOSH_SERVICE_PYTHON:-}"
REQUESTED_MOSH_RECIPE_LIBRARY="${MOSH_RECIPE_LIBRARY:-}"
REQUESTED_MOSH_PALETTE_MANIFEST="${MOSH_PALETTE_MANIFEST:-}"
export PYTHONDONTWRITEBYTECODE="${PYTHONDONTWRITEBYTECODE:-1}"

# Persisted setup from setup-sa3.sh (resolved paths + MOSH_ENABLE_SA3). Optional —
# absent means the defaults below apply and SA3 stays off unless the venv happens to
# exist. Sourced first so its exports seed the ${:-default} fallbacks.
[[ -f .sa3.env ]] && source ./.sa3.env
[[ -n "$REQUESTED_MOSH_ENABLE_SA3" ]] && export MOSH_ENABLE_SA3="$REQUESTED_MOSH_ENABLE_SA3"
# Audio->MIDI (Basic Pitch) lives in its own venv; .transcribe.env (written by
# transcribe/setup-transcribe.sh) exports BASIC_PITCH_PY. Absent → /transcribe
# degrades gracefully to 503 transcription_unavailable.
[[ -f transcribe/.transcribe.env ]] && source ./transcribe/.transcribe.env
# Sketch (beatbox -> drum MoshOps) lives in its own venv; .sketch.env (written by
# sketch/setup-sketch.sh) exports SKETCH_PY. Absent → /sketch degrades gracefully to
# 503 sketch_unavailable.
[[ -f sketch/.sketch.env ]] && source ./sketch/.sketch.env
# Whisper (word transcription for the lyric "mumble take") lives in its own venv;
# .whisper.env (written by whisper/setup-whisper.sh) exports WHISPER_PY. Absent →
# /transcribe_words degrades to empty words (the rhythm sheet still builds).
[[ -f whisper/.whisper.env ]] && source ./whisper/.whisper.env
# Skeleton (Phase-2 mumble->skeleton F0 via FCPE) lives in its own venv; .skeleton.env
# (written by skeleton/setup-skeleton.sh) exports SKELETON_PY. Absent → /skeleton_spec
# degrades to the Basic-Pitch note-onset rhythm (no F0).
[[ -f skeleton/.skeleton.env ]] && source ./skeleton/.skeleton.env
# Transform (RAVE timbre transfer, Route C) lives in its own venv; .transform.env
# (written by transform/setup-transform.sh) exports TRANSFORM_PY + RAVE_MODEL_DIR.
# Absent → the `transform` adapter falls back to the deterministic fake (Route B).
[[ -f transform/.transform.env ]] && source ./transform/.transform.env
[[ -f .recipe.env ]] && source ./.recipe.env
[[ -n "$REQUESTED_MOSH_SERVICE_PYTHON" ]] && export MOSH_SERVICE_PYTHON="$REQUESTED_MOSH_SERVICE_PYTHON"
[[ -n "$REQUESTED_MOSH_RECIPE_LIBRARY" ]] && export MOSH_RECIPE_LIBRARY="$REQUESTED_MOSH_RECIPE_LIBRARY"
[[ -n "$REQUESTED_MOSH_PALETTE_MANIFEST" ]] && export MOSH_PALETTE_MANIFEST="$REQUESTED_MOSH_PALETTE_MANIFEST"
# Phase-4 SFT lane lives in its own mlx-lm venv; .sft.env (written by
# sft/setup-sft.sh) exports SFT_PY for the trainer CLI. Absent → the SFT lane is
# simply unavailable; the rest of the service is unaffected.
[[ -f sft/.sft.env ]] && source ./sft/.sft.env
# Phonology (lyric rhyme/syllable/stress) lives in its own venv; .phonology.env
# (written by phonology/setup-phonology.sh) exports PHONOLOGY_PY. Absent → /get_rhymes
# runs in-process (precise if cmudict is importable, else a stdlib vowel-group heuristic).
[[ -f phonology/.phonology.env ]] && source ./phonology/.phonology.env

export SA3_MLX_DIR="${SA3_MLX_DIR:-$HOME/AI/stable-audio-3/optimized/mlx}"
export COLORRACK_DATA="${COLORRACK_DATA:-$(pwd)/colors/COLORRACK_DATA}"

# SA3 is on by default; the carve runs under the MLX venv when present, else this
# silently falls back to system python3 (FakeAdapter only). Set MOSH_ENABLE_SA3=0
# to force FakeAdapter even when the venv exists.
PY="${MOSH_SERVICE_PYTHON:-python3}"
if [[ -z "${MOSH_SERVICE_PYTHON:-}" && "${MOSH_ENABLE_SA3:-1}" == "1" && -x "$SA3_MLX_DIR/.venv/bin/python" ]]; then
  PY="$SA3_MLX_DIR/.venv/bin/python"
fi

if [[ -n "${MOSH_SERVICE_LOG:-}" ]]; then
  printf '[run.sh] py=%s MOSH_SERVICE_PYTHON=%s MOSH_RECIPE_LIBRARY=%s MOSH_PALETTE_MANIFEST=%s\n' \
    "$PY" "${MOSH_SERVICE_PYTHON:-}" "${MOSH_RECIPE_LIBRARY:-}" "${MOSH_PALETTE_MANIFEST:-}"
fi

exec "$PY" server.py "$@"
