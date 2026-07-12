#!/usr/bin/env bash
set -euo pipefail
SELF="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=policy.sh
. "$SELF/policy.sh"
if [ "$#" -gt 0 ]; then
  cn_route_paths "$@"
else
  paths=()
  while IFS= read -r path; do [ -n "$path" ] && paths+=("$path"); done
  cn_route_paths ${paths[@]+"${paths[@]}"}
fi
