#!/usr/bin/env bash
# discover.sh — backlog manager for the auto-loop. The LLM bug-hunt (finders +
# adversarial verify) runs in the Workflow; this script is the deterministic store:
# it reads/writes docs/auto-loop/backlog.jsonl (the machine source of truth — one
# JSON item per line). docs/auto-loop/BACKLOG.md is the human-readable companion.
#
#   discover.sh list [status]        emit a JSON array of items (optionally filtered)
#   discover.sh ready                emit only status:ready items, sorted by `order`
#   discover.sh count-ready          print the number of ready items
#   discover.sh next-id              print the next free AL-### id
#   discover.sh add '<json>'         append an item (auto-fills id/status/order if absent)
#   discover.sh set-status <id> <s>  update one item's status in place
#   discover.sh get <id>             emit one item
#
# Item schema: {id,title,class(cheap|native),size,status,order,files[],acceptance,skills[],notes}
# Bash 3.2 compatible.
set -uo pipefail
SELF_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
. "$SELF_DIR/lib.sh"
set +e

BL="$AL_DOCS_DIR/backlog.jsonl"
mkdir -p "$AL_DOCS_DIR"; [ -f "$BL" ] || : > "$BL"

# Strip blank lines, parse each as JSON, collect into an array.
_all() { grep -v '^[[:space:]]*$' "$BL" 2>/dev/null | jq -sc '.'; }

cmd_list() {
  local status="${1:-}"
  if [ -n "$status" ]; then _all | jq -c --arg s "$status" 'map(select(.status==$s))';
  else _all; fi
}

# IDs of items that already have a MERGED PR (title "auto(AL-XXX): …"). This is the
# DURABLE done-record — GitHub is the source of truth, so a fresh-worktree restart
# never re-picks an already-merged item even if its local backlog status wasn't flipped.
# Empty (no exclusions) if gh is unavailable/offline — the local `status` field still guards.
_merged_ids() {
  gh pr list --state merged --limit 300 --json title -q '.[].title' 2>/dev/null \
    | grep -oE 'auto\(AL-[0-9]+\)' | grep -oE 'AL-[0-9]+' | sort -u
}
cmd_ready() {
  local done; done="$(_merged_ids)"
  _all | jq -c --arg done "$done" '
    ($done | split("\n") | map(select(length>0))) as $d
    | map(select(.status=="ready" and ((.id) as $i | ($d | index($i)) | not)))
    | sort_by(.order)'
}
cmd_count_ready() { cmd_ready | jq 'length'; }

cmd_next_id() {
  local n; n="$(_all | jq -r '[.[].id | capture("AL-(?<n>[0-9]+)").n | tonumber] | (max // -1) + 1')"
  printf 'AL-%03d\n' "$n"
}

cmd_add() {
  local obj="$1"
  echo "$obj" | jq -e . >/dev/null 2>&1 || al_die "discover add: argument is not valid JSON"
  local id; id="$(echo "$obj" | jq -r '.id // empty')"
  [ -z "$id" ] && id="$(cmd_next_id)"
  # Default order = 1000 + numeric id, so auto-discovered items always sort AFTER the
  # curated seed (which uses small explicit orders like 5/10/20).
  local idnum; idnum="$(printf '%s' "$id" | sed -E 's/[^0-9]//g; s/^0+//')"; : "${idnum:=0}"
  local dflt_order=$((1000 + idnum))
  echo "$obj" | jq -c \
    --arg id "$id" --argjson dord "$dflt_order" \
    '. + {id:$id, status:(.status // "ready"), order:(.order // $dord)}' >> "$BL"
  printf '%s\n' "$id"
}

cmd_set_status() {
  local id="$1" status="$2" tmp; tmp="$(mktemp)"
  local found=0
  while IFS= read -r line; do
    [ -z "$line" ] && continue
    if [ "$(echo "$line" | jq -r '.id')" = "$id" ]; then
      echo "$line" | jq -c --arg s "$status" '.status=$s' >> "$tmp"; found=1
    else printf '%s\n' "$line" >> "$tmp"; fi
  done < "$BL"
  mv "$tmp" "$BL"
  [ "$found" = 1 ] || { al_warn "set-status: no item $id"; return 1; }
  al_log "set $id status=$status"
}

cmd_get() { _all | jq -c --arg id "$1" '.[] | select(.id==$id)'; }

SUB="${1:?usage: discover.sh <list|ready|count-ready|next-id|add|set-status|get> ...}"; shift
case "$SUB" in
  list)        cmd_list "$@" ;;
  ready)       cmd_ready ;;
  count-ready) cmd_count_ready ;;
  next-id)     cmd_next_id ;;
  add)         cmd_add "$@" ;;
  set-status)  cmd_set_status "$@" ;;
  get)         cmd_get "$@" ;;
  *) al_die "unknown subcommand: $SUB" ;;
esac
