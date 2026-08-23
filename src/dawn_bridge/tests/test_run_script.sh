#!/usr/bin/env bash
set -euo pipefail

SCRIPT="$1"
bash -n "$SCRIPT"
! grep -Eq '(^|[[:space:]])pkill([[:space:]]|$)' "$SCRIPT"
! grep -Eq 'rm[[:space:]].*DESCRIPTOR' "$SCRIPT"
grep -Fq 'kill -TERM "$APP_PID"' "$SCRIPT"
grep -Fq 'kill -0 "$APP_PID"' "$SCRIPT"
grep -Fq 'MoshDawnBridge already active' "$SCRIPT"
grep -Fq 'mktemp -d' "$SCRIPT"
grep -Fq 'MOSH_DAWN_DESCRIPTOR="$DESCRIPTOR" "$BINARY"' "$SCRIPT"
grep -Fq 'APP_PID=$!' "$SCRIPT"
