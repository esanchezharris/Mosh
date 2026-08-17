#!/usr/bin/env bash
# setup-trainer.sh — install what local LoRA training needs on this Mac.
#
# Two assets, deliberately handled differently:
#
#   1. The trainer itself (`pmetal` + `mlx.metallib`, ~32MB) — staged into
#      resources/trainer/ so the CMake POST_BUILD step can copy it into
#      Mosh.app/Contents/Helpers/trainer. Small enough to ship, too big to
#      commit.
#   2. The SA3-medium base checkpoint (~2.7GB) — NOT bundled and not fetched
#      here by default. It is the same class of asset as the SA3 render
#      weights: external, resolved by env, and gated on by the capability
#      check. Bundling the trainer does NOT make training work out of the box,
#      and pretending otherwise would ship a Train button that fails.
#
# Usage:
#   service/training/setup-trainer.sh                 # stage from a local pmetal build
#   PMETAL_SRC=~/AI/pmetal service/training/setup-trainer.sh
#   service/training/setup-trainer.sh --check         # report readiness only
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
DEST="$REPO_ROOT/resources/trainer"
PMETAL_SRC="${PMETAL_SRC:-$HOME/AI/pmetal}"
BASE_DIT="${MOSH_SA3_BASE_DIT:-$HOME/.cache/pmetal-sa3-spike/dit_medium_BASE_f16.safetensors}"

say() { printf '  %s\n' "$*"; }

check_only=0
[ "${1:-}" = "--check" ] && check_only=1

echo "LoRA trainer setup"
echo "=================="

# ── 1. the trainer binary ────────────────────────────────────────────────────
if [ -x "$DEST/pmetal" ] && [ -f "$DEST/mlx.metallib" ]; then
  say "OK   trainer staged at $DEST"
elif [ "$check_only" = 1 ]; then
  say "MISS trainer not staged at $DEST"
else
  src_bin="$PMETAL_SRC/target/release/pmetal"
  if [ ! -x "$src_bin" ]; then
    say "MISS no pmetal build at $src_bin"
    say "     build it:  cd $PMETAL_SRC && cargo build --release -p pmetal"
    say "     or set PMETAL_SRC=/path/to/pmetal"
    exit 1
  fi
  mkdir -p "$DEST"
  cp "$src_bin" "$DEST/pmetal"
  # mlx.metallib must ride along or pmetal downloads it from GitHub at runtime.
  metallib=""
  for c in "$PMETAL_SRC/target/release/mlx.metallib" \
           "$HOME/.cache/pmetal/lib/mlx.metallib"; do
    [ -f "$c" ] && metallib="$c" && break
  done
  if [ -z "$metallib" ]; then
    metallib="$(find "$PMETAL_SRC/target/release" -name 'mlx.metallib' -print -quit 2>/dev/null || true)"
  fi
  if [ -z "$metallib" ]; then
    say "WARN mlx.metallib not found — the trainer will try to DOWNLOAD it on first run"
    say "     (look for it under $PMETAL_SRC/target/release or ~/.cache/pmetal/lib)"
  else
    cp "$metallib" "$DEST/mlx.metallib"
    say "OK   staged trainer + mlx.metallib into $DEST"
  fi
fi

# ── 2. the base checkpoint (external, never bundled) ─────────────────────────
if [ -f "$BASE_DIT" ]; then
  sz=$(stat -f%z "$BASE_DIT" 2>/dev/null || stat -c%s "$BASE_DIT" 2>/dev/null || echo 0)
  if [ "$sz" -lt 2000000000 ]; then
    say "WARN base checkpoint looks truncated ($((sz / 1000000))MB, expected ~2700MB): $BASE_DIT"
    say "     a truncated checkpoint trains happily and produces garbage"
  else
    say "OK   base checkpoint $BASE_DIT ($((sz / 1000000))MB)"
  fi
else
  say "MISS SA3 base checkpoint not found at $BASE_DIT"
  say "     point MOSH_SA3_BASE_DIT at an SA3-medium DiT safetensors, or run the"
  say "     SA3 setup that provisions it (service/setup-sa3.sh)."
fi

# ── 3. the MLX venv (precompute needs the live engine) ───────────────────────
if [ "${MOSH_ENABLE_SA3:-0}" = "1" ]; then
  say "OK   MOSH_ENABLE_SA3=1 (precompute can drive the live SA3 engine)"
else
  say "NOTE MOSH_ENABLE_SA3 is not 1 — the service must run under the MLX venv"
  say "     for precompute; see service/run.sh"
fi

echo
echo "Readiness is reported live at /training/capabilities (field: blockers)."
