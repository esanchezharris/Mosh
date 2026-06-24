#!/usr/bin/env bash
# merge-one.sh — the deterministic half of the serialized merge-queue. The LLM
# adversarial review happens in the Workflow BETWEEN `prepare` and `finalize`.
#
#   prepare  <slug> <pr> [base]   kill-switch → rebase onto origin/main → classify
#                                 (exclusion) → gate.sh. Emits a verdict JSON. Merges
#                                 NOTHING. ready:true ⇔ not excluded + clean rebase +
#                                 gate passed (and a human/agent review still required).
#   finalize <slug> <pr> <base_sha> [review_note]
#                                 re-check kill-switch + origin/main UNMOVED since
#                                 base_sha → gh pr merge --squash --admin → ledger →
#                                 remove worktree. Holds an flock so two finalizes can
#                                 never overlap.
#   reject   <slug> <pr> <sublabel> <reason>
#                                 leave PR open, label needs-human + <sublabel>, comment,
#                                 ledger a REJECTED entry. Never merges.
#
# All subcommands print a JSON result on stdout. Bash 3.2 compatible.
set -uo pipefail
SELF_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
. "$SELF_DIR/lib.sh"
set +e   # we record failures, never abort mid-sequence

MAIN="$(al_main_worktree)"; [ -n "$MAIN" ] || al_die "no main worktree"
LOCK="$AL_DOCS_DIR/.merge-queue.lock"; mkdir -p "$AL_DOCS_DIR"

slug_wt() { printf '%s/.claude/worktrees/auto-%s\n' "$MAIN" "$1"; }
branch_of() { printf 'claude/auto-%s\n' "$1"; }

ensure_label() { gh label create "$1" --color "${2:-EDEDED}" --force >/dev/null 2>&1 || true; }

# ── prepare ──────────────────────────────────────────────────────────────────────
cmd_prepare() {
  local slug="$1" pr="$2" base="${3:-origin/main}"
  local wt; wt="$(slug_wt "$slug")"

  if al_stop_requested; then jq -nc '{ready:false,phase:"prepare",reason:"STOP sentinel present"}'; return; fi
  [ -d "$wt" ] || { jq -nc --arg r "no worktree auto-$slug" '{ready:false,phase:"prepare",reason:$r}'; return; }

  git -C "$wt" fetch --quiet origin main || true
  local base_sha; base_sha="$(git -C "$wt" rev-parse origin/main)"

  # Rebase onto latest origin/main — no stale-green merges.
  if ! git -C "$wt" rebase origin/main >/dev/null 2>&1; then
    git -C "$wt" rebase --abort >/dev/null 2>&1 || true
    jq -nc --arg b "$base_sha" '{ready:false,phase:"prepare",reason:"rebase conflict",conflict:true,baseSha:$b}'
    return
  fi
  local head_sha; head_sha="$(git -C "$wt" rev-parse HEAD)"

  # Classify + exclusion (fail-closed). Non-empty diff required.
  local cj; cj="$("$SELF_DIR/classify.sh" origin/main "$wt")"
  local class excluded diff_empty
  class="$(echo "$cj" | jq -r .class)"
  excluded="$(echo "$cj" | jq -r .excluded)"
  diff_empty="$(echo "$cj" | jq -r .diff_empty)"

  if [ "$diff_empty" = true ]; then
    jq -nc --arg b "$base_sha" '{ready:false,phase:"prepare",reason:"empty diff vs main (already merged/subsumed)",baseSha:$b}'
    return
  fi
  if [ "$excluded" = true ]; then
    jq -nc --argjson c "$cj" --arg b "$base_sha" \
      '{ready:false,phase:"prepare",reason:"touches hard-exclusion list",excluded:true,classify:$c,baseSha:$b}'
    return
  fi

  # Push the rebased branch so the PR reflects exactly what we gate.
  git -C "$wt" push --force-with-lease >/dev/null 2>&1 || al_warn "push --force-with-lease failed for $(branch_of "$slug")"

  # THE GATE (authoritative: ×3 selftest + verify.py run here for native).
  local gate_json gate_rc
  gate_json="$("$SELF_DIR/gate.sh" "$class" "$wt" origin/main)"; gate_rc=$?
  local ready=false; [ "$gate_rc" -eq 0 ] && ready=true

  # One-line digest of the gate result for the ledger / reviewer.
  local gsum
  gsum="$(echo "$gate_json" | jq -r '"\(.class) pass=\(.pass) " + ([.steps[]?|"\(.name):\(if .ok then "ok" else "FAIL" end)"]|join(",")) + (if (.selftest|length)>0 then " selftest=\(.selftest)" else "" end)' 2>/dev/null)"

  # camelCase keys match the Workflow's PREPARE_SCHEMA + finalize arg (baseSha/headSha).
  jq -nc \
    --argjson ready "$ready" --arg class "$class" \
    --arg base "$base_sha" --arg head "$head_sha" \
    --arg gsum "$gsum" --argjson gate "$gate_json" \
    '{ready:$ready, phase:"prepare", class:$class, excluded:false,
      baseSha:$base, headSha:$head, gateSummary:$gsum, gate:$gate,
      reason: (if $ready then "gate green — awaiting adversarial review" else "gate failed" end)}'
}

