#!/usr/bin/env bash
# The owner installer must stage the shared helper additively: the helper holds owner
# data that is not in git (SFT adapters/data, training state), and an earlier
# `rsync --delete` would have wiped about 3.5 GB of it. Runs the real script against a
# throwaway repo, build dir and HOME, with codesign stubbed.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
T="$(mktemp -d "${TMPDIR:-/tmp}/mosh-install-owner.XXXXXX")"
trap 'rm -rf -- "$T"' EXIT

fail() { printf 'FAIL %s\n' "$1" >&2; exit 1; }
ok() { printf '  ok   %s\n' "$1"; }

# Fake repository: the script resolves the repo from its own location.
mkdir -p "$T/repo/scripts" "$T/repo/service/sft" "$T/repo/service/.venv" "$T/repo/service/training"
cp "$ROOT/scripts/install-owner-reimagine-plugin.sh" "$T/repo/scripts/"
printf 'new server\n' > "$T/repo/service/server.py"
printf 'brand new\n' > "$T/repo/service/new_module.py"
printf '#!/bin/sh\n' > "$T/repo/service/run.sh"
printf '#!/bin/sh\n' > "$T/repo/service/run-reimagine.sh"
chmod 644 "$T/repo/service/run.sh" "$T/repo/service/run-reimagine.sh"
printf 'tracked sft code\n' > "$T/repo/service/sft/train.py"
printf 'venv\n' > "$T/repo/service/.venv/marker"
printf 'SECRET=1\n' > "$T/repo/service/.feature.env"
printf '{"repo": true}\n' > "$T/repo/service/training/training_state.json"

# Fake build output with a VST3 bundle.
B="$T/build/src/reimagine/plugin/MoshReImaginePlugin_artefacts/Debug/VST3/Mosh Re-Imagine.vst3"
mkdir -p "$B/Contents/MacOS"
printf 'binary\n' > "$B/Contents/MacOS/Mosh Re-Imagine"

# Existing helper with owner-only data.
H="$T/home/Library/Application Support/Mosh/ReImagine/service"
mkdir -p "$H/sft/.adapters/a1" "$H/sft/.sft-data" "$H/sft/.artifacts" "$H/training" "$H/.venv"
printf 'old server v0\n' > "$H/server.py"
printf 'adapter\n' > "$H/sft/.adapters/a1/weights.bin"
printf 'data\n' > "$H/sft/.sft-data/rows.jsonl"
printf 'artifact\n' > "$H/sft/.artifacts/x"
printf '{"owner": true}\n' > "$H/training/training_state.json"
printf 'owner venv\n' > "$H/.venv/marker"
printf 'old-only\n' > "$H/removed_from_git.py"

# codesign stub: the real one would need a valid bundle.
mkdir -p "$T/bin"
printf '#!/bin/sh\nexit 0\n' > "$T/bin/codesign"
chmod 755 "$T/bin/codesign"
# ditto is macOS-only; elsewhere a cp -R stand-in keeps the test portable.
if ! command -v ditto >/dev/null 2>&1; then
  printf '#!/bin/sh\nmkdir -p "$2" && cp -R "$1"/. "$2"/\n' > "$T/bin/ditto"
  chmod 755 "$T/bin/ditto"
fi

HOME="$T/home" PATH="$T/bin:$PATH" bash "$T/repo/scripts/install-owner-reimagine-plugin.sh" "$T/build" Debug >/dev/null

[[ -f "$T/home/Library/Audio/Plug-Ins/VST3/Mosh Re-Imagine.vst3/Contents/MacOS/Mosh Re-Imagine" ]] || fail "plug-in bundle installed"
ok "plug-in bundle installed"
[[ "$(cat "$H/server.py")" == "new server" ]] || fail "changed file updated"
ok "changed file updated"
[[ -f "$H/new_module.py" && -f "$H/sft/train.py" ]] || fail "new tracked files copied"
ok "new tracked files copied"
[[ -f "$H/sft/.adapters/a1/weights.bin" && -f "$H/sft/.sft-data/rows.jsonl" && -f "$H/sft/.artifacts/x" ]] || fail "owner SFT data kept"
ok "owner SFT data kept"
[[ "$(cat "$H/training/training_state.json")" == '{"owner": true}' ]] || fail "owner training state kept, not overwritten"
ok "owner training state kept, not overwritten"
[[ "$(cat "$H/.venv/marker")" == "owner venv" ]] || fail "helper venv untouched"
ok "helper venv untouched"
[[ ! -e "$H/.feature.env" ]] || fail "dotenv files not copied"
ok "dotenv files not copied"
[[ -f "$H/removed_from_git.py" ]] || fail "additive: files absent from git are left alone"
ok "additive: files absent from git are left alone"
[[ -x "$H/run.sh" && -x "$H/run-reimagine.sh" ]] || fail "run scripts executable"
ok "run scripts executable"
printf 'install-owner-reimagine-plugin: OK\n'
