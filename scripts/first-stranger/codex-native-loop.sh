#!/usr/bin/env bash
set -euo pipefail

SELF="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
exec "$SELF/codex-native/orchestrator.sh" "$@"