# ── finalize ─────────────────────────────────────────────────────────────────────
cmd_finalize() {
  local slug="$1" pr="$2" base_sha="$3" note="${4:-}"
  local wt br; wt="$(slug_wt "$slug")"; br="$(branch_of "$slug")"

  # Single-flight: never let two finalizes overlap (backstop to the serial queue).
  exec 9>"$LOCK"
  if ! flock -n 9; then jq -nc '{merged:false,phase:"finalize",reason:"another finalize holds the lock"}'; return; fi

  if al_stop_requested; then jq -nc '{merged:false,phase:"finalize",reason:"STOP sentinel present — not merging"}'; return; fi

  git -C "$MAIN" fetch --quiet origin main || true
  local cur; cur="$(git -C "$MAIN" rev-parse origin/main)"
  if [ "$cur" != "$base_sha" ]; then
    jq -nc --arg c "$cur" --arg b "$base_sha" \
      '{merged:false,phase:"finalize",reason:"origin/main advanced since prepare — re-prepare required",current:$c,expected:$b}'
    return
  fi

  local mlog; mlog="$(mktemp)"
  gh pr ready "$pr" >/dev/null 2>&1 || true   # a draft PR can't be merged
  # NOT --delete-branch: the branch is checked out in a worktree, so gh's delete step
  # returns non-zero even though the MERGE succeeded (a false failure). We delete it
  # ourselves after removing the worktree, below.
  gh pr merge "$pr" --squash --admin >"$mlog" 2>&1
  local mrc=$?
  if [ "$mrc" -ne 0 ]; then
    jq -nc --arg log "$(LC_ALL=C tr -cd '[:print:] ' <"$mlog")" '{merged:false,phase:"finalize",reason:"gh pr merge failed",log:$log}'
    rm -f "$mlog"; return
  fi
  rm -f "$mlog"

  # Advance local main in the MAIN worktree.
  git -C "$MAIN" fetch --quiet origin main || true
  local merge_sha; merge_sha="$(git -C "$MAIN" rev-parse origin/main)"

  ledger_append "### $(al_now) — PR #$pr: $br  [MERGED ✅]
- **Branch:** $br → PR #$pr
- **Base:** origin/main @ ${base_sha:0:9} → squash-merged as ${merge_sha:0:9}
- **Review:** ${note:-APPROVE (adversarial self-review)}
- **Outcome:** auto-merged by the unattended loop; branch + worktree removed
"
  # Cleanup — PR is CONFIRMED merged, so force-remove regardless of squash ancestry
  # (rm-worktree.sh's is-ancestor guard would refuse, since a squash commit isn't an
  # ancestor of the branch tip).
  # Silence STDOUT too: `git branch -D` prints "Deleted branch …" to stdout, which would
  # pollute this function's JSON result (the Workflow's finalize agent parses it).
  git -C "$MAIN" worktree remove --force "$wt" >/dev/null 2>&1 || al_warn "worktree remove failed: auto-$slug"
  git -C "$MAIN" branch -D "$br" >/dev/null 2>&1 || true
  git -C "$MAIN" push origin --delete "$br" >/dev/null 2>&1 || true

  jq -nc --arg m "$merge_sha" '{merged:true,phase:"finalize",merge_sha:$m}'
}

# ── reject ───────────────────────────────────────────────────────────────────────
cmd_reject() {
  local slug="$1" pr="$2" sublabel="$3" reason="$4"
  local br; br="$(branch_of "$slug")"
  ensure_label "needs-human" "B60205"
  ensure_label "$sublabel" "FBCA04"
  gh pr edit "$pr" --add-label "needs-human" --add-label "$sublabel" >/dev/null 2>&1 || al_warn "label failed (pr #$pr)"
  gh pr comment "$pr" --body "Auto-loop held this PR for a human: **$sublabel**. $reason" >/dev/null 2>&1 || true

  ledger_append "### $(al_now) — PR #$pr: $br  [REJECTED ⛔ $sublabel]
- **Branch:** $br → PR #$pr
- **Reason:** $reason
- **Outcome:** left open, labels [needs-human, $sublabel] — no merge
"
  jq -nc --arg s "$sublabel" --arg r "$reason" '{rejected:true,sublabel:$s,reason:$r}'
}

SUB="${1:?usage: merge-one.sh <prepare|finalize|reject> ...}"; shift
case "$SUB" in
  prepare)  cmd_prepare  "$@" ;;
  finalize) cmd_finalize "$@" ;;
  reject)   cmd_reject   "$@" ;;
  *) al_die "unknown subcommand: $SUB" ;;
esac
