#!/usr/bin/env bash
# Live-harvest watcher — tails the GUI session's MoshOps log and appends completed
# agent turns (batch_begin{turn_id}…batch_end) to tuples.jsonl as training tuples.
#
#   ./scripts/harvest-watch.sh          # watch ~/Library/Mosh/session/mosh-log.jsonl
#   ./scripts/harvest-watch.sh <log>    # watch a specific session log
#
# Run it in a spare terminal while producing; Ctrl-C to stop. Zero app changes —
# the native app already writes the log; this is a pure Node sidecar.
#
# NOTE (2026-07-01 audit finding): organic tuples' commands/utterance/appliedClean/
# taste labels are trustworthy, but their mock-reconstructed snapshots are NOT when
# commands reference engine-assigned ids (native ids ≠ mock ids ⇒ replayClean:false
# + divergent snapshotAfter). Treat snapshots from THIS path as advisory until the
# log carries result ids. Factory tuples (npm run turn-factory) carry real snapshots.
set -euo pipefail
cd "$(dirname "$0")/../ui"
exec npx tsx src/harvest/cli.ts harvest "${1:-$HOME/Library/Mosh/session/mosh-log.jsonl}" --watch
