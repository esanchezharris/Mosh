#!/usr/bin/env bash
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
MANIFEST="${1:-$REPO/docs/consolidation/2026-06-08-preservation-manifest.tsv}"

if [[ ! -f "$MANIFEST" ]]; then
  echo "missing manifest: $MANIFEST" >&2
  exit 2
fi

awk 'NR > 1 { print }' "$MANIFEST" | while IFS=$'\t' read -r source destination size sha256 reason; do
  [[ -z "${destination:-}" ]] && continue
  if [[ ! -f "$destination" ]]; then
    echo "FAIL missing preserved file: $destination" >&2
    exit 1
  fi
  actual_size="$(stat -f '%z' "$destination")"
  if [[ "$actual_size" != "$size" ]]; then
    echo "FAIL size mismatch: $destination expected=$size actual=$actual_size" >&2
    exit 1
  fi
  actual_sha="$(shasum -a 256 "$destination" | awk '{print $1}')"
  if [[ "$actual_sha" != "$sha256" ]]; then
    echo "FAIL sha256 mismatch: $destination" >&2
    exit 1
  fi
done

echo "PASS: preservation manifest verified: $MANIFEST"
